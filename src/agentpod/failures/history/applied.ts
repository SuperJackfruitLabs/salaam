// The boundary of an approved, applied workspace write in the historical read-only check: one
// returned patch call whose result, receipt and artifact agree, approved by the local operator
// through the saved offer and answer, and settled by its own events.
import {
  canonical,
  digest,
  textDigest,
  POLICY_DIGEST,
  type Operation,
} from '../../../core/index.js';
import { operationBinding } from '../../../execution/index.js';
import type { Json, Row } from '../rule.js';
import { patchArgsBind, type Applied, type AppliedPatch, type History } from './context.js';

/** The applied write's call, its parsed arguments, receipt and result. */
interface PatchRecord {
  c: Row;
  args: Json;
  effect: Json;
  result: Json;
}

/** The write's call and the tree change it made. */
export function appliedBoundary(h: History, applied: Applied): AppliedPatch {
  const patch = appliedPatchCall(h, applied);
  appliedPatchResult(h, applied, patch);
  appliedDecision(h, applied);
  return appliedEvents(h, applied, patch);
}

/** The operation, its approval and its one returned patch call, each exactly as applied. */
function appliedPatchCall(h: History, applied: Applied): PatchRecord {
  const { require, rows, store, session, root, originalVerification } = h;
  const { operation: op, approval: a } = applied;
  const cs = rows('applied_patch_calls', 'SELECT * FROM station_calls WHERE operation_id=?', op.id);
  require(cs.length === 1);
  const c = cs[0]!,
    args = JSON.parse(String(c.args_json)),
    effect = JSON.parse(String(op.receipt));
  const result = JSON.parse(String(c.result_json)),
    stop = JSON.parse(String(c.helper_stop_json));
  require(
    op.session_id === session &&
      op.kind === 'workspace' &&
      op.connector === 'station-workspace-v1' &&
      op.replay === 'opaque' &&
      op.state === 'succeeded' &&
      op.revision === 3 &&
      op.resolution === 'workspace-content-receipt-v1' &&
      op.error === null &&
      op.policy_digest === POLICY_DIGEST &&
      operationBinding(op as unknown as Operation) === op.operation_digest,
  );
  require(
    a.session_id === session &&
      a.operation_id === op.id &&
      a.operation_digest === op.operation_digest &&
      a.worker_epoch === op.worker_epoch &&
      a.policy_digest === POLICY_DIGEST &&
      a.actor_scope === 'local-operator' &&
      a.state === 'decided' &&
      a.revision === 2 &&
      a.decision === 'approve' &&
      a.decided_by === 'local-operator',
  );
  require(
    c.session_id === session &&
      c.attempt_id === op.attempt_id &&
      c.worker_epoch === op.worker_epoch &&
      c.tool_call_id === op.tool_call_id &&
      c.id === digest(['station-work-v1', session, c.worker_epoch, c.tool_call_id]) &&
      c.kind === 'patch' &&
      c.state === 'returned' &&
      c.revision === 3 &&
      c.root_digest === root &&
      c.configuration_digest === originalVerification.configuration_digest &&
      c.task_check_id === null &&
      c.helper_state === 'stopped' &&
      Number(c.helper_pid) > 0 &&
      c.helper_identity &&
      !store.db.prepare('SELECT 1 FROM station_units WHERE call_id=?').get(c.id),
  );
  require(
    canonical(stop) ===
      canonical({
        version: 1,
        scope: 'local_process_group',
        method: 'observed_exit',
        pid: c.helper_pid,
        identity: c.helper_identity,
      }),
  );
  require(patchArgsBind(op, c, args, root));
  return { c, args, effect, result };
}

/** The helper's result, the operation's receipt and the receipt artifact agree. */
function appliedPatchResult(h: History, applied: Applied, patch: PatchRecord): void {
  const { require, artifact, session, root } = h;
  const { operation: op } = applied;
  const { c, args, effect, result } = patch;
  require(
    result.version === 1 &&
      result.ok === true &&
      result.files === 1 &&
      result.path === args.path &&
      result.before_tree_digest === args.expected_tree &&
      /^[a-f0-9]{64}$/.test(String(result.tree_digest)) &&
      /^[a-f0-9]{64}$/.test(String(result.root_identity)) &&
      result.sha256 === (args.content === null ? null : textDigest(args.content as string)),
  );
  require(
    canonical(effect) ===
      canonical({
        version: 1,
        scope: 'station-workspace',
        artifact_id: effect.artifact_id,
        call_id: c.id,
        root_digest: root,
        configuration_digest: c.configuration_digest,
        input_digest: c.input_digest,
        result,
      }),
  );
  require(
    canonical(artifact(effect.artifact_id, session)) ===
      canonical({
        version: 1,
        kind: 'station-applied-patch-receipt',
        call_id: c.id,
        operation_id: op.id,
        session_id: session,
        attempt_id: c.attempt_id,
        root_digest: root,
        configuration_digest: c.configuration_digest,
        input_digest: c.input_digest,
        patch: {
          path: args.path,
          content: args.content,
          expected_tree: args.expected_tree,
          expected_hash: args.expected_hash,
        },
        result,
      }),
  );
}

/** The saved offer, its answer, the operator's decision, the dialog and the decided event. */
function appliedDecision(h: History, applied: Applied): void {
  const { require, rows, store, session, root, task } = h;
  const { operation: op, approval: a } = applied;
  const offers = rows(
    'applied_offer',
    "SELECT * FROM requests WHERE actor='agentpod-work-decision-offer' AND id=?",
    a.id,
  );
  require(offers.length === 1);
  const offered = JSON.parse(String(offers[0]!.response));
  const identity = {
    work_request_id: offered.work_request_id,
    binding_digest: root,
    task_id: task.id,
    plan_revision: task.plan_revision,
    operation_id: op.id,
    operation_digest: op.operation_digest,
    approval_id: a.id,
    approval_revision: 1,
    expires_at: a.expires_at,
  };
  const work = store.db
    .prepare('SELECT request_id FROM agentpod_work WHERE task_id=?')
    .get(task.id);
  require(
    offered.version === 1 &&
      offered.work_request_id === work?.request_id &&
      offers[0]!.hash === digest(identity) &&
      Object.entries(identity).every(([k, v]) => offered[k] === v),
  );
  const answers = rows(
    'applied_answer',
    "SELECT * FROM requests WHERE actor='agentpod-work-decision-answer' AND json_extract(response,'$.approval_id')=?",
    a.id,
  );
  require(answers.length === 1);
  const answer = JSON.parse(String(answers[0]!.response));
  require(
    answer.version === 1 &&
      answer.request_id === answers[0]!.id &&
      answer.decision_digest === digest(offered) &&
      answer.decision === 'approve',
  );
  const decision = rows(
    'applied_operator_decision',
    "SELECT * FROM requests WHERE actor='local-operator' AND id=?",
    answer.request_id,
  );
  require(
    decision.length === 1 &&
      decision[0]!.hash ===
        digest({
          kind: 'approval-decision',
          id: a.id,
          revision: 1,
          binding: op.operation_digest,
          decision: 'approve',
        }) &&
      canonical(JSON.parse(String(decision[0]!.response))) === canonical(a),
  );
  const dialogs = rows(
    'applied_dialog',
    'SELECT * FROM approval_dialogs WHERE approval_id=?',
    a.id,
  );
  require(
    dialogs.length === 1 &&
      dialogs[0]!.session_id === session &&
      dialogs[0]!.worker_epoch === op.worker_epoch &&
      dialogs[0]!.state === 'replied',
  );
  const decisions = rows(
    'applied_decision_events',
    "SELECT * FROM events WHERE session_id=? AND kind='approval.decided' AND json_extract(payload,'$.approval_id')=?",
    session,
    a.id,
  );
  require(
    decisions.length === 1 &&
      decisions[0]!.causation_id === answer.request_id &&
      JSON.parse(String(decisions[0]!.payload)).decision === 'approve',
  );
}

/** The call returned before the operation succeeded, once each. */
function appliedEvents(h: History, applied: Applied, patch: PatchRecord): AppliedPatch {
  const { require, rows, session } = h;
  const { operation: op } = applied;
  const { c, args, result } = patch;
  const returned = rows(
    'applied_patch_returned',
    "SELECT * FROM events WHERE session_id=? AND kind='station.call.returned' AND json_extract(payload,'$.call_id')=?",
    session,
    c.id,
  );
  const succeeded = rows(
    'applied_patch_succeeded',
    "SELECT * FROM events WHERE session_id=? AND kind='operation.succeeded' AND json_extract(payload,'$.operation_id')=?",
    session,
    op.id,
  );
  require(returned.length === 1 && succeeded.length === 1);
  const returnedPayload = JSON.parse(String(returned[0]!.payload)),
    succeededPayload = JSON.parse(String(succeeded[0]!.payload));
  require(
    returnedPayload.attempt_id === c.attempt_id &&
      returnedPayload.kind === 'patch' &&
      succeededPayload.attempt_id === op.attempt_id &&
      succeededPayload.error === null &&
      Number(returned[0]!.seq) < Number(succeeded[0]!.seq),
  );
  return {
    call: c,
    transition: {
      before: args.expected_tree,
      after: result.tree_digest,
      settled: Number(succeeded[0]!.seq),
    },
  };
}
