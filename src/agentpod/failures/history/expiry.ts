// The boundary of an expired (or invalidated) unanswered workspace write in the historical
// read-only check: the write was offered for a decision, never answered, cancelled before it
// was sent, and its attempt was cancelled after it; nothing else happened to it.
import { canonical, digest, POLICY_DIGEST, type Operation } from '../../../core/index.js';
import { operationBinding } from '../../../execution/index.js';
import type { Row } from '../rule.js';
import { patchArgsBind, type Expiry, type History, type Unapplied } from './context.js';

type Marks = ReturnType<typeof cancellationMarks>;

/** The write's boundary, recorded in the audit, and what the rest of the history excuses. */
export function expiredBoundary(h: History, expiry: Expiry): Unapplied {
  const { operation: op, approval, offered } = expiry;
  const call = cancelledPatchCall(h, expiry);
  savedOffer(h, expiry);
  const dialog = cancelledLedgers(h, expiry, call);
  const marks = cancellationMarks(h, expiry, call, dialog);
  cancelledAttempt(h, op, marks.attemptEvent);
  if (expiry.invalidated) invalidatedByRevocation(h, expiry, marks);
  h.audit[expiry.invalidated ? 'invalidated_unanswered_boundary' : 'expired_boundary'] = {
    offered,
    operation: op,
    approval,
  };
  return { attempt: String(op.attempt_id), call, tool: String(op.tool_call_id) };
}

/** The write's one station call: a patch, prepared and cancelled unsent, exactly as offered. */
function cancelledPatchCall(h: History, expiry: Expiry): Row {
  const { require, rows, store, session, root, task, originalVerification, original } = h;
  const { operation: op, approval, offered } = expiry;
  const patchCalls = rows(
    expiry.invalidated ? 'invalidated_patch_calls' : 'expired_patch_calls',
    'SELECT * FROM station_calls WHERE operation_id=?',
    op.id,
  );
  require(patchCalls.length === 1);
  const call = patchCalls[0]!,
    args = JSON.parse(String(call.args_json));
  require(
    (expiry.invalidated
      ? task.state === 'blocked'
      : ['blocked', 'cancelled'].includes(task.state)) &&
      approval.id === offered.approval_id &&
      approval.operation_id === op.id &&
      op.id === offered.operation_id &&
      approval.session_id === session &&
      op.session_id === session &&
      offered.work_request_id === original.request_id &&
      offered.binding_digest === root &&
      offered.task_id === task.id &&
      offered.plan_revision === task.plan_revision &&
      approval.operation_digest === offered.operation_digest &&
      op.operation_digest === offered.operation_digest &&
      operationBinding(op as unknown as Operation) === op.operation_digest &&
      approval.state === (expiry.invalidated ? 'invalidated' : 'expired') &&
      approval.revision === (offered.approval_revision as number) + 1 &&
      approval.expires_at === offered.expires_at &&
      (expiry.invalidated || Number(approval.expires_at) <= Date.now()) &&
      approval.decision === null &&
      approval.decided_by === null &&
      approval.worker_epoch === op.worker_epoch &&
      approval.policy_digest === POLICY_DIGEST &&
      op.kind === 'workspace' &&
      op.connector === 'station-workspace-v1' &&
      op.replay === 'opaque' &&
      op.state === 'cancelled_before_dispatch' &&
      op.revision === 2 &&
      op.receipt === null &&
      op.resolution === null &&
      op.policy_digest === POLICY_DIGEST,
  );
  require(
    call.session_id === session &&
      call.attempt_id === op.attempt_id &&
      call.worker_epoch === op.worker_epoch &&
      call.tool_call_id === op.tool_call_id &&
      call.id === digest(['station-work-v1', session, call.worker_epoch, call.tool_call_id]) &&
      call.kind === 'patch' &&
      call.state === 'cancelled' &&
      call.revision === 2 &&
      call.root_digest === root &&
      call.configuration_digest === originalVerification.configuration_digest &&
      call.result_json === null &&
      call.task_check_id === null &&
      call.helper_state === 'none' &&
      call.helper_pid === null &&
      call.helper_identity === null &&
      call.helper_stop_json === null &&
      !store.db.prepare('SELECT 1 FROM station_units WHERE call_id=?').get(call.id),
  );
  require(patchArgsBind(op, call, args, root));
  return call;
}

/** The offer saved for the decision is exactly the one being settled. */
function savedOffer(h: History, expiry: Expiry): void {
  const { require, store } = h;
  const { approval, offered } = expiry;
  const offerRecord = store.db
    .prepare("SELECT * FROM requests WHERE actor='agentpod-work-decision-offer' AND id=?")
    .get(String(approval.id));
  require(
    offerRecord &&
      canonical(JSON.parse(String(offerRecord.response))) === canonical(offered) &&
      offerRecord.hash ===
        digest({
          work_request_id: offered.work_request_id,
          binding_digest: offered.binding_digest,
          task_id: offered.task_id,
          plan_revision: offered.plan_revision,
          operation_id: offered.operation_id,
          operation_digest: offered.operation_digest,
          approval_id: offered.approval_id,
          approval_revision: offered.approval_revision,
          expires_at: offered.expires_at,
        }),
  );
}

/** The operation's and call's own events, the replied dialog, and no answer. */
function cancelledLedgers(h: History, expiry: Expiry, call: Row): Row {
  const { require, rows, store, session } = h;
  const { operation: op, approval } = expiry;
  const operationEvents = rows(
    expiry.invalidated ? 'invalidated_operation_history' : 'expired_operation_history',
    "SELECT * FROM events WHERE session_id=? AND kind LIKE 'operation.%' AND json_extract(payload,'$.operation_id')=?",
    session,
    op.id,
  );
  require(
    operationEvents.length === 2 &&
      operationEvents.every((e) =>
        ['operation.prepared', 'operation.cancelled_before_dispatch'].includes(String(e.kind)),
      ),
  );
  const callEvents = rows(
    expiry.invalidated ? 'invalidated_call_history' : 'expired_call_history',
    "SELECT * FROM events WHERE session_id=? AND kind LIKE 'station.call.%' AND json_extract(payload,'$.call_id')=?",
    session,
    call.id,
  );
  require(
    callEvents.length === 2 &&
      callEvents.every((e) =>
        ['station.call.prepared', 'station.call.cancelled'].includes(String(e.kind)),
      ),
  );
  const dialogs = rows(
    expiry.invalidated ? 'invalidated_dialog' : 'expired_dialog',
    'SELECT * FROM approval_dialogs WHERE approval_id=?',
    approval.id,
  );
  require(
    dialogs.length === 1 &&
      dialogs[0]!.session_id === session &&
      dialogs[0]!.worker_epoch === op.worker_epoch &&
      dialogs[0]!.state === 'replied',
  );
  require(
    !store.db
      .prepare(
        "SELECT 1 FROM requests WHERE actor='agentpod-work-decision-answer' AND json_extract(response,'$.approval_id')=?",
      )
      .get(String(approval.id)),
  );
  return dialogs[0]!;
}

/** The expiry, cancellation and dialog events, once each and in order. */
function cancellationMarks(h: History, expiry: Expiry, call: Row, dialog: Row) {
  const { require, rows, session } = h;
  const { operation: op, approval } = expiry;
  const events = rows(
    expiry.invalidated ? 'invalidation_events' : 'expiry_events',
    "SELECT * FROM events WHERE session_id=? AND kind IN ('approval.expired','approval.invalidated','operation.cancelled_before_dispatch','station.call.cancelled','attempt.cancelled','approval.dialog_replied','attempt.cancel_requested','execution.revoked')",
    session,
  );
  const one = (kind: string, predicate: (p: Row) => boolean) => {
    const found = events.filter((e) => e.kind === kind && predicate(JSON.parse(String(e.payload))));
    require(found.length === 1);
    return found[0]!;
  };
  const expired = one(
    expiry.invalidated ? 'approval.invalidated' : 'approval.expired',
    (p) => p.approval_id === approval.id && p.operation_id === op.id,
  );
  const cancelled = one(
    'operation.cancelled_before_dispatch',
    (p) => p.operation_id === op.id && p.attempt_id === op.attempt_id && p.error === op.error,
  );
  const stopped = one(
    'station.call.cancelled',
    (p) => p.call_id === call.id && p.attempt_id === op.attempt_id && p.kind === 'patch',
  );
  const attemptEvent = one('attempt.cancelled', (p) => p.attempt_id === op.attempt_id);
  const dialogEvent = one(
    'approval.dialog_replied',
    (p) => p.approval_id === approval.id && p.pi_request_id === dialog.pi_request_id,
  );
  require(
    Number(expired.seq) < Number(cancelled.seq) &&
      Number(cancelled.seq) < Number(dialogEvent.seq) &&
      Number(cancelled.seq) < Number(stopped.seq) &&
      Number(stopped.seq) < Number(attemptEvent.seq),
  );
  return { one, cancelled, stopped, attemptEvent, dialogEvent };
}

/** The write's attempt was cancelled with a cancelled outcome, and nothing else. */
function cancelledAttempt(h: History, op: Row, attemptEvent: Row): void {
  const { require, store, session } = h;
  const attempt = store.db
    .prepare('SELECT * FROM attempts WHERE id=? AND session_id=?')
    .get(String(op.attempt_id), session);
  require(
    attempt &&
      attempt.state === 'cancelled' &&
      attempt.worker_epoch === op.worker_epoch &&
      attempt.result === null &&
      attempt.continues_attempt_id === null &&
      attempt.resolved_by === null &&
      store.db.prepare('SELECT 1 FROM cancellations WHERE attempt_id=?').get(String(attempt.id)),
  );
  const outcome = JSON.parse(String(attempt!.outcome)),
    eventPayload = JSON.parse(String(attemptEvent.payload));
  require(
    outcome.version === 1 &&
      outcome.stopReason === 'cancelled' &&
      outcome.failure?.code === 'attempt_cancelled' &&
      outcome.failure.kind === 'cancelled' &&
      outcome.failure.sessionId === session &&
      outcome.failure.attemptId === attempt!.id &&
      outcome.failure.retryable === false &&
      eventPayload.error === attempt!.error &&
      eventPayload.text === null &&
      canonical(eventPayload.outcome) === canonical(outcome),
  );
}

/** An invalidated write: the owner's revocation of this session cancelled its attempt. */
function invalidatedByRevocation(h: History, expiry: Expiry, marks: Marks): void {
  const { require, rows, store, session } = h;
  const { operation: op, approval } = expiry;
  const { one, cancelled, stopped, attemptEvent, dialogEvent } = marks;
  require(
    !store.db
      .prepare(
        "SELECT 1 FROM requests WHERE actor='local-operator' AND json_extract(response,'$.id')=?",
      )
      .get(String(approval.id)),
  );
  const requested = one('attempt.cancel_requested', (p) => p.attempt_id === op.attempt_id);
  const revoked = one('execution.revoked', (p) => p.owner_session === session);
  const cancellation = rows(
    'invalidated_cancellation',
    'SELECT * FROM cancellations WHERE attempt_id=?',
    op.attempt_id,
  );
  const revocations = rows(
    'invalidated_revocation',
    'SELECT * FROM session_revocations WHERE session_id=?',
    session,
  );
  require(
    cancellation.length === 1 &&
      cancellation[0]!.requested_by === 'agentpod-node' &&
      requested.causation_id === 'agentpod-revocation' &&
      revocations.length === 1,
  );
  const revocation = JSON.parse(String(revocations[0]!.receipt)),
    revokedPayload = JSON.parse(String(revoked.payload));
  require(
    Array.isArray(revocation.session_ids) &&
      revocation.session_ids.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
      Array.isArray(revocation.attempt_ids) &&
      revocation.attempt_ids.every((id: unknown) => typeof id === 'string' && id.length > 0) &&
      Array.isArray(revocation.unresolved_operations) &&
      typeof revocation.request_id === 'string' &&
      revocation.request_id.length > 0 &&
      typeof revocation.reason === 'string' &&
      revocation.reason.length > 0 &&
      revocation.session_id === session &&
      revocation.revoked === true &&
      revocation.request_id === revoked.causation_id &&
      revocation.reason === revokedPayload.reason &&
      revocation.session_ids.includes(session) &&
      revocation.attempt_ids.includes(op.attempt_id) &&
      revocation.unresolved_operations.length === 0 &&
      Number(cancelled.seq) < Number(requested.seq) &&
      Number(requested.seq) < Number(revoked.seq) &&
      Number(stopped.seq) < Number(revoked.seq) &&
      Number(revoked.seq) < Number(dialogEvent.seq) &&
      Number(dialogEvent.seq) < Number(attemptEvent.seq),
  );
}
