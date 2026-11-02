import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ManagedWork } from '../../src/execution/managed.js';
import { AgentPodWorkDecisions } from '../../src/agentpod/work-decisions.js';
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

// Two review offers in one attempt: the first expired unanswered, the agent asked again, and the
// owner's revocation (a hub restart) invalidated the second before anyone answered it.
async function multiOfferFixture() {
  const f = fixture(),
    admitted = f.run();
  const step = f.tasks.get(admitted.task_id).steps[0]!;
  const submission = f.store.transaction(() =>
    f.store.enqueue(f.session, randomUUID(), 'Review twice', undefined, null, step.id),
  );
  const epoch = f.store.allocate(f.session, 'test');
  f.store.state(f.session, epoch, 'ready');
  f.store.claim(f.session, epoch);
  f.store.running(submission.attempt_id);
  const attempt = submission.attempt_id;
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    reply() {},
    failed() {},
    approvalTtlMs: 1000,
  });
  const tool = (phase: 'started' | 'finished', id: string) =>
    f.store.transaction(() =>
      f.store.event(f.session, 'tool.' + phase, {
        attempt_id: attempt,
        worker_epoch: epoch,
        tool_call_id: id,
        tool: 'salaam_review',
        phase,
      }),
    );
  // A closed station read, as the real run made before asking.
  f.store.db
    .prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES('read-1',?,?,?,'read-1','read',?,?,?,'{}','returned')",
    )
    .run(f.session, epoch, attempt, ...Array(3).fill('a'.repeat(64)));
  tool('started', 'review-1');
  await managed.prepare(f.session, epoch, attempt, 'review-1', 'review', 'write answer.md', 'v1');
  const offer = new AgentPodWorkDecisions(f.work, managed).list(f.binding).decisions[0]!;
  await new Promise((r) => setTimeout(r, 1010));
  managed.expire();
  tool('finished', 'review-1');
  tool('started', 'review-2');
  await managed.prepare(f.session, epoch, attempt, 'review-2', 'review', 'write files', 'v2');
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(f.session, 'restart-revoke', 'Hub restarted', (id) =>
      managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node'),
    ),
  );
  await managed.close();
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(admitted.task_id);
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.work.verification.budget.block(f.session, 'Task runtime limit reached');
  f.authority.revoke(f.binding, 'restart-revoke', 'Hub restarted');
  return { f, admitted, offer, attempt, step };
}

const expireMulti = (x: Awaited<ReturnType<typeof multiOfferFixture>>, request = 'multi-expire') =>
  x.f.work.expire(
    x.f.binding,
    request,
    x.admitted.request_id,
    x.offer.request_id,
    'a'.repeat(64),
    settlementDriver(x.f),
  );

test('several unanswered review offers, expired or invalidated by the revoke, retire and replay', async () => {
  const x = await multiOfferFixture();
  try {
    const approvals = x.f.store.db
      .prepare('SELECT state FROM approvals ORDER BY rowid')
      .all()
      .map((r) => r.state);
    expect(approvals).toEqual(['expired', 'invalidated']);
    const receipt = expireMulti(x);
    expect(receipt).toMatchObject({
      state: 'cancelled',
      effects: 'expired_approval_unapplied',
      approval_id: x.offer.approval_id,
    });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    expect(
      x.f.store.db
        .prepare("SELECT count(*) AS n FROM events WHERE kind='agentpod.work_expiry_evidence'")
        .get()!.n,
    ).toBe(1);
    x.f.reopen();
    expect(expireMulti(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'running-step',
  'two-attempts',
  'attempt-not-cancelled',
  'local-cancel',
  'not-in-revocation',
  'effect-operation',
  'operation-not-cancelled',
  'operation-other-attempt',
  'approval-decided',
  'expired-not-yet',
  'invalidated-before-revoke',
  'offer-not-expired',
  'patch-call',
  'local-call',
  'tool-after-revoke',
  'unbound-resource',
  'child',
  'checks',
])('several-offer expiry rejects %s', async (failure) => {
  const x = await multiOfferFixture();
  const { f, attempt } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_requests=1').run();
    if (failure === 'running-step') db.prepare("UPDATE task_steps SET state='running'").run();
    if (failure === 'two-attempts')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('other',?,'other-submission','cancelled',1)",
          )
          .run(f.session),
      );
    if (failure === 'attempt-not-cancelled')
      db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(attempt);
    if (failure === 'local-cancel')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'not-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.attempt_ids',json('[]'))",
      ).run();
    if (failure === 'effect-operation')
      db.prepare("UPDATE operations SET kind='effect' WHERE tool_call_id='review-2'").run();
    if (failure === 'operation-not-cancelled')
      db.prepare(
        "UPDATE operations SET state='failed_definite' WHERE tool_call_id='review-2'",
      ).run();
    if (failure === 'operation-other-attempt')
      withoutKeys(() =>
        db.prepare("UPDATE operations SET attempt_id='other' WHERE tool_call_id='review-2'").run(),
      );
    if (failure === 'approval-decided')
      db.prepare(
        "UPDATE approvals SET decision='approve' WHERE operation_id=(SELECT id FROM operations WHERE tool_call_id='review-2')",
      ).run();
    if (failure === 'expired-not-yet') {
      // Offer and approval agree, so only the expiry itself is wrong.
      const later = Date.now() + 60000;
      db.prepare('UPDATE approvals SET expires_at=? WHERE id=?').run(later, x.offer.approval_id);
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.expires_at',?) WHERE actor='agentpod-work-decision-offer'",
      ).run(later);
    }
    if (failure === 'invalidated-before-revoke')
      // Something else happened between the invalidation and the revocation's cancel request.
      db.prepare(
        "UPDATE events SET kind='inbox.changed' WHERE seq=(SELECT seq-1 FROM events WHERE kind='attempt.cancel_requested')",
      ).run();
    if (failure === 'offer-not-expired') {
      // The settled offer is the one the revocation invalidated, not one that expired.
      const second = db
        .prepare(
          "SELECT a.id,a.operation_digest,a.expires_at,o.id AS op FROM approvals a JOIN operations o ON o.id=a.operation_id WHERE o.tool_call_id='review-2'",
        )
        .get()!;
      db.prepare(
        "UPDATE requests SET response=json_set(response,'$.approval_id',?,'$.operation_id',?,'$.operation_digest',?,'$.expires_at',?) WHERE actor='agentpod-work-decision-offer'",
      ).run(
        String(second.id),
        String(second.op),
        String(second.operation_digest),
        Number(second.expires_at),
      );
    }
    if (failure === 'patch-call')
      db.prepare("UPDATE station_calls SET kind='patch' WHERE id='read-1'").run();
    if (failure === 'local-call')
      withoutKeys(() => {
        const cols = db.prepare('PRAGMA table_info(local_calls)').all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];
        const names = cols
          .filter((c) => c.notnull || c.pk || c.name === 'session_id')
          .map((c) => c.name);
        db.prepare(
          `INSERT INTO local_calls(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
        ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      });
    if (failure === 'tool-after-revoke')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.started', {
          attempt_id: attempt,
          tool_call_id: 'late',
          tool: 'salaam_review',
        }),
      );
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run(a64);
    if (failure === 'child') {
      const child = f.store.create('/tmp/child', randomUUID());
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, attempt, a64, child.id, attempt);
    }
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
          )
          .run(x.admitted.task_id, x.step.id, a64, a64),
      );
    expect(() => expireMulti(x, 'reject-multi')).toThrow();
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-expiry'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
