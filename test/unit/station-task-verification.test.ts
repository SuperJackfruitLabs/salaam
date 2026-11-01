import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TaskDriver } from '../../src/tasks/driver.js';
import { TaskCritic } from '../../src/tasks/critic.js';
import type { Supervisor } from '../../src/runtime/supervisor.js';
import type { ChildWork } from '../../src/workers/children.js';
import { createHash, randomUUID } from 'node:crypto';
import { AgentPodWork } from '../../src/agentpod/work.js';
import type { AgentPodAuthority } from '../../src/agentpod/authority.js';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/tasks/context.js';
import { TaskWork } from '../../src/tasks/work.js';
import { TaskBudget } from '../../src/tasks/budget.js';
import { TaskVerification } from '../../src/tasks/verification.js';
import { CodingWork } from '../../src/coding/coding.js';
import { Workspaces } from '../../src/workers/workspaces.js';
import { StationWork, type StationCall } from '../../src/agentpod/station-work.js';
import { StationTaskVerification } from '../../src/agentpod/station-task-verification.js';
import { ServiceError, canonical, digest } from '../../src/core/protocol.js';

// Synthetic station boundary double: these tests prove receipt joining and
// transactional revalidation, never Linux/systemd execution or a live canary.
function fixture(keys = ['tests'], gate?: Record<string, unknown>) {
  const dir = mkdtempSync('/tmp/sal-station-task-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const tasks = new TaskWork(store, new TaskContext(store, artifacts));
  const session = store.create(dir, 'create');
  const attemptID = store.accept(
    session.id,
    'attempt',
    store.session(session.id).revision,
    'fixture',
  ).attempt_id;
  store.db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(attemptID);
  store.db.prepare("UPDATE submissions SET state='completed' WHERE session_id=?").run(session.id);
  const task = store.transaction(() =>
    tasks.createInTransaction(
      session.id,
      'task',
      0,
      {
        objective: 'Check fixture',
        constraints: [],
        steps: [
          { key: 'check', title: 'Check', instruction: 'Check', depends_on: [], checks: keys },
        ],
        acceptance: keys.map((key) => ({
          key,
          command: key === 'tests' ? 'npm test' : 'node fixture',
          cwd: '.',
        })),
        deliverables: ['app.js'],
        ...(gate ? { completion_gate: gate } : {}),
      },
      () => {},
    ),
  );
  const workspaces = new Workspaces(store, artifacts, join(dir, 'owned'));
  const coding = new CodingWork(store, workspaces, artifacts, undefined, () => {});
  const verification = new TaskVerification(
    store,
    tasks,
    new TaskBudget(store, tasks),
    workspaces,
    coding,
    artifacts,
  );
  const check = randomUUID(),
    call = 'check-call',
    tree = 'a'.repeat(64);
  store.db
    .prepare("INSERT INTO task_checks VALUES (?,?,?,?,?,?,?,?,?,?,NULL,'accepted',NULL)")
    .run(
      check,
      task.id,
      null,
      'tests',
      task.plan_revision,
      'unused',
      1,
      'unused',
      'unused',
      'unused',
    );
  const args = { action: 'check', command: 'npm test', expected_tree: tree };
  const config = { workspace_identity: 'd'.repeat(64) };
  const binding = {
    version: 1 as const,
    root_digest: 'b'.repeat(64),
    configuration_digest: digest(config),
    runner: 'linux-systemd-station-v1' as const,
    network: 'none' as const,
    command_workspace: 'read-only-reviewed-snapshot' as const,
  };
  // A durable native call references an actual attempt; its synthetic terminal
  // row has no provider request or command process.
  store.db
    .prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES(?,?,?,?,?,'check',?,?,?,?,'prepared')",
    )
    .run(
      call,
      session.id,
      0,
      attemptID,
      'tool',
      digest(args),
      binding.root_digest,
      binding.configuration_digest,
      canonical(args),
    );
  let allowed = true,
    observed = tree,
    afterObserve = () => {};
  const guard = () => {
    if (!allowed) throw Error('authority revoked or expired');
  };
  const station = {
    authority: { bySession: () => {} },
    config,
    ready: () => {
      guard();
      return binding;
    },
    assertBinding: (_session: string, b: unknown) => {
      guard();
      expect(b).toEqual(binding);
    },
    assertVerificationSettled: guard,
    get: (id: string) =>
      store.db.prepare('SELECT * FROM station_calls WHERE id=?').get(id) as unknown as StationCall,
    verificationTree: async (_call: string, validate: () => void) => {
      validate();
      await Promise.resolve();
      afterObserve();
      return { tree_digest: observed, root_identity: 'd'.repeat(64) };
    },
  } as unknown as StationWork;
  const adapter = new StationTaskVerification(store, tasks, verification, station, artifacts);
  const returned = () => {
    const cleanup = { version: 1, method: 'synthetic_stopped' },
      result = {
        exit_code: 0,
        verified_check: true,
        expected_tree: tree,
        observed_tree: tree,
        network: 'none',
        workspace: 'read-only-reviewed-snapshot',
        cleanup,
      };
    store.db
      .prepare("UPDATE station_calls SET state='returned',result_json=? WHERE id=?")
      .run(canonical(result), call);
    store.db.prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      'unit',
      session.id,
      call,
      digest({
        id: call,
        root: binding.root_digest,
        configuration: binding.configuration_digest,
        input: digest(args),
      }),
      canonical(config),
      'unused',
      'unused',
      '{"invocation":"synthetic"}',
      'stopped',
      canonical(cleanup),
    );
  };
  return {
    dir,
    station,
    store,
    tasks,
    task,
    session,
    check,
    call,
    adapter,
    verification,
    returned,
    revoke: () => {
      allowed = false;
    },
    changeTree: () => {
      observed = 'e'.repeat(64);
    },
    after: (fn: () => void) => {
      afterObserve = fn;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('station backend binds before dispatch, persists original binding and commits fresh evidence without coding executor', async () => {
  const f = fixture();
  try {
    const binding = f.adapter.bind(f.check, f.call);
    expect(f.adapter.bind(f.check, f.call)).toBe(binding);
    f.returned();
    const evidence = await f.adapter.withFresh(f.check, (e) => {
      expect(f.store.db.isTransaction).toBe(true);
      return e;
    });
    expect(evidence).toMatchObject({
      binding_artifact: binding,
      check_id: f.check,
      call_id: f.call,
      backend: 'linux-systemd-station-v1',
    });
    expect(f.tasks.get(f.task.id).state).toBe('accepted');
  } finally {
    f.close();
  }
});
test('a returned native check cannot be retrospectively attached to a task plan', () => {
  const f = fixture();
  try {
    f.returned();
    expect(() => f.adapter.bind(f.check, f.call)).toThrow();
  } finally {
    f.close();
  }
});
test.each([
  'tree',
  'lease',
  'revision',
  'plan',
  'unknown',
  'resource',
  'result',
  'command',
  'root',
  'unit',
  'cleanup',
  'step',
])('fresh station evidence rejects %s changes during observation', async (kind) => {
  const f = fixture();
  try {
    f.adapter.bind(f.check, f.call);
    f.returned();
    f.after(() => {
      if (kind === 'tree') f.changeTree();
      if (kind === 'lease') f.revoke();
      if (kind === 'revision')
        f.store.db
          .prepare('UPDATE durable_tasks SET revision=revision+1 WHERE id=?')
          .run(f.task.id);
      if (kind === 'plan')
        f.store.db
          .prepare('UPDATE durable_tasks SET plan_revision=plan_revision+1 WHERE id=?')
          .run(f.task.id);
      if (kind === 'unknown')
        f.store.db
          .prepare("UPDATE station_calls SET state='outcome_unknown' WHERE id=?")
          .run(f.call);
      if (kind === 'resource')
        f.store.db.prepare("UPDATE station_units SET state='unconfirmed'").run();
      if (kind === 'result')
        f.store.db.prepare("UPDATE station_calls SET result_json='{}' WHERE id=?").run(f.call);
      if (kind === 'command')
        f.store.db.prepare("UPDATE station_calls SET args_json='{}' WHERE id=?").run(f.call);
      if (kind === 'root')
        f.store.db.prepare("UPDATE station_calls SET root_digest='wrong' WHERE id=?").run(f.call);
      if (kind === 'unit') f.store.db.prepare('DELETE FROM station_units').run();
      if (kind === 'step')
        f.store.db
          .prepare('UPDATE task_checks SET step_id=? WHERE id=?')
          .run(f.task.steps[0]!.id, f.check);
      if (kind === 'cleanup') f.store.db.prepare("UPDATE station_units SET stop_json='{}'").run();
    });
    let consumed = false;
    await expect(
      f.adapter.withFresh(f.check, () => {
        consumed = true;
      }),
    ).rejects.toThrow();
    expect(consumed).toBe(false);
  } finally {
    f.close();
  }
});
test('async consumers are rejected and synchronous writes roll back', async () => {
  const f = fixture();
  try {
    f.adapter.bind(f.check, f.call);
    f.returned();
    await expect(
      f.adapter.withFresh(f.check, () => {
        f.store.db
          .prepare("UPDATE durable_tasks SET reason='must roll back' WHERE id=?")
          .run(f.task.id);
        return Promise.resolve();
      }),
    ).rejects.toThrow('synchronously');
    expect(f.tasks.get(f.task.id).reason).not.toBe('must roll back');
  } finally {
    f.close();
  }
});

test('an exclusion intended for the verifier read cannot hide a prepared check or unknown mutation', () => {
  const f = fixture();
  try {
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id), f.call)).toThrow('uncertain');
    f.store.db
      .prepare("UPDATE station_calls SET state='outcome_unknown',kind='patch' WHERE id=?")
      .run(f.call);
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id), f.call)).toThrow('uncertain');
  } finally {
    f.close();
  }
});
test('saved successful evidence must be re-observed on every consumption', async () => {
  const f = fixture();
  try {
    f.adapter.bind(f.check, f.call);
    f.returned();
    await f.adapter.withFresh(f.check, () => undefined);
    f.changeTree();
    await expect(f.adapter.withFresh(f.check, () => undefined)).rejects.toThrow();
  } finally {
    f.close();
  }
});

test.each([false, true])(
  'native verification inspection owns its helper and preserves cancellation=%s',
  async (cancel) => {
    const f = fixture();
    try {
      // Actual child process ownership, synthetic file receipt: this does not prove
      // systemd isolation or the production filesystem primitive.
      const path = join(f.dir, 'synthetic-file-helper');
      writeFileSync(
        path,
        `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);setTimeout(()=>console.log(JSON.stringify({version:1,ok:true,tree_digest:'${'a'.repeat(64)}',root_identity:r.root_identity,files:1})),25);});\n`,
        { mode: 0o700 },
      );
      Object.setPrototypeOf(f.station, StationWork.prototype);
      Object.assign(f.station, {
        store: f.store,
        files: new Map(),
        closing: false,
        config: { workspace_identity: 'd'.repeat(64), workspace: f.dir, files: { path } },
        options: {
          assertActive: () => {
            throw Error('must not borrow model authority');
          },
        },
      });
      // Keep the synthetic config/boundary double; use the real helper and durable
      // resource implementation, including post-I/O guard and process-group exit.
      delete (f.station as unknown as Record<string, unknown>).verificationTree;
      delete (f.station as unknown as Record<string, unknown>).assertVerificationSettled;
      if (cancel) {
        const observe = f.station.verificationTree.bind(f.station);
        let scheduled = false;
        f.station.verificationTree = (source, validate) =>
          observe(source, (id) => {
            validate(id);
            const row = f.store.db
              .prepare('SELECT helper_state FROM station_calls WHERE id=?')
              .get(id);
            if (!scheduled && ['launching', 'running'].includes(String(row?.helper_state))) {
              scheduled = true;
              setTimeout(
                () =>
                  f.store.db
                    .prepare("UPDATE station_calls SET state='cancelled' WHERE id=?")
                    .run(id),
                5,
              );
            }
          });
      }
      f.adapter.bind(f.check, f.call);
      f.returned();
      if (cancel) await expect(f.adapter.withFresh(f.check, () => undefined)).rejects.toThrow();
      else await f.adapter.withFresh(f.check, () => undefined);
      const read = f.store.db.prepare("SELECT * FROM station_calls WHERE kind='read'").get();
      expect(read).toMatchObject({
        state: cancel ? 'cancelled' : 'returned',
        helper_state: 'stopped',
      });
      expect(Number(read!.helper_pid)).toBeGreaterThan(0);
      expect(JSON.parse(String(read!.helper_stop_json))).toMatchObject({
        method: 'observed_exit',
        scope: 'local_process_group',
      });
    } finally {
      f.close();
    }
  },
);

test('check binding survives journal reopen but cannot reuse a pre-restart freshness decision', async () => {
  const f = fixture();
  let reopened: Store | undefined;
  try {
    const binding = f.adapter.bind(f.check, f.call);
    f.returned();
    await f.adapter.withFresh(f.check, () => undefined);
    f.store.close();
    reopened = new Store(join(f.dir, 'journal.sqlite'));
    const artifacts = new Artifacts(join(f.dir, 'artifacts'), reopened);
    const tasks = new TaskWork(reopened, new TaskContext(reopened, artifacts));
    const spaces = new Workspaces(reopened, artifacts, join(f.dir, 'owned'));
    const coding = new CodingWork(reopened, spaces, artifacts, undefined, () => {});
    const verification = new TaskVerification(
      reopened,
      tasks,
      new TaskBudget(reopened, tasks),
      spaces,
      coding,
      artifacts,
    );
    const journal = reopened;
    Object.assign(f.station, {
      get: (id: string) => journal.db.prepare('SELECT * FROM station_calls WHERE id=?').get(id),
    });
    const adapter = new StationTaskVerification(
      reopened,
      tasks,
      verification,
      f.station,
      artifacts,
    );
    expect(adapter.bind(f.check, f.call)).toBe(binding);
    await adapter.withFresh(f.check, () => undefined);
    f.changeTree();
    await expect(adapter.withFresh(f.check, () => undefined)).rejects.toThrow();
  } finally {
    if (reopened) {
      reopened.close();
      rmSync(f.dir, { recursive: true, force: true });
    } else f.close();
  }
});

test.each([false, true, 'hook' as const, 'critic' as const])(
  'installed controller enforces native evidence and missing deliverable=%s (synthetic station)',
  async (missing) => {
    // Item 8: with a completion hook, the hook is a required completion check of its own.
    const f =
      missing === 'critic'
        ? fixture(['tests'], { critic: { rubric: 'Cite RFC 9110.' }, hooks: [] })
        : missing === 'hook'
          ? fixture(['tests'], {
              critic: null,
              hooks: [{ key: 'lint', command: 'node lint', cwd: '.' }],
            })
          : fixture();
    try {
      // This is the real task controller and SQLite ledger with a synthetic native
      // runner. Actual systemd/primitive acceptance remains a separate Linux proof.
      f.store.db.prepare('DELETE FROM station_calls WHERE id=?').run(f.call);
      f.store.db.prepare('DELETE FROM task_checks WHERE id=?').run(f.check);
      f.verification.station = f.adapter;
      const config = { workspace_identity: 'd'.repeat(64) };
      Object.assign(f.station, {
        store: f.store,
        prepareTaskCheck: StationWork.prototype.prepareTaskCheck,
        run: (id: string) => {
          const call = f.station.get(id);
          f.station.taskCheckGuard!(call);
          const cleanup = { version: 1, method: 'synthetic_stopped' };
          const args = JSON.parse(call.args_json);
          f.store.db
            .prepare("UPDATE station_calls SET state='returned',result_json=? WHERE id=?")
            .run(
              canonical({
                exit_code: 0,
                verified_check: true,
                expected_tree: args.expected_tree,
                observed_tree: args.expected_tree,
                network: 'none',
                workspace: 'read-only-reviewed-snapshot',
                cleanup,
              }),
              id,
            );
          f.store.db.prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            'unit:' + id,
            f.session.id,
            id,
            digest({
              id,
              root: call.root_digest,
              configuration: call.configuration_digest,
              input: call.input_digest,
            }),
            canonical(config),
            'unused',
            'unused',
            '{"invocation":"synthetic"}',
            'stopped',
            canonical(cleanup),
          );
        },
      });
      const observe = f.station.verificationTree;
      f.station.verificationTree = async (source, validate, request) => {
        const result = await observe(source, validate);
        if (missing === true && request?.action === 'read') throw Error('deliverable missing');
        return request?.action === 'read'
          ? {
              ...result,
              path: request.path,
              content: 'fixture',
              sha256: createHash('sha256').update('fixture').digest('hex'),
            }
          : result;
      };
      const task = f.tasks.get(f.task.id);
      const receipt = f.verification.start(
        task.id,
        'tests',
        null,
        'verify-request',
        task.revision,
        () => {},
      );
      await f.adapter.drain();
      await f.verification.reconcileAsync();
      const checked = f.verification.get(receipt.id);
      expect(
        checked.state,
        checked.artifact_id
          ? readFileSync(join(f.dir, 'artifacts', checked.artifact_id), 'utf8')
          : 'no artifact',
      ).toBe('passed');
      const native = f.store.db
        .prepare('SELECT * FROM station_calls WHERE task_check_id=?')
        .get(receipt.id);
      expect(native).toMatchObject({
        attempt_id: null,
        task_check_id: receipt.id,
        kind: 'check',
        state: 'returned',
      });
      expect(
        f.verification.start(task.id, 'tests', null, 'verify-request', task.revision, () => {
          throw Error('must replay');
        }).id,
      ).toBe(receipt.id);
      expect(
        f.store.db
          .prepare('SELECT verification_runs FROM task_runtime WHERE task_id=?')
          .get(task.id)!.verification_runs,
      ).toBe(1);
      f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE task_id=?").run(task.id);
      const expected = f.tasks.get(task.id).revision;
      if (missing === 'critic') {
        // Operator ruling 2026-10-30 (option A; staging card_019a647a169744ff): a running
        // review's read-only child does not make the task busy for verification reads, so the
        // owner's status poll and the driver can re-check freshness while the critic works.
        // Any other live work, or a review child holding a writing tool, still does.
        new TaskCritic(f.store, f.verification.artifacts, {} as never);
        const live = f.tasks.get(task.id);
        const checked = f.verification.latest(live, 'tests', null)!;
        const childSession = f.store.create(f.dir, 'critic-child').id;
        const childAttempt = f.store.accept(
          childSession,
          'critic',
          f.store.session(childSession).revision,
          'review',
        ).attempt_id;
        f.store.db
          .prepare(
            "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES ('review-child',?,?,'critic-1-1','d',?,?,?,4,'accepted')",
          )
          .run(
            f.session.id,
            f.store.db
              .prepare('SELECT id FROM attempts WHERE session_id=? LIMIT 1')
              .get(f.session.id)!.id as string,
            childSession,
            childAttempt,
            JSON.stringify(['salaam_findings', 'salaam_probe', 'salaam_repository']),
          );
        f.store.db
          .prepare(
            "INSERT INTO task_critics VALUES ('review-row',?,?,'e',1,'review-child','running',NULL,NULL)",
          )
          .run(task.id, live.plan_revision);
        expect(await f.verification.freshAsync(checked)).toBe(true);
        // A review child that could write is not exempt.
        f.store.db
          .prepare("UPDATE child_tasks SET authority=? WHERE id='review-child'")
          .run(JSON.stringify(['salaam_command', 'salaam_findings', 'salaam_probe']));
        expect(await f.verification.freshAsync(checked)).toBe(false);
        f.store.db
          .prepare("UPDATE child_tasks SET authority=? WHERE id='review-child'")
          .run(JSON.stringify(['salaam_findings', 'salaam_probe', 'salaam_repository']));
        // A live child that is not a running review is not exempt.
        f.store.db.prepare("UPDATE task_critics SET state='pass' WHERE id='review-row'").run();
        expect(await f.verification.freshAsync(checked)).toBe(false);
        f.store.db.prepare("UPDATE task_critics SET state='running' WHERE id='review-row'").run();
        // A live step attempt beside the review still makes the task busy.
        const step = 'step-live';
        f.store.db
          .prepare(
            "INSERT INTO submissions(id,session_id,text,attempt_id) VALUES ('sub-live',?,'step',?)",
          )
          .run(f.session.id, step);
        f.store.db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,'sub-live','running')",
          )
          .run(step, f.session.id);
        expect(await f.verification.freshAsync(checked)).toBe(false);
        f.store.db
          .prepare("UPDATE attempts SET state='completed' WHERE id IN (?,?)")
          .run(step, childAttempt);
        f.store.db
          .prepare("UPDATE child_tasks SET state='completed' WHERE id='review-child'")
          .run();
        f.store.db.prepare("DELETE FROM task_critics WHERE id='review-row'").run();
        // Item 8: without a passing critic verdict on this exact evidence, nothing completes.
        const seen: { evidence: string; deliverables: unknown }[] = [];
        let passed = false;
        f.verification.critic = {
          gate: async (_t: unknown, evidence: string, deliverables: unknown) => {
            seen.push({ evidence, deliverables });
            return { state: 'pending' };
          },
          passed: (_t: unknown, evidence: string) => passed && evidence === seen[0]?.evidence,
        } as never;
        expect(await f.verification.criticGateAsync(f.tasks.get(task.id))).toEqual({
          state: 'pending',
        });
        expect(seen[0]!.deliverables).toEqual([{ path: 'app.js', content: 'fixture' }]);
        await expect(
          f.verification.finishAsync(task.id, 'finish-request', expected, null, () => {}),
        ).rejects.toThrow('Critic review required');
        passed = true;
        const done = await f.verification.finishAsync(
          task.id,
          'finish-request-2',
          f.tasks.get(task.id).revision,
          null,
          () => {},
        );
        expect(done.state).toBe('succeeded');
        return;
      }
      if (missing === 'hook') {
        await expect(
          f.verification.finishAsync(task.id, 'finish-request', expected, null, () => {}),
        ).rejects.toThrow('Passed configured checks required');
        f.verification.start(
          task.id,
          'hook-lint',
          null,
          'hook-request',
          f.tasks.get(task.id).revision,
          () => {},
        );
        await f.adapter.drain();
        await f.verification.reconcileAsync();
        const done = await f.verification.finishAsync(
          task.id,
          'finish-request-2',
          f.tasks.get(task.id).revision,
          null,
          () => {},
        );
        expect(done.state).toBe('succeeded');
        return;
      }
      if (missing) {
        await expect(
          f.verification.finishAsync(task.id, 'finish-request', expected, null, () => {}),
        ).rejects.toThrow('deliverable missing');
        expect(f.tasks.get(task.id).state).not.toBe('succeeded');
        expect(
          f.store.db.prepare('SELECT 1 FROM task_completions WHERE task_id=?').get(task.id),
        ).toBeUndefined();
        return;
      }
      const completed = await f.verification.finishAsync(
        task.id,
        'finish-request',
        expected,
        null,
        () => {},
      );
      expect(completed.state).toBe('succeeded');
      // Each deliverable keeps the exact verified bytes as a session artifact, so it can be
      // published from the verified revision rather than re-read from a changing workspace.
      const record = JSON.parse(
        f.verification.artifacts.read(
          String(
            f.store.db
              .prepare('SELECT artifact_id FROM task_completions WHERE task_id=?')
              .get(task.id)!.artifact_id,
          ),
        ),
      );
      expect(record.deliverables.length).toBe(completed.deliverables.length);
      for (const d of record.deliverables) {
        const bytes = f.verification.artifacts.read(d.artifact_id);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(d.sha256);
        expect(
          f.store.db.prepare('SELECT session_id FROM artifacts WHERE id=?').get(d.artifact_id)!
            .session_id,
        ).toBe(task.session_id);
        expect(Object.keys(d).sort()).toEqual(['artifact_id', 'path', 'sha256']);
      }
      expect(await f.verification.viewAsync(completed)).toMatchObject({
        completion: { fresh: true, state: 'succeeded' },
      });
      const admission = JSON.parse(
        readFileSync(new URL('../fixtures/agentpod-work-v1.json', import.meta.url), 'utf8'),
      ).admissions[0].value;
      admission.work.plan_digest = digest({
        objective: completed.objective,
        constraints: completed.constraints,
        acceptance: completed.acceptance,
        deliverables: completed.deliverables,
        limits: completed.limits,
        steps: completed.steps.map(({ key, title, instruction, depends_on, checks }) => ({
          key,
          title,
          instruction,
          depends_on,
          checks,
        })),
      });
      f.store.db
        .prepare('INSERT INTO agentpod_work VALUES (?,?,?,?,?,?)')
        .run(
          'synthetic-run',
          f.session.id,
          task.id,
          admission.request_id,
          canonical(admission),
          '{}',
        );
      const work = new AgentPodWork(
        f.store,
        {
          inspect: () => ({ session_id: f.session.id, binding: admission.binding }),
        } as unknown as AgentPodAuthority,
        f.tasks,
        f.verification,
      );
      const outcome = await work.completion(admission.binding);
      expect(outcome).toMatchObject({
        state: 'verified',
        task_id: task.id,
        work_request_id: admission.request_id,
        plan_revision: task.plan_revision,
      });
      expect(await work.completion(admission.binding)).toEqual(outcome);
      f.changeTree();
      await expect(work.completion(admission.binding)).rejects.toThrow('Fresh unchanged');
      expect(await f.verification.viewAsync(completed)).toMatchObject({
        completion: { fresh: false },
      });
      f.revoke();
      // Immutable original completion receipt recovery grants no new check.
      await expect(
        f.verification.finishAsync(task.id, 'finish-request', expected, null, () => {
          throw Error('must replay');
        }),
      ).resolves.toMatchObject({ state: 'succeeded' });
    } finally {
      f.close();
    }
  },
);

test('station ownership migration preserves historical calls and refuses forged model/task dual authority', () => {
  const f = fixture();
  try {
    expect(f.store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(30);
    expect(f.station.get(f.call).attempt_id).not.toBeNull();
    expect(() =>
      f.store.db
        .prepare('UPDATE station_calls SET task_check_id=? WHERE id=?')
        .run(f.check, f.call),
    ).toThrow();
    expect(() =>
      f.store.db.prepare('UPDATE station_calls SET attempt_id=NULL WHERE id=?').run(f.call),
    ).toThrow();
    expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(f.store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
  } finally {
    f.close();
  }
});

test('partial station ownership upgrade rolls back and restores foreign-key enforcement', () => {
  const dir = mkdtempSync('/tmp/sal-task-schema-'),
    store = new Store(join(dir, 'journal.sqlite'));
  try {
    const before = store.db.prepare('PRAGMA user_version').get()!.user_version;
    store.db.exec('CREATE TABLE station_calls_next(unrelated TEXT)');
    expect(() => store.enableStationTaskChecks()).toThrow();
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(before);
    expect(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM station_calls').get()!.n).toBe(0);
    store.db.exec('DROP TABLE station_calls_next');
    store.enableStationTaskChecks();
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(30);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('owned gated verification reads defer synchronous admission and serialize fresh consumers', async () => {
  const f = fixture();
  let release = () => {};
  let closeWatcher = () => {};
  const pending: Promise<unknown>[] = [];
  try {
    const helper = join(f.dir, 'gated-file-helper');
    const ready = join(f.dir, 'ready');
    const gate = join(f.dir, 'release');
    writeFileSync(
      helper,
      `#!${process.execPath}
const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);const done=()=>console.log(JSON.stringify({version:1,ok:true,tree_digest:'${'a'.repeat(64)}',root_identity:r.root_identity,files:1}));if(fs.existsSync(${JSON.stringify(gate)}))return done();const w=fs.watch(${JSON.stringify(f.dir)},(_,name)=>{if(name==='release'){w.close();done();}});fs.writeFileSync(${JSON.stringify(ready)},'ready');});
`,
      { mode: 0o700 },
    );
    const entered = new Promise<void>((resolve) => {
      const watcher = watch(f.dir, (_, name) => {
        if (name === 'ready') {
          watcher.close();
          resolve();
        }
      });
      closeWatcher = () => watcher.close();
    });
    release = () => writeFileSync(gate, 'release');
    Object.setPrototypeOf(f.station, StationWork.prototype);
    Object.assign(f.station, {
      store: f.store,
      files: new Map(),
      closing: false,
      config: { workspace_identity: 'd'.repeat(64), workspace: f.dir, files: { path: helper } },
      options: {
        assertActive: () => {
          throw Error('must not borrow model authority');
        },
      },
    });
    delete (f.station as unknown as Record<string, unknown>).verificationTree;
    delete (f.station as unknown as Record<string, unknown>).assertVerificationSettled;
    f.verification.station = f.adapter;
    f.adapter.bind(f.check, f.call);
    f.returned();
    const first = f.adapter.withFresh(f.check, () => 'first');
    pending.push(first);
    await Promise.race([entered, first]);
    const second = f.adapter.withFresh(f.check, () => 'second');
    pending.push(second);
    // A live owned read never downgrades a separate unknown, mutation, or
    // unconfirmed native resource into a retryable observation.
    for (const update of [
      "UPDATE station_calls SET state='outcome_unknown' WHERE id=?",
      "UPDATE station_calls SET state='prepared',kind='patch' WHERE id=?",
      "UPDATE station_calls SET helper_state='unconfirmed' WHERE id=?",
    ]) {
      f.store.db.prepare(update).run(f.call);
      expect(() => f.verification.assertIdle(f.tasks.get(f.task.id))).toThrowError(
        expect.objectContaining({ code: 'task_uncertain' }),
      );
      f.store.db
        .prepare(
          "UPDATE station_calls SET state='returned',kind='check',helper_state='none' WHERE id=?",
        )
        .run(f.call);
    }
    f.store.db.prepare("UPDATE station_units SET state='unconfirmed'").run();
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id))).toThrowError(
      expect.objectContaining({ code: 'task_uncertain' }),
    );
    f.store.db.prepare("UPDATE station_units SET state='stopped'").run();
    const inspection = String(
      f.store.db.prepare("SELECT id FROM station_calls WHERE kind='read'").get()!.id,
    );
    f.store.db
      .prepare("UPDATE station_calls SET helper_state='unconfirmed' WHERE id=?")
      .run(inspection);
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id))).toThrowError(
      expect.objectContaining({ code: 'task_uncertain' }),
    );
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id), inspection)).toThrowError(
      expect.objectContaining({ code: 'task_uncertain' }),
    );
    f.store.db
      .prepare("UPDATE station_calls SET helper_state='running' WHERE id=?")
      .run(inspection);
    // This is the same synchronous fence used by start(), before accepting a check.
    expect(() => f.verification.assertIdle(f.tasks.get(f.task.id))).toThrowError(
      expect.objectContaining({ code: 'task_busy' }),
    );
    expect(
      f.store.db.prepare("SELECT count(*) AS n FROM station_calls WHERE kind='read'").get()!.n,
    ).toBe(1);
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(
      f.store.db
        .prepare(
          "SELECT count(*) AS n FROM station_calls WHERE kind='read' AND state='returned' AND helper_state='stopped'",
        )
        .get()!.n,
    ).toBe(2);
    f.verification.assertIdle(f.tasks.get(f.task.id));
  } finally {
    release();
    closeWatcher();
    await Promise.allSettled(pending);
    f.close();
  }
});

// Staging 2026-10-30 (card_06a619a3e2e94faf): the verification guard refused at spawn, before the
// helper's pid was recorded, so the read stayed 'launching' with no pid, became 'unconfirmed', and
// every later shutdown and daemon start failed on it.
function syntheticHelperStation(f: ReturnType<typeof fixture>) {
  const path = join(f.dir, 'synthetic-file-helper');
  writeFileSync(
    path,
    `#!${process.execPath}\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);setTimeout(()=>console.log(JSON.stringify({version:1,ok:true,tree_digest:'${'a'.repeat(64)}',root_identity:r.root_identity,files:1})),25);});\n`,
    { mode: 0o700 },
  );
  Object.setPrototypeOf(f.station, StationWork.prototype);
  Object.assign(f.station, {
    store: f.store,
    files: new Map(),
    jobs: new Map(),
    closing: false,
    unregister: () => {},
    config: { workspace_identity: 'd'.repeat(64), workspace: f.dir, files: { path } },
    options: {
      assertActive: () => {
        throw Error('must not borrow model authority');
      },
    },
  });
  delete (f.station as unknown as Record<string, unknown>).verificationTree;
  delete (f.station as unknown as Record<string, unknown>).assertVerificationSettled;
  return path;
}

test('a verification read its guard refuses at spawn still records and stops its helper', async () => {
  const f = fixture();
  try {
    syntheticHelperStation(f);
    const observe = f.station.verificationTree.bind(f.station);
    let refused = false;
    f.station.verificationTree = (source, validate) =>
      observe(source, (id) => {
        const row = f.store.db.prepare('SELECT helper_state FROM station_calls WHERE id=?').get(id);
        // The spawn-time guard (the first one once a helper exists): the task became busy, a
        // critic child, between launch and spawn.
        if (
          !refused &&
          ['launching', 'running'].includes(String(row?.helper_state)) &&
          (refused = true)
        )
          throw new ServiceError(
            'task_busy',
            'Wait for attempts, children, commands and compaction to settle',
          );
        validate(id);
      });
    f.adapter.bind(f.check, f.call);
    f.returned();
    await expect(f.adapter.withFresh(f.check, () => undefined)).rejects.toThrow();
    const read = f.store.db.prepare("SELECT * FROM station_calls WHERE kind='read'").get();
    expect(Number(read!.helper_pid)).toBeGreaterThan(0);
    await (f.station as unknown as { close(): Promise<void> }).close();
    const after = f.store.db.prepare("SELECT * FROM station_calls WHERE kind='read'").get();
    expect(after).toMatchObject({ helper_state: 'stopped' });
    expect(JSON.parse(String(after!.helper_stop_json))).toMatchObject({ method: 'observed_exit' });
  } finally {
    f.close();
  }
});

test('a helper left unconfirmed with no pid settles only when no station helper process exists', async () => {
  const f = fixture();
  try {
    syntheticHelperStation(f);
    f.adapter.bind(f.check, f.call);
    f.returned();
    const session = String(
      f.store.db.prepare("SELECT session_id FROM station_calls WHERE kind='check'").get()!
        .session_id,
    );
    const stuck = {
      id: 'e'.repeat(64),
      session,
    };
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,task_check_id,helper_state) SELECT ?,session_id,0,NULL,?,'read',input_digest,root_digest,configuration_digest,'{}','failed',?,'unconfirmed' FROM station_calls WHERE kind='check'",
      )
      .run(stuck.id, stuck.id, f.check);
    // A live process of the station helper: absence is not proven, so the row stays fenced.
    const live = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)', 'salaam-station-files-v1'],
      {
        stdio: 'ignore',
      },
    );
    await new Promise((r) => live.once('spawn', r));
    const close = () => (f.station as unknown as { close(): Promise<void> }).close();
    try {
      await expect(close()).rejects.toThrow();
      expect(
        f.store.db.prepare('SELECT helper_state FROM station_calls WHERE id=?').get(stuck.id),
      ).toMatchObject({ helper_state: 'unconfirmed' });
    } finally {
      live.kill('SIGKILL');
      await new Promise((r) => live.once('exit', r));
    }
    // No station helper process anywhere. Absence can only be proven from Linux's /proc, so off
    // Linux the pid-less helper stays fenced; on Linux it is proven absent and settles.
    if (process.platform !== 'linux') {
      await expect(close()).rejects.toThrow();
      expect(
        f.store.db.prepare('SELECT helper_state FROM station_calls WHERE id=?').get(stuck.id),
      ).toMatchObject({ helper_state: 'unconfirmed' });
      return;
    }
    await close();
    const settled = f.store.db.prepare('SELECT * FROM station_calls WHERE id=?').get(stuck.id);
    expect(settled).toMatchObject({ helper_state: 'stopped' });
    expect(JSON.parse(String(settled!.helper_stop_json))).toMatchObject({
      method: 'no_helper_process',
      scope: 'host_process_table',
    });
  } finally {
    f.close();
  }
});

test('stopping before a queued freshness observation runs launches no helper', async () => {
  const f = fixture();
  try {
    f.adapter.bind(f.check, f.call);
    f.returned();
    let observations = 0;
    f.station.verificationTree = async () => {
      observations++;
      throw Error('must not launch');
    };
    const pending = f.adapter.withFresh(f.check, () => {
      throw Error('must not consume');
    });
    f.adapter.stop();
    await expect(pending).rejects.toMatchObject({ code: 'verification_stopped' });
    expect(observations).toBe(0);
    expect(f.verification.get(f.check).state).toBe('accepted');
  } finally {
    f.close();
  }
});

test('stopping before a queued dispatch runs preserves accepted work without launching', async () => {
  const f = fixture();
  try {
    let observations = 0;
    f.station.verificationTree = async () => {
      observations++;
      throw Error('must not launch');
    };
    f.adapter.dispatch(f.check);
    f.adapter.stop();
    await f.adapter.drain();
    expect(observations).toBe(0);
    expect(f.verification.get(f.check).state).toBe('accepted');
    expect(
      f.store.db.prepare("SELECT count(*) AS n FROM station_calls WHERE kind='read'").get()!.n,
    ).toBe(0);
  } finally {
    f.close();
  }
});

test.each([
  ['final', 'complete'],
  ['step', 'complete'],
  ['final', 'drift'],
  ['final', 'unknown'],
  ['final', 'unconfirmed'],
] as const)(
  'scheduler waits for the entire %s check set before freshness, then enforces %s (real helper and gated native fixture process)',
  async (stage, outcome) => {
    const f = fixture(['tests', 'exact']);
    let native: ChildProcessWithoutNullStreams | undefined;
    let nativeDone = Promise.resolve();
    try {
      // These are actual child processes and durable controller rows. The native
      // boundary is a fixture runner, not evidence of Linux/systemd isolation.
      writeFileSync(join(f.dir, 'app.js'), '2');
      const helper = join(f.dir, 'file-helper');
      writeFileSync(
        helper,
        `#!${process.execPath}
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(JSON.stringify({version:1,ok:true,tree_digest:require('node:fs').readFileSync(${JSON.stringify(join(f.dir, 'app.js'))},'utf8')==='2'?'${'a'.repeat(64)}':'${'e'.repeat(64)}',root_identity:r.root_identity,files:1,...(r.action==='read'?{path:r.path,content:'2',sha256:require('node:crypto').createHash('sha256').update('2').digest('hex')}:{})}));});
`,
        { mode: 0o700 },
      );
      Object.setPrototypeOf(f.station, StationWork.prototype);
      Object.assign(f.station, {
        store: f.store,
        files: new Map(),
        closing: false,
        config: { workspace_identity: 'd'.repeat(64), workspace: f.dir, files: { path: helper } },
        options: {
          assertActive: () => {
            throw Error('must not borrow model authority');
          },
        },
        prepareTaskCheck: StationWork.prototype.prepareTaskCheck,
      });
      delete (f.station as unknown as Record<string, unknown>).verificationTree;
      delete (f.station as unknown as Record<string, unknown>).assertVerificationSettled;
      f.verification.station = f.adapter;
      const step = f.task.steps[0]!.id;
      f.store.db
        .prepare('UPDATE task_steps SET state=? WHERE id=?')
        .run(stage === 'step' ? 'awaiting_review' : 'completed', step);
      if (stage === 'step')
        f.store.db.prepare('UPDATE task_checks SET step_id=? WHERE id=?').run(step, f.check);
      f.store.db
        .prepare("UPDATE task_checks SET engine_id='linux-systemd-station-v1' WHERE id=?")
        .run(f.check);
      f.adapter.bind(f.check, f.call);
      f.returned();
      const evidence = await f.adapter.withFresh(f.check, (e) => e);
      const artifact = f.verification.artifacts.put(f.session.id, canonical(evidence));
      f.store.db
        .prepare("UPDATE task_checks SET state='passed',artifact_id=? WHERE id=?")
        .run(artifact, f.check);
      f.store.db
        .prepare('UPDATE task_runtime SET auto_enabled=1,auto_plan_revision=? WHERE task_id=?')
        .run(f.task.plan_revision, f.task.id);
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.station.run = (id: string) => {
        const call = f.station.get(id);
        f.station.taskCheckGuard!(call);
        const cleanup = { version: 1, method: 'fixture_process_exited' };
        f.store.db.prepare("UPDATE station_calls SET state='dispatching' WHERE id=?").run(id);
        f.store.db.prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          'unit:' + id,
          f.session.id,
          id,
          digest({
            id,
            root: call.root_digest,
            configuration: call.configuration_digest,
            input: call.input_digest,
          }),
          canonical({ workspace_identity: 'd'.repeat(64) }),
          'fixture',
          'fixture',
          '{"invocation":"fixture"}',
          'running',
          null,
        );
        native = spawn(
          process.execPath,
          [
            '-e',
            `const fs=require('node:fs');process.stdout.write('ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(fs.readFileSync(process.argv[1],'utf8')==='2'?0:1));`,
            join(f.dir, 'app.js'),
          ],
          { stdio: 'pipe' },
        );
        native.stdout.once('data', entered);
        nativeDone = new Promise<void>((resolve, reject) => {
          native!.once('error', reject);
          native!.once('close', (code) => {
            const args = JSON.parse(call.args_json);
            f.store.db
              .prepare("UPDATE station_units SET state='stopped',stop_json=? WHERE call_id=?")
              .run(canonical(cleanup), id);
            f.store.db
              .prepare("UPDATE station_calls SET state='returned',result_json=? WHERE id=?")
              .run(
                canonical({
                  exit_code: code,
                  verified_check: code === 0,
                  expected_tree: args.expected_tree,
                  observed_tree: args.expected_tree,
                  network: 'none',
                  workspace: 'read-only-reviewed-snapshot',
                  cleanup,
                }),
                id,
              );
            resolve();
          });
        });
        return {};
      };
      const driver = new TaskDriver(
        f.store,
        f.tasks,
        f.verification.budget,
        f.verification,
        {} as Supervisor,
        { activeCount: () => 0 } as unknown as ChildWork,
        f.verification.coding,
      );
      const progress = () =>
        (
          driver as unknown as { progress(task: ReturnType<TaskWork['get']>): Promise<void> }
        ).progress(f.tasks.get(f.task.id));
      await progress(); // Passed first check, accepted/dispatched the second.
      await f.adapter.drain();
      await ready;
      expect(
        f.verification.latest(f.tasks.get(f.task.id), 'exact', stage === 'step' ? step : null)
          ?.state,
      ).toBe('running');
      expect(() => f.verification.assertIdle(f.tasks.get(f.task.id))).toThrowError(
        expect.objectContaining({ code: 'task_busy' }),
      );
      await progress(); // Regression: this previously falsely stopped on the first check.
      expect(f.verification.budget.state(f.task.id).auto_enabled).toBe(1);
      expect(f.tasks.get(f.task.id).state).not.toBe('partially_completed');
      expect(
        f.store.db.prepare('SELECT 1 FROM task_completions WHERE task_id=?').get(f.task.id),
      ).toBeUndefined();
      native!.stdin.end();
      await nativeDone;
      await f.verification.reconcileAsync();
      expect(
        f.verification.latest(f.tasks.get(f.task.id), 'exact', stage === 'step' ? step : null)
          ?.state,
      ).toBe('passed');
      if (outcome === 'drift') writeFileSync(join(f.dir, 'app.js'), '3');
      if (outcome === 'unknown')
        f.store.db
          .prepare("UPDATE station_calls SET state='outcome_unknown' WHERE id=?")
          .run(f.call);
      if (outcome === 'unconfirmed')
        f.store.db
          .prepare("UPDATE station_units SET state='unconfirmed' WHERE call_id=?")
          .run(f.call);
      await progress();
      if (outcome !== 'complete') {
        expect(f.tasks.get(f.task.id).state).toBe('partially_completed');
        expect(f.verification.budget.state(f.task.id).auto_enabled).toBe(0);
        expect(
          f.store.db.prepare('SELECT 1 FROM task_completions WHERE task_id=?').get(f.task.id),
        ).toBeUndefined();
      } else if (stage === 'final') expect(f.tasks.get(f.task.id).state).toBe('succeeded');
      else expect(f.tasks.get(f.task.id).steps[0]!.state).toBe('completed');
    } finally {
      native?.stdin.end();
      await nativeDone;
      f.close();
    }
  },
);
