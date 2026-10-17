import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ChildWork } from '../../src/children.js';
import { Artifacts } from '../../src/artifacts.js';
import type { Supervisor } from '../../src/supervisor.js';

function setup() {
  const dir = mkdtempSync('/tmp/sal-child-unit-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const parent = store.create(dir, 'parent');
  const epoch = store.allocate(parent.id, 'boot');
  store.state(parent.id, epoch, 'ready');
  const attempt = store.accept(
    parent.id,
    'attempt',
    store.session(parent.id).revision,
    'parent',
  ).attempt_id;
  store.claim(parent.id, epoch);
  store.running(attempt);
  let starts = 0;
  const supervisor = {
    assertActive: () => {},
    start: async (id: string) => {
      starts++;
      store.allocate(id, 'boot');
    },
  } as unknown as Supervisor;
  const children = new ChildWork(store, new Artifacts(join(dir, 'artifacts'), store), supervisor);
  return {
    dir,
    store,
    parent,
    epoch,
    attempt,
    children,
    starts: () => starts,
    async close() {
      await children.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('spawn dedup, authority intersection, depth and concurrency are enforced before another dispatch', async () => {
  const f = setup();
  try {
    const first = f.children.spawn(f.parent.id, f.epoch, f.attempt, 'step', 'read-only', 2, [
      'salaam_probe',
      'salaam_effect',
    ]);
    expect(JSON.parse(first.authority)).toEqual(['salaam_probe']);
    expect(
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'step', 'read-only', 2, [
        'salaam_probe',
        'salaam_effect',
      ]).id,
    ).toBe(first.id);
    expect(f.starts()).toBe(1);
    expect(() =>
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'step', 'changed', 2, ['salaam_probe']),
    ).toThrow('Step key');
    expect(() =>
      f.children.spawn(first.child_session, 1, first.child_attempt, 'grandchild', 'read', 1, [
        'salaam_probe',
      ]),
    ).toThrow('depth');
    expect(() =>
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'denied', 'write', 1, ['salaam_effect']),
    ).toThrow('authority');
    f.children.spawn(f.parent.id, f.epoch, f.attempt, 'second', 'read', 2, ['salaam_probe']);
    expect(() =>
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'third', 'read', 2, ['salaam_probe']),
    ).toThrow('At most two');
    expect(f.starts()).toBe(2);
  } finally {
    await f.close();
  }
});
test('parent budget reservation and child model admission cannot overrun the allocated request budget', async () => {
  const f = setup();
  try {
    f.store.transaction(() => f.store.usage.budget(f.attempt, 3));
    f.store.usage.admit(f.parent.id, f.attempt, 'parent-request', 'salaam-proof', 'model');
    expect(() =>
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'expensive', 'read', 3, ['salaam_probe']),
    ).toThrow('reserve');
    expect(f.starts()).toBe(0);
    const child = f.children.spawn(f.parent.id, f.epoch, f.attempt, 'bounded', 'read', 2, [
      'salaam_probe',
    ]);
    expect(() =>
      f.store.usage.admit(f.parent.id, f.attempt, 'parent-overrun', 'salaam-proof', 'model'),
    ).toThrow('budget');
    f.store.usage.admit(
      child.child_session,
      child.child_attempt,
      'child-one',
      'salaam-proof',
      'model',
    );
    f.store.usage.admit(
      child.child_session,
      child.child_attempt,
      'child-two',
      'salaam-proof',
      'model',
    );
    expect(() =>
      f.store.usage.admit(
        child.child_session,
        child.child_attempt,
        'child-three',
        'salaam-proof',
        'model',
      ),
    ).toThrow('budget');
    expect(() =>
      f.store.usage.admit(
        child.child_session,
        child.child_attempt,
        'child-one',
        'salaam-proof',
        'model',
      ),
    ).toThrow('twice');
  } finally {
    await f.close();
  }
});
test('usage imports immutable request and Pi entry sources once, includes compaction and preserves unknown requests', async () => {
  const f = setup();
  try {
    const child = f.children.spawn(f.parent.id, f.epoch, f.attempt, 'one', 'read', 3, [
      'salaam_probe',
    ]);
    const usage = { input: 10, output: 4, cacheRead: 3, cacheWrite: 2, cost: { total: 0.03 } };
    f.store.usage.admit(
      child.child_session,
      child.child_attempt,
      'salaam-request:one',
      'salaam-proof',
      'model',
    );
    f.store.transaction(() =>
      f.store.usage.observe(
        child.child_session,
        'salaam-request:one',
        'salaam-proof',
        'model',
        usage,
      ),
    );
    const entries = [
      {
        id: 'entry-one',
        type: 'message',
        message: {
          role: 'assistant',
          responseId: 'salaam-request:one',
          provider: 'salaam-proof',
          model: 'model',
          stopReason: 'stop',
          usage,
        },
      },
      { id: 'tool-result', message: { role: 'toolResult', usage } },
      { id: 'compaction', type: 'compaction', usage },
      { id: 'failed-compaction', type: 'compaction' },
    ];
    f.store.importEntries(child.child_session, 1, entries, 'compaction');
    const summary = f.store.usage.summary(f.parent.id);
    f.store.importEntries(child.child_session, 1, entries, 'compaction');
    expect(f.store.usage.summary(f.parent.id)).toEqual(summary);
    expect(summary).toMatchObject({
      observations: 3,
      unknown_observations: 1,
      known_input: 20,
      known_output: 8,
      known_cost: 0.03,
      estimated_cost: 0.03,
    });
    f.store.usage.admit(
      child.child_session,
      child.child_attempt,
      'unfinished',
      'salaam-proof',
      'model',
    );
    const aborted = [
      {
        id: 'abort',
        message: {
          role: 'assistant',
          responseId: 'salaam-request:aborted',
          stopReason: 'aborted',
          usage,
        },
      },
    ];
    f.store.importEntries(child.child_session, 1, aborted, 'abort');
    expect(f.store.usage.summary(f.parent.id)).toMatchObject({
      unknown_observations: 3,
      known_cost: 0.03,
      estimated_cost: 0.03,
    });
    expect(() =>
      f.store.transaction(() =>
        f.store.usage.observe(child.child_session, 'salaam-request:one', 'salaam-proof', 'model', {
          ...usage,
          input: 99,
        }),
      ),
    ).toThrow('changed');
  } finally {
    await f.close();
  }
});
test('result publication rolls back final child state and inbox together when journaling fails', async () => {
  const f = setup();
  try {
    const child = f.children.spawn(f.parent.id, f.epoch, f.attempt, 'one', 'read', 2, [
      'salaam_probe',
    ]);
    f.store.state(child.child_session, 1, 'ready');
    f.store.claim(child.child_session, 1);
    f.store.running(child.child_attempt);
    f.store.db.exec(
      "CREATE TRIGGER reject_result BEFORE INSERT ON events WHEN NEW.kind='child.result_available' BEGIN SELECT RAISE(ABORT,'no result commit'); END",
    );
    expect(() => f.store.finish(child.child_attempt, 'completed', 'answer', null)).toThrow(
      'no result commit',
    );
    expect(f.store.attempt(child.child_attempt).state).toBe('running');
    expect(f.children.inspect(f.parent.id, child.id)).toMatchObject({
      state: 'accepted',
      artifact_id: null,
      result_id: null,
    });
    expect(f.store.db.prepare('SELECT count(*) AS n FROM artifacts').get()).toEqual({ n: 0 });
    f.store.db.exec('DROP TRIGGER reject_result');
    f.store.finish(child.child_attempt, 'completed', 'answer', null);
    const final = f.children.inspect(f.parent.id, child.id);
    expect(final.state).toBe('completed');
    expect(f.children.consume(f.parent.id, child.id, final.result_id!)).toMatchObject({
      result: { text: 'answer' },
    });
  } finally {
    await f.close();
  }
});

test('schema v3 migrates cached replies and completed attempts without changing outcomes', () => {
  const dir = mkdtempSync('/tmp/sal-v3-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'create');
    const epoch = store.allocate(session.id, 'boot');
    store.state(session.id, epoch, 'ready');
    const receipt = store.accept(session.id, 'submit', store.session(session.id).revision, 'hello');
    store.claim(session.id, epoch);
    store.finish(receipt.attempt_id, 'completed', 'preserved', null);
    const revision = store.session(session.id).revision;
    store.db.exec(
      'DROP TABLE session_routes; DROP TABLE usage_observations;DROP TABLE attempt_budgets;DROP TABLE child_tasks;PRAGMA user_version=3;',
    );
    store.close();
    store = new Store(path);
    expect(store.attempt(receipt.attempt_id)).toMatchObject({
      state: 'completed',
      result: 'preserved',
    });
    expect(store.create(dir, 'create')).toEqual(session);
    expect(store.session(session.id).revision).toBe(revision);
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('worker loss before initial child handoff publishes an interruption instead of leaving the inbox pending', async () => {
  const f = setup();
  try {
    const child = f.children.spawn(f.parent.id, f.epoch, f.attempt, 'one', 'read', 2, [
      'salaam_probe',
    ]);
    f.children.workerLost(child.child_session, 'Worker died before dispatch');
    const result = f.children.inspect(f.parent.id, child.id);
    expect(result).toMatchObject({ state: 'interrupted', acknowledged: 0 });
    expect(f.children.consume(f.parent.id, child.id, result.result_id!)).toMatchObject({
      result: { state: 'interrupted', error: 'Worker died before dispatch' },
    });
    expect(
      f.children.spawn(f.parent.id, f.epoch, f.attempt, 'one', 'read', 2, ['salaam_probe']).id,
    ).toBe(child.id);
    expect(f.starts()).toBe(1);
  } finally {
    await f.close();
  }
});
