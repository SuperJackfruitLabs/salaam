import { expect, test } from 'vitest';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { create, ready, fixture, until, control } from '../helpers.js';
import { submit, decide } from '../managed-helpers.js';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';
import { PiProcess } from '../../src/pi.js';
import type { Compaction, TaskState } from '../../src/task-context.js';

async function turn(f: Awaited<ReturnType<typeof fixture>>, id: string, text: string) {
  const accepted = await submit(f.service, id, text);
  const work = await until(
    () => f.service.store.attempt(accepted.attempt_id),
    (a) => !['accepted', 'dispatching', 'running'].includes(a.state),
  );
  expect(work.state, work.error ?? '').toBe('completed');
  return work;
}
async function compact(f: Awaited<ReturnType<typeof fixture>>, id: string, version: number) {
  const controller = await control(f.service, id, true);
  const body = { ...controller, request_id: randomUUID(), expected_version: version };
  const started = await call<Compaction>(f.service.socket, `/v1/sessions/${id}/compact`, body);
  const result = await until(
    () => f.service.tasks.compaction(started.id),
    (c) => c.state !== 'running',
  );
  expect(await call(f.service.socket, `/v1/sessions/${id}/compact`, body)).toEqual(result);
  return result;
}

test('S5: corrections, completed work and old evidence survive three real Pi compactions and an idle worker restart', async () => {
  const workers: PiProcess[] = [];
  const f = await fixture({
    extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs'),
    launch: (launch) => {
      const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
      workers.push(pi);
      return pi;
    },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const controller = await control(f.service, session.id, true);
    const update = async (kind: string, text: string, extra = {}) =>
      call<TaskState>(f.service.socket, `/v1/sessions/${session.id}/task`, {
        ...controller,
        request_id: randomUUID(),
        expected_version: f.service.tasks.state(session.id).version,
        fact: { kind, text, ...extra },
      });
    await update('objective', 'Finish the launch');
    const old = (await update('constraint', 'Deploy to production')).facts.at(-1)!;
    await update('constraint', 'Use staging only', { supersedes: old.id });
    await update('completed', 'Build the package');
    await update('outstanding', 'Review staging evidence');
    const artifact = f.service.artifacts.put(
      session.id,
      'Evidence from before compaction: build passed',
    );
    await update('evidence', 'Build report', { artifact_id: artifact });
    const initial = f.service.tasks.state(session.id);
    await turn(
      f,
      session.id,
      'Obsolete instruction: deploy to production. ' + 'old transcript '.repeat(1600),
    );
    const originalEntry = f.service.store.session(session.id).pi_cursor!;
    for (let index = 0; index < 3; index++) {
      await turn(
        f,
        session.id,
        'Corrected: staging only. checkpoint ' + index + ' retained context '.repeat(400),
      );
      const c = await compact(f, session.id, initial.version);
      expect(c.state, c.error ?? '').toBe('completed');
      expect(f.service.tasks.state(session.id)).toMatchObject({
        version: initial.version,
        compaction_cursor: c.cursor,
        facts: initial.facts,
      });
    }
    await workers[0]!.stop();
    await until(
      () =>
        f.service.store.db
          .prepare('SELECT state FROM workers WHERE session_id=? AND epoch=1')
          .get(session.id)?.state,
      (x) => x === 'exited',
    );
    await f.service.supervisor.start(session.id);
    await ready(f.service, session.id);
    const next = await turn(f, session.id, '[next]');
    expect(next.result).toBe('Next explicit work: Review staging evidence');
    expect(next.result).not.toContain('Build the package');
    await turn(f, session.id, '[history] ' + artifact);
    const entries = f.service.store.db
      .prepare(
        "SELECT payload FROM pi_entries WHERE session_id=? AND json_extract(payload,'$.message.toolName')='salaam_history'",
      )
      .all(session.id);
    expect(JSON.stringify(entries)).toContain('build passed');
    expect(f.service.tasks.history(session.id, { entry_id: originalEntry })).toMatchObject({
      entry_id: originalEntry,
    });
    const captured = readFileSync(join(f.dir, 'task-payloads.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((x) => JSON.parse(x));
    const last = captured.at(-1).messages.at(-1);
    const frame =
      typeof last.content === 'string'
        ? last.content
        : last.content.map((p: { text?: string }) => p.text ?? '').join('');
    const task = JSON.parse(frame.slice('SALAAM_TASK_STATE '.length));
    expect(task.version).toBe(initial.version);
    expect(task.facts).toEqual(initial.facts);
    expect(
      task.facts.find((fact: { id: string }) => fact.id === old.id).superseded_by,
    ).toBeTruthy();
    await turn(f, session.id, 'Prepare failure and cancellation proof. ' + 'context '.repeat(600));
    const beforeFailure = f.service.tasks.state(session.id);
    writeFileSync(join(f.dir, 'fail-compaction'), 'fail');
    expect((await compact(f, session.id, initial.version)).state).toBe('failed');
    expect(f.service.tasks.state(session.id)).toEqual(beforeFailure);
    unlinkSync(join(f.dir, 'fail-compaction'));
    writeFileSync(join(f.dir, 'hold-compaction'), 'hold');
    const actor = await control(f.service, session.id, true);
    const started = await call<Compaction>(f.service.socket, `/v1/sessions/${session.id}/compact`, {
      ...actor,
      request_id: randomUUID(),
      expected_version: initial.version,
    });
    await until(() => existsSync(join(f.dir, 'compaction-entered')), Boolean);
    await call(f.service.socket, `/v1/compactions/${started.id}/cancel`, {
      ...actor,
      request_id: randomUUID(),
    });
    expect(
      (
        await until(
          () => f.service.tasks.compaction(started.id),
          (x) => x.state !== 'running',
        )
      ).state,
    ).toBe('cancelled');
    expect(f.service.tasks.state(session.id)).toEqual(beforeFailure);
    expect(
      f.service.store.db
        .prepare(
          "SELECT count(*) n FROM pi_entries WHERE json_extract(payload,'$.type')='compaction'",
        )
        .get()?.n,
    ).toBe(3);
  } finally {
    await f.close();
  }
}, 30000);

test('compaction cannot abort a turn waiting for an approval; invalid outgoing task payload denies admission', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs') });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const accepted = await submit(f.service, session.id, '[review] inspect-target');
    const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
    await expect(
      call(f.service.socket, `/v1/sessions/${session.id}/compact`, {
        ...accepted.controller,
        request_id: randomUUID(),
        expected_version: 0,
      }),
    ).rejects.toThrow('active turn');
    expect(f.service.store.approvals(session.id)[0]).toEqual(approval);
    await decide(f.service, approval!, 'deny');
    await until(
      () => f.service.store.attempt(accepted.attempt_id).state,
      (x) => ['failed', 'completed'].includes(x),
    );
    const before = f.service.store
      .events(session.id, 0)
      .filter((e) => e.kind === 'model.admitted').length;
    writeFileSync(join(f.dir, 'stale-task-payload'), 'stale');
    await submit(f.service, session.id, 'Do not admit an invalid context');
    await until(
      () => f.service.supervisor.inspect(session.id).state,
      (x) => x === 'unhealthy',
    );
    expect(
      f.service.store.events(session.id, 0).filter((e) => e.kind === 'model.admitted'),
    ).toHaveLength(before);
  } finally {
    await f.close();
  }
});

test('compaction and idle parent replacement preserve an outstanding real child and an unresolved effect', async () => {
  const { effectFixture } = await import('../managed-helpers.js');
  const { SocketEffectConnector } = await import('../../src/effect-connector.js');
  const external = await effectFixture(true);
  writeFileSync(join(external.dir, 'hold-response'), 'hold');
  let parent: PiProcess | undefined;
  const f = await fixture({
    extensionPath: join(ROOT, 'test/fixtures/child-extension.mjs'),
    effectConnector: new SocketEffectConnector(external.socket, { opaque: true, timeoutMs: 150 }),
    launch: (launch) => {
      const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
      if (!JSON.parse(launch.env.SALAAM_WORKER_CONFIG!).child) parent = pi;
      return pi;
    },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await turn(f, session.id, '[children-nowait] pending-child');
    const child = f.service.children.list(session.id)[0]!;
    await until(() => existsSync(join(f.dir, 'child-' + child.child_session)), Boolean);
    await turn(f, session.id, 'Context to compact. ' + 'preserve work '.repeat(600));
    const effect = await submit(f.service, session.id, '[effect] unresolved-target');
    const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
    await decide(f.service, approval!, 'approve');
    await until(
      () => f.service.store.attempt(effect.attempt_id).state,
      (x) => x === 'interrupted',
    );
    const beforeChild = f.service.children.inspect(session.id, child.id);
    const beforeOperation = f.service.managed.operation(approval!.operation_id);
    expect(beforeChild.state).toBe('accepted');
    expect(beforeOperation.state).toBe('outcome_unknown');
    expect((await compact(f, session.id, 0)).state).toBe('completed');
    expect(f.service.children.inspect(session.id, child.id)).toEqual(beforeChild);
    expect(f.service.managed.operation(beforeOperation.id)).toEqual(beforeOperation);
    await parent!.stop();
    await until(
      () =>
        f.service.store.db
          .prepare('SELECT state FROM workers WHERE session_id=? AND epoch=1')
          .get(session.id)?.state,
      (x) => x === 'exited',
    );
    await f.service.supervisor.start(session.id);
    await ready(f.service, session.id);
    expect(f.service.children.inspect(session.id, child.id)).toEqual(beforeChild);
    expect(f.service.managed.operation(beforeOperation.id)).toEqual(beforeOperation);
    expect(await call(external.socket, '/stats')).toMatchObject({ posts: 1, count: 1 });
  } finally {
    await f.close();
    await external.close();
  }
});

test.each(['before-persistence', 'after-persistence'])(
  'compaction worker death %s reconciles only a positive Pi receipt and never replays',
  async (barrier) => {
    const workers: PiProcess[] = [];
    const f = await fixture({
      extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs'),
      launch: (launch) => {
        const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
        workers.push(pi);
        return pi;
      },
    });
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      await turn(f, session.id, 'Old conversation. ' + 'context '.repeat(900));
      await turn(f, session.id, 'Current instruction');
      const prior = f.service.tasks.state(session.id);
      const file = barrier === 'before-persistence' ? 'hold-compaction' : 'hold-after-compaction';
      writeFileSync(join(f.dir, file), 'hold');
      const actor = await control(f.service, session.id, true);
      const work = await call<Compaction>(f.service.socket, `/v1/sessions/${session.id}/compact`, {
        ...actor,
        request_id: randomUUID(),
        expected_version: 0,
      });
      await until(
        () =>
          existsSync(
            join(
              f.dir,
              barrier === 'before-persistence' ? 'compaction-entered' : 'compaction-persisted',
            ),
          ),
        Boolean,
      );
      process.kill(-workers[0]!.child.pid!, 'SIGKILL');
      await until(
        () => f.service.tasks.compaction(work.id).state,
        (x) => x === 'interrupted',
      );
      expect(f.service.tasks.state(session.id)).toEqual(prior);
      await until(
        () =>
          f.service.store.db
            .prepare('SELECT state FROM workers WHERE session_id=? AND epoch=1')
            .get(session.id)?.state,
        (x) => x === 'exited',
      );
      unlinkSync(join(f.dir, file));
      const before = f.service.store
        .events(session.id, 0)
        .filter((e) => e.kind === 'model.admitted').length;
      await f.service.supervisor.start(session.id);
      await ready(f.service, session.id);
      const result = f.service.tasks.compaction(work.id);
      expect(result.state).toBe(barrier === 'after-persistence' ? 'completed' : 'interrupted');
      expect(f.service.tasks.state(session.id).version).toBe(0);
      expect(f.service.tasks.state(session.id).compaction_cursor).toBe(
        barrier === 'after-persistence' ? result.cursor : null,
      );
      expect(
        f.service.store.events(session.id, 0).filter((e) => e.kind === 'model.admitted'),
      ).toHaveLength(before);
      expect(
        f.service.store.db
          .prepare(
            "SELECT count(*) n FROM pi_entries WHERE json_extract(payload,'$.type')='compaction'",
          )
          .get()?.n,
      ).toBe(barrier === 'after-persistence' ? 1 : 0);
    } finally {
      await f.close();
    }
  },
);
