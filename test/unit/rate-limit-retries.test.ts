import { test, expect } from 'vitest';
import { Store } from '../../src/store/store.js';
import {
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_STOP,
  RateLimitRetries,
} from '../../src/providers/rate-limit-retries.js';

// 429: a step whose attempt the provider rate-limited is re-run as a fresh admitted attempt after
// a backoff, up to three failures; then the task stops with a provable rate-limit block.
function fixture() {
  const store = new Store(':memory:');
  const retries = new RateLimitRetries(store);
  const session = store.create('/tmp', 'create').id;
  const fail = (kind: string) => {
    const attempt = store.accept(
      session,
      'a-' + Math.random(),
      store.session(session).revision,
      'x',
    ).attempt_id;
    store.db.prepare("UPDATE attempts SET state='failed',outcome=? WHERE id=?").run(
      JSON.stringify({
        version: 1,
        stopReason: 'error',
        failure: { version: 1, kind, code: 'provider_' + kind, message: 'x' },
      }),
      attempt,
    );
    return attempt;
  };
  return { store, retries, fail };
}
const step = (attempt: string | null, state = 'failed') => ({
  id: 'step-1',
  state,
  attempt_id: attempt,
});
const task = (steps: ReturnType<typeof step>[]) => ({ id: 'task-1', steps }) as never;

test('a rate-limited step waits out its backoff, then is retried as a fresh attempt', () => {
  const f = fixture();
  const a1 = f.fail('rate_limit');
  expect(f.retries.decide(task([step(a1)]), 0)).toEqual({ action: 'wait' });
  expect(f.retries.decide(task([step(a1)]), RATE_LIMIT_BACKOFF_MS[0]! - 1)).toEqual({
    action: 'wait',
  });
  expect(f.retries.decide(task([step(a1)]), RATE_LIMIT_BACKOFF_MS[0]!)).toEqual({
    action: 'retry',
    step: 'step-1',
    n: 1,
  });
  // The same failed attempt counts once, however often it is looked at.
  expect(f.retries.decide(task([step(a1)]), RATE_LIMIT_BACKOFF_MS[0]!)).toMatchObject({ n: 1 });
  // A second rate-limited attempt waits the next, longer backoff.
  const a2 = f.fail('rate_limit');
  const t2 = 10_000_000;
  expect(f.retries.decide(task([step(a2)]), t2)).toEqual({ action: 'wait' });
  expect(f.retries.decide(task([step(a2)]), t2 + RATE_LIMIT_BACKOFF_MS[1]!)).toMatchObject({
    action: 'retry',
    n: 2,
  });
});

test(`after ${RATE_LIMIT_MAX_FAILURES} rate-limited attempts the task stops for recovery`, () => {
  const f = fixture();
  let now = 0;
  for (let n = 1; n < RATE_LIMIT_MAX_FAILURES; n++) {
    const a = f.fail('rate_limit');
    f.retries.decide(task([step(a)]), now);
    now += 10 ** 9;
    expect(f.retries.decide(task([step(a)]), now)).toMatchObject({ action: 'retry', n });
  }
  const last = f.fail('rate_limit');
  expect(f.retries.decide(task([step(last)]), now)).toEqual({
    action: 'stop',
    reason: RATE_LIMIT_STOP,
  });
});

test('any other failure, more than one failed step, or no failed step is not a retry', () => {
  const f = fixture();
  expect(f.retries.decide(task([step(f.fail('provider_unavailable'))]), 10 ** 9)).toEqual({
    action: 'none',
  });
  expect(
    f.retries.decide(
      task([step(f.fail('rate_limit')), { ...step(f.fail('rate_limit')), id: 'step-2' }]),
      10 ** 9,
    ),
  ).toEqual({ action: 'none' });
  expect(f.retries.decide(task([step(null, 'completed')]), 10 ** 9)).toEqual({ action: 'none' });
  const interrupted = f.fail('rate_limit');
  expect(f.retries.decide(task([step(interrupted, 'interrupted')]), 10 ** 9)).toEqual({
    action: 'none',
  });
});

import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/tasks/context.js';
import { TaskWork } from '../../src/tasks/work.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

test('a rate-limited step is re-run once per retry under its own grant, never as a replay', () => {
  const dir = mkdtempSync('/tmp/sal-rl-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const tasks = new TaskWork(
    store,
    new TaskContext(store, new Artifacts(join(dir, 'artifacts'), store)),
  );
  const session = store.create(dir, 'create').id;
  const task = store.transaction(() =>
    tasks.createInTransaction(
      session,
      'task',
      0,
      {
        objective: 'o',
        constraints: [],
        steps: [{ key: 's', title: 'S', instruction: 'Do it', depends_on: [] }],
        acceptance: [{ key: 't', command: 'true', cwd: '.' }],
        deliverables: ['a.md'],
      },
      () => {},
    ),
  );
  const step = tasks.get(task.id).steps[0]!;
  store.db
    .prepare(
      'UPDATE task_runtime SET auto_enabled=1,auto_plan_revision=?,remaining_steps=2,auto_epoch=1,auto_binding=\x27b\x27 WHERE task_id=?',
    )
    .run(task.plan_revision, task.id);
  store.db
    .prepare('INSERT INTO task_grants VALUES (\x27g1\x27,?,?,?,?,\x27accepted\x27,\x27b\x27,1)')
    .run(task.id, step.id, task.plan_revision, task.revision);
  store.db.prepare('UPDATE task_steps SET state=\x27failed\x27 WHERE id=?').run(step.id);
  const first = tasks.retryStep(task.id, step.id, 1, 1) as { attempt_id: string };
  expect(tasks.get(task.id).steps[0]!.state).toBe('queued');
  expect(store.db.prepare('SELECT state FROM task_grants WHERE id=\x27g1\x27').get()!.state).toBe(
    'accepted',
  );
  expect(
    store.db
      .prepare('SELECT count(*) AS n FROM events WHERE kind=\x27work_task.step_retried\x27')
      .get()!.n,
  ).toBe(1);
  // A step that is not failed is never re-run this way.
  expect(() => tasks.retryStep(task.id, step.id, 2, 1)).toThrow('No settled grant');
  // The next retry is a distinct request: a fresh attempt, not the earlier one replayed.
  store.db.prepare('UPDATE attempts SET state=\x27failed\x27 WHERE id=?').run(first.attempt_id);
  store.db.prepare('UPDATE submissions SET state=\x27failed\x27 WHERE session_id=?').run(session);
  store.db.prepare('UPDATE task_steps SET state=\x27failed\x27 WHERE id=?').run(step.id);
  const second = tasks.retryStep(task.id, step.id, 2, 1) as { attempt_id: string };
  expect(second.attempt_id).not.toBe(first.attempt_id);
});
