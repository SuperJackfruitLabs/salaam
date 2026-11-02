import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { RATE_LIMIT_STOP, RateLimitRetries } from '../../src/providers/rate-limit-retries.js';
import { fixture, settlementDriver } from './agentpod-work-helpers.js';
import { characterizeEvidence } from '../agentpod-evidence-recorder.js';

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const { recordingCore } = await import('../agentpod-evidence-recorder.js');
  return recordingCore(await importOriginal());
});
vi.mock('node:crypto', async (importOriginal) => {
  const { countingCrypto } = await import('../agentpod-evidence-recorder.js');
  return countingCrypto(await importOriginal());
});
characterizeEvidence();

// 429: past three rate-limited attempts the task stops with a block the recovery can prove.
function rateLimitStopFixture() {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const limits = new RateLimitRetries(f.store);
  let last = '';
  for (let n = 1; n <= 3; n++) {
    const attempt = f.store.transaction(() => {
      const a = f.store.enqueue(
        f.session,
        randomUUID(),
        step.instruction,
        undefined,
        null,
        step.id,
      );
      f.store.db
        .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
        .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
      return a.attempt_id;
    });
    f.store.db.prepare('UPDATE attempts SET state=\x27failed\x27,outcome=? WHERE id=?').run(
      JSON.stringify({
        version: 1,
        stopReason: 'error',
        failure: { version: 1, kind: 'rate_limit', code: 'provider_rate_limit', message: '429' },
      }),
      attempt,
    );
    f.store.db
      .prepare('UPDATE submissions SET state=\x27failed\x27 WHERE attempt_id=?')
      .run(attempt);
    f.store.db
      .prepare('UPDATE task_steps SET state=\x27failed\x27,attempt_id=? WHERE id=?')
      .run(attempt, step.id);
    limits.decide(f.tasks.get(task.id), n * 10 ** 9);
    last = attempt;
  }
  f.work.verification.budget.block(f.session, RATE_LIMIT_STOP);
  f.store.db.prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?').run(task.id);
  f.store.db.prepare('UPDATE durable_tasks SET state=\x27blocked\x27 WHERE id=?').run(task.id);
  f.store.db.prepare('UPDATE workers SET state=\x27exited\x27 WHERE session_id=?').run(f.session);
  f.authority.revoke(f.binding, 'rate-limit-revoke', 'Bounded progression stopped');
  return { f, admitted, task, last };
}

test('a rate-limit stop is provable: status says so and it retires with known effects', async () => {
  const x = rateLimitStopFixture();
  try {
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect(status.settlement_ready).toBe('known_effects_failure');
    expect(
      x.f.work.fail(
        x.f.binding,
        'rl-retire',
        x.admitted.request_id,
        'a'.repeat(64),
        settlementDriver(x.f),
      ),
    ).toMatchObject({ effects: 'known_effects_preserved' });
  } finally {
    x.f.close();
  }
});

test.each([
  'other-reason',
  'running-attempt',
  'unknown-operation',
  'not-rate-limited',
  'unrecorded',
])('a rate-limit stop is refused when it does not hold (%s)', async (failure) => {
  const x = rateLimitStopFixture();
  try {
    const db = x.f.store.db;
    if (failure === 'other-reason')
      db.prepare('UPDATE task_runtime SET blocked_reason=\x27Task request limit reached\x27').run();
    if (failure === 'running-attempt')
      // An earlier attempt, so only the all-attempts-settled guard can see it.
      db.prepare(
        'UPDATE attempts SET state=\x27interrupted\x27 WHERE id=(SELECT id FROM attempts WHERE session_id=? AND id<>? LIMIT 1)',
      ).run(x.f.session, x.last);
    if (failure === 'not-rate-limited')
      db.prepare('UPDATE attempts SET outcome=\x27{"failure":{"kind":"auth"}}\x27 WHERE id=?').run(
        x.last,
      );
    if (failure === 'unrecorded')
      db.prepare('DELETE FROM task_rate_limits WHERE attempt_id=?').run(x.last);
    if (failure === 'unknown-operation') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        'INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state) VALUES(\x27op-x\x27,?,?,1,\x27c\x27,\x27workspace\x27,\x27k\x27,\x27a\x27,\x27d\x27,\x27t\x27,\x27v\x27,\x27tv\x27,\x27p\x27,\x27station-workspace-v1\x27,\x27opaque\x27,\x27denied\x27)',
      ).run(x.f.session, x.last);
      db.exec('PRAGMA foreign_keys=ON');
    }
    const status = (await x.f.work
      .status(x.f.binding, settlementDriver(x.f))
      .catch(() => ({}))) as Record<string, unknown>;
    expect('settlement_ready' in status).toBe(false);
    expect(() =>
      x.f.work.fail(
        x.f.binding,
        'rl-retire',
        x.admitted.request_id,
        'a'.repeat(64),
        settlementDriver(x.f),
      ),
    ).toThrow();
  } finally {
    x.f.close();
  }
});
