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

test('a verification-budget stop is provable: status says so and it retires with known effects', async () => {
  const x = verificationStopFixture();
  try {
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect(status.settlement_ready).toBe('known_effects_failure');
    expect(
      x.f.work.fail(
        x.f.binding,
        'vl-retire',
        x.admitted.request_id,
        'a'.repeat(64),
        settlementDriver(x.f),
      ),
    ).toMatchObject({ effects: 'known_effects_preserved' });
  } finally {
    x.f.close();
  }
});

test.each(['other-reason', 'running-attempt', 'unfinished-step', 'unknown-operation', 'auto-on'])(
  'a verification-budget stop is refused when it does not hold (%s)',
  async (failure) => {
    const x = verificationStopFixture();
    try {
      const db = x.f.store.db;
      if (failure === 'other-reason')
        db.prepare("UPDATE task_runtime SET blocked_reason='Task request limit reached'").run();
      if (failure === 'running-attempt')
        db.prepare(
          "UPDATE attempts SET state='interrupted' WHERE id=(SELECT id FROM attempts WHERE session_id=? LIMIT 1)",
        ).run(x.f.session);
      if (failure === 'unfinished-step')
        db.prepare("UPDATE task_steps SET state='running' WHERE id=?").run(x.task.steps[0]!.id);
      if (failure === 'auto-on') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
      if (failure === 'unknown-operation') {
        db.exec('PRAGMA foreign_keys=OFF');
        db.prepare(
          "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state) VALUES('op-x',?,(SELECT id FROM attempts WHERE session_id=? LIMIT 1),1,'c','workspace','k','a','d','t','v','tv','p','station-workspace-v1','opaque','denied')",
        ).run(x.f.session, x.f.session);
        db.exec('PRAGMA foreign_keys=ON');
      }
      const status = (await x.f.work
        .status(x.f.binding, settlementDriver(x.f))
        .catch(() => ({}))) as Record<string, unknown>;
      expect('settlement_ready' in status).toBe(false);
      expect(() =>
        x.f.work.fail(
          x.f.binding,
          'vl-retire',
          x.admitted.request_id,
          'a'.repeat(64),
          settlementDriver(x.f),
        ),
      ).toThrow();
    } finally {
      x.f.close();
    }
  },
);

test('a verification-budget stop stays provable after its runtime limit later overwrites the reason', async () => {
  const x = verificationStopFixture();
  try {
    // Staging run_54648a07: blocked on its verification budget, then its runtime ran out while it
    // sat parked, and the block reason became the runtime limit.
    x.f.work.verification.budget.block(x.f.session, 'Task runtime limit reached');
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect(status.settlement_ready).toBe('known_effects_failure');
  } finally {
    x.f.close();
  }
});

test('a runtime-limit block that was never a verification-budget stop is not this shape', async () => {
  const x = verificationStopFixture();
  try {
    x.f.store.db
      .prepare("DELETE FROM events WHERE kind='work_task.budget_blocked' AND session_id=?")
      .run(x.f.session);
    x.f.store.db
      .prepare("UPDATE task_runtime SET blocked_reason='Task runtime limit reached'")
      .run();
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect('settlement_ready' in status).toBe(false);
  } finally {
    x.f.close();
  }
});

test.each([
  [
    'vl:steps',
    "UPDATE task_steps SET state='running' WHERE task_id=(SELECT task_id FROM task_steps LIMIT 1) AND rowid=(SELECT min(rowid) FROM task_steps)",
  ],
  ['vl:auto', 'UPDATE task_runtime SET auto_enabled=1'],
  [
    'vl:attempts',
    "UPDATE attempts SET state='interrupted' WHERE rowid=(SELECT min(rowid) FROM attempts)",
  ],
])(
  'a refused verification-budget stop names the closed sub-check it misses (%s)',
  async (code, sql) => {
    const x = verificationStopFixture();
    try {
      x.f.store.db.prepare(sql).run();
      const status = (await x.f.work.status(
        x.f.binding,
        settlementDriver(x.f),
      )) as unknown as Record<string, unknown>;
      expect('settlement_ready' in status).toBe(false);
      expect(status.settlement_refused).toBe(
        'work_settlement_unsafe: Verification-budget stop not provable: ' + code,
      );
    } finally {
      x.f.close();
    }
  },
);
