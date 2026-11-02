import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { ManagedWork } from '../../src/execution/managed.js';
import { LocalCoding } from '../../src/local/coding.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { until } from '../helpers.js';
function setup() {
  const root = realpathSync(mkdtempSync('/tmp/sal-local-code-'));
  const store = new Store(':memory:');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const submission = store.accept(session.id, 'submit', session.revision, 'code');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  let valid = true;
  const active = () => {
    if (!valid) throw Error('Attempt cancelled');
  };
  const managed = new ManagedWork(store, {
    assertActive: active,
    reply: () => {},
    failed: () => {},
  });
  const local = new LocalCoding(store, managed, active);
  local.interactive = () => true;
  const prepare = (id: string, args: Record<string, unknown>) =>
    local.prepare(session.id, epoch, submission.attempt_id, id, args);
  const approve = (created: ReturnType<typeof prepare>) =>
    managed.decide(
      created.approval.id,
      'approve-' + created.call.id,
      created.approval.revision,
      created.operation.operation_digest,
      'approve',
    );
  return {
    root,
    store,
    session,
    epoch,
    submission,
    local,
    managed,
    prepare,
    approve,
    cancel: () => {
      valid = false;
    },
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const done = (f: ReturnType<typeof setup>, id: string) =>
  until(
    () => f.local.tasks(f.session.id).find((t) => t.id === id)!,
    (t) => t.state !== 'running',
  );
const launched = (f: ReturnType<typeof setup>, id: string) =>
  until(
    () => f.local.view(id),
    (v) => v.call.state !== 'running',
  );
async function start(f: ReturnType<typeof setup>, call: string, command: string) {
  const c = f.prepare(call, { action: 'command', command, background: true });
  f.approve(c);
  f.local.run(c.call.id);
  const v = await launched(f, c.call.id);
  return { c, v, task: (v.result as { task_id: string }).task_id };
}

test('a background command settles its approval at launch and keeps running after the turn', async () => {
  const f = setup();
  try {
    const c = f.prepare('bg', {
      action: 'command',
      command: 'sleep 0.3; echo up > ran',
      background: true,
    });
    expect(c.operation.value).toContain('in the background');
    f.approve(c);
    f.local.run(c.call.id);
    const v = await launched(f, c.call.id);
    expect(v.call.state).toBe('succeeded');
    const task = (v.result as { task_id: string; background: boolean }).task_id;
    expect(f.local.tasks(f.session.id)[0]).toMatchObject({ id: task, state: 'running' });
    // The turn ending must not stop it.
    f.cancel();
    const t = await done(f, task);
    expect(t).toMatchObject({ state: 'exited', exit_code: 0 });
    expect(readFileSync(join(f.root, 'ran'), 'utf8')).toBe('up\n');
    const finished = f.store
      .events(f.session.id, 0)
      .filter((e) => e.kind === 'local.task_finished');
    expect(finished).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 15000);

test('a running background task does not block the next edit or command', async () => {
  const f = setup();
  try {
    const { task } = await start(f, 'bg', 'sleep 20');
    const next = f.prepare('fg', { action: 'command', command: 'echo fg' });
    f.approve(next);
    f.local.run(next.call.id);
    const fg = await until(
      () => f.local.view(next.call.id),
      (v) => v.call.state !== 'running',
    );
    expect(fg.call.state).toBe('succeeded');
    expect(f.local.tasks(f.session.id).find((t) => t.id === task)!.state).toBe('running');
  } finally {
    await f.close();
  }
}, 15000);

test('background output is a bounded tail and a stop kills the whole group', async () => {
  const f = setup();
  try {
    const { task } = await start(
      f,
      'bg',
      'yes line | head -c 200000; sleep 30 & echo $! > kid; wait',
    );
    await until(
      () => f.local.taskOutput(f.session.id, task),
      (o) => o.bytes >= 200000 && existsSync(join(f.root, 'kid')),
    );
    const out = f.local.taskOutput(f.session.id, task);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.output)).toBeLessThanOrEqual(65536);
    expect(out.output.endsWith('line\n')).toBe(true);
    f.local.stopTask(f.session.id, task);
    expect((await done(f, task)).state).toBe('stopped');
    const kid = Number(readFileSync(join(f.root, 'kid'), 'utf8'));
    await until(
      () => {
        try {
          process.kill(kid, 0);
          return true;
        } catch {
          return false;
        }
      },
      (alive) => !alive,
    );
  } finally {
    await f.close();
  }
}, 15000);

test('background is refused outside an interactive session and past the per-session limit', async () => {
  const f = setup();
  try {
    f.local.interactive = () => false;
    expect(() => f.prepare('no', { action: 'command', command: 'true', background: true })).toThrow(
      /interactive/,
    );
    f.local.interactive = () => true;
    for (let i = 0; i < 4; i++) await start(f, 'bg' + i, 'sleep 20');
    expect(() =>
      f.prepare('five', { action: 'command', command: 'true', background: true }),
    ).toThrow(/at most 4/);
    expect(() => f.local.taskOutput('other-session', f.local.tasks(f.session.id)[0]!.id)).toThrow();
  } finally {
    await f.close();
  }
}, 15000);

test('a task lost to a restart is killed and recorded, never left running', async () => {
  const f = setup();
  try {
    const { task } = await start(f, 'bg', 'sleep 30');
    const pid = f.local.tasks(f.session.id)[0]!.pid!;
    // A second controller over the same store recovers the row as a restart would.
    const managed = new ManagedWork(f.store, {
      assertActive: () => {},
      reply: () => {},
      failed: () => {},
    });
    const again = new LocalCoding(f.store, managed, () => {});
    expect(again.tasks(f.session.id).find((t) => t.id === task)!.state).toBe('lost');
    await until(
      () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      (alive) => !alive,
    );
    await again.close();
    await managed.close();
  } finally {
    await f.close();
  }
}, 15000);
