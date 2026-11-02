import { expect, test, vi } from 'vitest';
import { settlementDriver, verificationStopFixture } from './agentpod-work-helpers.js';
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

// A run its own acceptance check stopped (staging card_d74eac4509f1453c): the worker ended its turn,
// the final check ran and failed definitely, and progression stopped. Everything is closed, so
// the board gets a failed run with that reason instead of a parked one nobody clears.
function checkFailedFixture() {
  const x = verificationStopFixture();
  const db = x.f.store.db;
  db.prepare('UPDATE task_runtime SET blocked_reason=NULL,auto_error=? WHERE task_id=?').run(
    'Verification failed or became stale: answer',
    x.task.id,
  );
  db.prepare(
    "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,state) VALUES('chk-1',?,NULL,'answer',?,'w',1,'d','p','linux-systemd-station-v1','failed')",
  ).run(x.task.id, x.task.plan_revision);
  return x;
}

test('a run its acceptance check failed is provable: status says so and it retires with known effects', async () => {
  const x = checkFailedFixture();
  try {
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect(status.settlement_ready).toBe('known_effects_failure');
    expect(
      x.f.work.fail(
        x.f.binding,
        'cf-retire',
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
  ['cf:check', "UPDATE task_checks SET state='passed' WHERE id='chk-1'"],
  ['cf:check', "DELETE FROM task_checks WHERE id='chk-1'"],
  ['cf:check', "UPDATE task_checks SET state='running' WHERE id='chk-1'"],
  ['cf:auto', 'UPDATE task_runtime SET auto_enabled=1'],
  [
    'cf:attempts',
    "UPDATE attempts SET state='interrupted' WHERE rowid=(SELECT min(rowid) FROM attempts)",
  ],
  [
    'cf:steps',
    "UPDATE task_steps SET state='interrupted' WHERE rowid=(SELECT min(rowid) FROM task_steps)",
  ],
])('a check-failed stop is refused when it does not hold (%s: %s)', async (code, sql) => {
  const x = checkFailedFixture();
  try {
    x.f.store.db.prepare(sql).run();
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect('settlement_ready' in status).toBe(false);
    expect(status.settlement_refused).toBe(
      'work_settlement_unsafe: Check-failed stop not provable: ' + code,
    );
    expect(() =>
      x.f.work.fail(
        x.f.binding,
        'cf-retire',
        x.admitted.request_id,
        'a'.repeat(64),
        settlementDriver(x.f),
      ),
    ).toThrow();
  } finally {
    x.f.close();
  }
});

test('a stop for any other reason is not a check-failed stop', async () => {
  const x = checkFailedFixture();
  try {
    x.f.store.db
      .prepare('UPDATE task_runtime SET auto_error=?')
      .run('Plan changed; enable a new bounded progression grant');
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect('settlement_ready' in status).toBe(false);
  } finally {
    x.f.close();
  }
});
