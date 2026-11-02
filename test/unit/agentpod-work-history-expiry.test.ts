import { expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskDriver } from '../../src/tasks/driver.js';
import { textDigest } from '../../src/core/protocol.js';
import { settlementDriver, preparedReadOnlyPatchFixture } from './agentpod-work-helpers.js';
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

async function invalidatedReadOnlyFixture() {
  const x = preparedReadOnlyPatchFixture(60000),
    { f, managed, call, attempt, task, offer } = x;
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(
      f.session,
      'invalidated-owner-revoke',
      'Original owner stopped',
      (id) => {
        managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node');
        f.store.db
          .prepare("UPDATE station_calls SET state='cancelled',revision=revision+1 WHERE id=?")
          .run(call);
        f.store.event(f.session, 'station.call.cancelled', {
          call_id: call,
          attempt_id: attempt,
          kind: 'patch',
        });
      },
    ),
  );
  (managed as unknown as { deliver(id: string): void }).deliver(offer.approval_id);
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'invalidated-owner-revoke', 'Original owner stopped');
  return x;
}

test('invalidated unanswered history retires as non-success and preserves original offer', async () => {
  const { f, admitted, children, managed, offer } = await invalidatedReadOnlyFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'invalidated-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(
      f.store.db.prepare('SELECT state,decision FROM approvals WHERE id=?').get(offer.approval_id),
    ).toMatchObject({ state: 'invalidated', decision: null });
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each([
  ['answered', "UPDATE approvals SET decision='approve',decided_by='local-operator'"],
  ['pending', "UPDATE approvals SET state='pending'"],
  ['operation unknown', "UPDATE operations SET state='outcome_unknown'"],
  ['operation receipt', "UPDATE operations SET receipt='{}'"],
  ['helper started', "UPDATE station_calls SET helper_pid=42 WHERE kind='patch'"],
  ['foreign root', "UPDATE station_calls SET root_digest='foreign' WHERE kind='patch'"],
  ['missing offer', "DELETE FROM requests WHERE actor='agentpod-work-decision-offer'"],
  ['foreign cancellation actor', "UPDATE cancellations SET requested_by='unknown'"],
  [
    'malformed revocation arrays',
    "UPDATE session_revocations SET receipt=json_set(receipt,'$.session_ids',session_id,'$.unresolved_operations','')",
  ],
  ['missing root revocation', 'DELETE FROM session_revocations'],
  ['reordered root revocation', "UPDATE events SET seq=seq+1000 WHERE kind='execution.revoked'"],
  [
    'cancel provenance',
    "UPDATE events SET causation_id='unknown' WHERE kind='attempt.cancel_requested'",
  ],
  [
    'foreign revocation',
    "UPDATE session_revocations SET receipt=json_set(receipt,'$.session_id','foreign')",
  ],
  ['missing invalidation', "DELETE FROM events WHERE kind='approval.invalidated'"],
  ['unknown model', "UPDATE usage_observations SET status='unknown'"],
  ['prior failed check', "UPDATE task_checks SET state='failed'"],
  ['generic cancelled', "UPDATE durable_tasks SET state='cancelled'"],
])('invalidated history rejects %s', async (_name, sql) => {
  const { f, admitted, children, managed } = await invalidatedReadOnlyFixture();
  try {
    f.store.db.exec(sql);
    expect(() =>
      f.work.fail(
        f.binding,
        'invalidated-deny',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test('invalidated unanswered history cannot be labelled expired', async () => {
  const { f, admitted, children, managed, offer } = await invalidatedReadOnlyFixture();
  try {
    expect(() =>
      f.work.expire(
        f.binding,
        'not-expired',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

async function expiredReadOnlyFixture() {
  const x = preparedReadOnlyPatchFixture(),
    { f, managed, offer, call, attempt, task } = x;
  await new Promise((r) => setTimeout(r, 1010));
  managed.expire();
  f.store.transaction(() => {
    f.store.db
      .prepare("UPDATE station_calls SET state='cancelled',revision=revision+1 WHERE id=?")
      .run(call);
    f.store.event(f.session, 'station.call.cancelled', {
      call_id: call,
      attempt_id: attempt,
      kind: 'patch',
    });
    f.store.db.prepare("INSERT INTO cancellations VALUES(?,'expiry-test')").run(attempt);
  });
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'rich-expiry-revoke', 'Expired proposal stopped');
  return x;
}

test('expired unanswered patch retirement preserves prior native readonly receipts and replays', async () => {
  const { f, admitted, children, managed, offer, attempt } = await expiredReadOnlyFixture();
  try {
    const run = () =>
      f.work.expire(
        f.binding,
        'rich-expiry-retire',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'expired_approval_unapplied' });
    expect(f.store.attempt(attempt).state).toBe('cancelled');
    expect(
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(
      f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each(['closed', 'unknown-effect', 'generic-failure'])(
  'cancelled expired history recovery %s',
  async (mode) => {
    const { f, admitted, children, managed, offer } = await expiredReadOnlyFixture();
    try {
      f.store.db
        .prepare("UPDATE durable_tasks SET state='cancelled' WHERE id=?")
        .run(admitted.task_id);
      if (mode === 'unknown-effect')
        f.store.db.prepare("UPDATE operations SET state='outcome_unknown'").run();
      let cancelCalls = 0;
      const driver = {
        cancelInTransaction: () => {
          cancelCalls++;
          throw Error('Already cancelled task must not be cancelled again');
        },
      } as unknown as TaskDriver;
      const run = () =>
        mode === 'generic-failure'
          ? f.work.fail(
              f.binding,
              'cancelled-expiry-generic',
              admitted.request_id,
              'a'.repeat(64),
              driver,
            )
          : f.work.expire(
              f.binding,
              'cancelled-expiry-close',
              admitted.request_id,
              offer.request_id,
              'a'.repeat(64),
              driver,
            );
      if (mode === 'closed') {
        const receipt = run();
        expect(receipt).toMatchObject({
          state: 'cancelled',
          effects: 'expired_approval_unapplied',
        });
        f.reopen();
        expect(run()).toEqual(receipt);
      } else expect(run).toThrow();
      expect(cancelCalls).toBe(0);
    } finally {
      await managed.close();
      await children.close();
      f.close();
    }
  },
);

test.each([
  'answered',
  'unexpired',
  'revision-drift',
  'operation-dispatched',
  'historical-dispatch',
  'helper-started',
  'result-present',
  'unknown-operation',
  'unknown-model',
  'prior-mcp-corrupt',
  'prior-check-corrupt',
  'prior-child-corrupt',
  'offer-drift',
  'extra-tool',
  'extra-operation',
])('expired readonly retirement rejects %s', async (failure) => {
  const { f, admitted, children, managed, offer, attempt, call, receipts, child } =
    await expiredReadOnlyFixture();
  try {
    const db = f.store.db;
    if (failure === 'extra-operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state) SELECT 'extra',session_id,attempt_id,worker_epoch,'extra-tool',kind,'extra-action',argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,'outcome_unknown' FROM operations WHERE id=?",
      ).run(offer.operation_id);

    if (failure === 'answered')
      db.prepare("UPDATE approvals SET decision='approve',decided_by='operator' WHERE id=?").run(
        offer.approval_id,
      );
    if (failure === 'unexpired')
      db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(
        Date.now() + 60000,
        offer.approval_id,
      );
    if (failure === 'revision-drift')
      db.prepare('UPDATE approvals SET revision=revision+1 WHERE id=?').run(offer.approval_id);
    if (failure === 'operation-dispatched')
      db.prepare("UPDATE operations SET state='dispatching' WHERE id=?").run(offer.operation_id);
    if (failure === 'historical-dispatch')
      f.store.transaction(() =>
        f.store.event(f.session, 'operation.dispatching', {
          operation_id: offer.operation_id,
          attempt_id: attempt,
        }),
      );
    if (failure === 'helper-started')
      db.prepare(
        "UPDATE station_calls SET helper_state='stopped',helper_pid=42,helper_identity='observed' WHERE id=?",
      ).run(call);
    if (failure === 'result-present')
      db.prepare("UPDATE station_calls SET result_json='{}' WHERE id=?").run(call);
    if (failure === 'unknown-operation')
      db.prepare("UPDATE operations SET state='outcome_unknown' WHERE id=?").run(
        offer.operation_id,
      );
    if (failure === 'unknown-model')
      db.prepare("UPDATE usage_observations SET status='unknown' WHERE attempt_id=?").run(attempt);
    if (failure === 'prior-mcp-corrupt')
      writeFileSync(join(f.state, 'artifacts', receipts.result), 'changed');
    if (failure === 'prior-check-corrupt')
      db.prepare("UPDATE task_checks SET state='failed'").run();
    if (failure === 'prior-child-corrupt')
      db.prepare("UPDATE child_workers SET dispatch_state='interrupted' WHERE child_id=?").run(
        child.id,
      );
    if (failure === 'offer-drift')
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.approval_revision',99) WHERE actor='agentpod-work-decision-offer'",
      ).run();
    if (failure === 'extra-tool')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.started', {
          attempt_id: attempt,
          worker_epoch: 1,
          tool_call_id: 'unknown',
          tool: 'salaam_effect',
          input: '{}',
          input_digest: textDigest('{}'),
          input_truncated: false,
        }),
      );
    expect(() =>
      f.work.expire(
        f.binding,
        'reject-rich-expiry',
        admitted.request_id,
        offer.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-expiry'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM events WHERE kind='agentpod.work_expiry_evidence'").get(),
    ).toBeUndefined();
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});
