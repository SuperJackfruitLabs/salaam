import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';
import { TaskContext } from '../../src/task-context.js';
import { TaskWork } from '../../src/task-work.js';
import { TaskBudget } from '../../src/task-budget.js';
import { TaskVerification } from '../../src/task-verification.js';
import { CodingWork } from '../../src/coding.js';
import { Workspaces } from '../../src/workspaces.js';
import { StationWork, type StationCall } from '../../src/station-work.js';
import { StationTaskVerification } from '../../src/station-task-verification.js';
import { canonical, digest } from '../../src/protocol.js';

// Synthetic station boundary double: these tests prove receipt joining and
// transactional revalidation, never Linux/systemd execution or a live canary.
function fixture() {
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
          { key: 'check', title: 'Check', instruction: 'Check', depends_on: [], checks: ['tests'] },
        ],
        acceptance: [{ key: 'tests', command: 'npm test', cwd: '.' }],
        deliverables: ['app.js'],
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
            if (!scheduled && row?.helper_state === 'launching') {
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

test.each([false, true])(
  'installed controller enforces native evidence and missing deliverable=%s (synthetic station)',
  async (missing) => {
    const f = fixture();
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
        if (missing && request?.action === 'read') throw Error('deliverable missing');
        return request?.action === 'read'
          ? { ...result, path: request.path, sha256: 'f'.repeat(64) }
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
      expect(await f.verification.viewAsync(completed)).toMatchObject({
        completion: { fresh: true, state: 'succeeded' },
      });
      f.changeTree();
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
