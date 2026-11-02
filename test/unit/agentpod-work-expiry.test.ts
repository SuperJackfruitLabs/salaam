import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from '../../src/core/protocol.js';
import { settlementDriver, expiredWorkFixture } from './agentpod-work-helpers.js';
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

test('expired unanswered operation cancellation uses exact offer, preserves history and replays after restart', async () => {
  const { f, admitted, offer, managed } = await expiredWorkFixture();
  try {
    const request = randomUUID();
    const run = () =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(() =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        randomUUID(),
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow('saved decision');
    const receipt = run();
    expect(receipt).toMatchObject({
      state: 'cancelled',
      effects: 'expired_approval_unapplied',
      approval_id: offer.approval_id,
      operation_digest: offer.operation_digest,
    });
    const wire = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-expiry-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...wire.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      decision_request_id: offer.request_id,
      approval_id: offer.approval_id,
      operation_digest: offer.operation_digest,
      session_id: f.session,
      task_id: admitted.task_id,
      binding_digest: digest(f.binding),
    });
    expect(managed.operation(offer.operation_id).state).toBe('cancelled_before_dispatch');
    expect(managed.approval(offer.approval_id).decision).toBeNull();
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() =>
      f.work.expire(
        f.binding,
        request,
        admitted.request_id,
        offer.request_id,
        'b'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});

test.each(['outcome_unknown', 'succeeded'])(
  'expired task settlement refuses operation state %s',
  async (state) => {
    const { f, admitted, offer } = await expiredWorkFixture();
    try {
      f.store.db.prepare('UPDATE operations SET state=? WHERE id=?').run(state, offer.operation_id);
      expect(() =>
        f.work.expire(
          f.binding,
          randomUUID(),
          admitted.request_id,
          offer.request_id,
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
