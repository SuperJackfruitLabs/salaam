import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from '../../src/core/protocol.js';
import { settlementDriver, knownEffectFailureFixture } from './agentpod-work-helpers.js';
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

test('known-effect retirement preserves interrupted history and effect receipt without another grant', async () => {
  const { f, admitted, offer } = await knownEffectFailureFixture();
  try {
    const request = randomUUID(),
      run = () =>
        f.work.fail(f.binding, request, admitted.request_id, 'a'.repeat(64), settlementDriver(f));
    const effect = f.store.db
      .prepare('SELECT receipt FROM operations WHERE id=?')
      .get(offer.operation_id)!.receipt;
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-failure-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...wire.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      task_id: admitted.task_id,
      session_id: f.session,
      binding_digest: digest(f.binding),
      evidence_digest: receipt.evidence_digest,
    });
    expect(f.store.db.prepare('SELECT state,resolved_by FROM attempts').get()).toMatchObject({
      state: 'interrupted',
      resolved_by: null,
    });
    expect(
      f.store.db.prepare('SELECT receipt FROM operations WHERE id=?').get(offer.operation_id)!
        .receipt,
    ).toBe(effect);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() =>
      f.work.fail(f.binding, request, admitted.request_id, 'b'.repeat(64), settlementDriver(f)),
    ).toThrow();
  } finally {
    f.close();
  }
});

test.each(['unknown', 'receipt-drift', 'unconfirmed', 'wrong-budget'])(
  'known-effect retirement rejects %s',
  async (failure) => {
    const { f, admitted, offer } = await knownEffectFailureFixture();
    try {
      if (failure === 'unknown')
        f.store.db
          .prepare("UPDATE operations SET state='outcome_unknown' WHERE id=?")
          .run(offer.operation_id);
      if (failure === 'receipt-drift')
        f.store.db.prepare("UPDATE station_calls SET result_json='{}'").run();
      if (failure === 'unconfirmed')
        f.store.db.prepare("UPDATE station_calls SET helper_state='unconfirmed'").run();
      if (failure === 'wrong-budget')
        f.store.db.prepare("UPDATE task_runtime SET blocked_reason='different failure'").run();
      expect(() =>
        f.work.fail(
          f.binding,
          randomUUID(),
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        ),
      ).toThrow();
      expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    } finally {
      f.close();
    }
  },
);

test('known-effect retirement retains original budget evidence after later elapsed runtime block', async () => {
  const { f, admitted } = await knownEffectFailureFixture();
  try {
    f.store.db
      .prepare(
        "UPDATE task_runtime SET blocked_reason='Task runtime limit reached',started_at=? WHERE task_id=?",
      )
      .run(Date.now(), admitted.task_id);
    const run = () =>
      f.work.fail(
        f.binding,
        'elapsed-failure',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(run).toThrow();
    f.store.db
      .prepare('UPDATE task_runtime SET started_at=? WHERE task_id=?')
      .run(Date.now() - f.tasks.get(admitted.task_id).limits.runtime_ms - 1, admitted.task_id);
    expect(run().effects).toBe('known_effects_preserved');
  } finally {
    f.close();
  }
});
