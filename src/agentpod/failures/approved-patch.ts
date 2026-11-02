// The bare approved-patch stop: one approved workspace write, applied through one returned patch
// call with its own receipt, in an attempt the declared per-request token bound interrupted (or
// whose runtime limit later expired). It records no evidence of its own beyond the run's rows.
import { canonical, digest, type AgentPodBinding, type WorkTask } from '../../core/index.js';
import type { Json, Row, RuleStore } from './rule.js';

/** The stop reason the token bound control records. */
export const TOKEN_BOUND_STOP = 'Provider payload exceeds declared per-request token bounds';

/** The rows the known-effects retirement read, as the approved-patch shape needs them. */
export interface ApprovedPatchRun {
  readonly session: string;
  readonly binding: AgentPodBinding;
  readonly task: WorkTask;
  readonly runtime: Row | undefined;
  readonly attempts: Row[];
  readonly ops: Row[];
  readonly calls: Row[];
  readonly attempt: Row | undefined;
  readonly op: Row | undefined;
  readonly call: Row | undefined;
  readonly approval: Row | undefined;
  readonly effect: Json | null;
  readonly originalBlock: Row | undefined;
  readonly runtimeExpired: boolean;
}

/** Whether the run is exactly the approved-patch stop. */
export function exactApprovedPatch(store: RuleStore, run: ApprovedPatchRun): boolean {
  const { session, binding, task, runtime, attempts, ops, calls, attempt, op, call, approval } =
    run;
  const { effect, originalBlock, runtimeExpired } = run;
  const bound = TOKEN_BOUND_STOP;
  return !(
    task.state !== 'blocked' ||
    !runtime ||
    !originalBlock ||
    (runtime.blocked_reason !== bound && !runtimeExpired) ||
    attempt?.error !== 'Required control failed: ' + bound ||
    runtime.auto_enabled ||
    runtime.reserved_requests ||
    runtime.reserved_tokens ||
    runtime.verification_runs ||
    attempts.length !== 1 ||
    attempt?.state !== 'interrupted' ||
    attempt.resolved_by !== null ||
    ops.length !== 1 ||
    op?.kind !== 'workspace' ||
    op.state !== 'succeeded' ||
    op.attempt_id !== attempt.id ||
    op.resolution !== 'workspace-content-receipt-v1' ||
    calls.length !== 1 ||
    call?.kind !== 'patch' ||
    call.state !== 'returned' ||
    call.helper_state !== 'stopped' ||
    call.operation_id !== op.id ||
    call.attempt_id !== attempt.id ||
    !call.result_json ||
    !approval ||
    approval.state !== 'decided' ||
    approval.decision !== 'approve' ||
    approval.operation_digest !== op.operation_digest ||
    !effect ||
    effect.version !== 1 ||
    effect.scope !== 'station-workspace' ||
    effect.call_id !== call.id ||
    effect.root_digest !== digest(binding) ||
    effect.root_digest !== call.root_digest ||
    effect.configuration_digest !== call.configuration_digest ||
    effect.input_digest !== call.input_digest ||
    canonical(effect.result) !== canonical(JSON.parse(String(call.result_json))) ||
    (effect.result as Json | undefined)?.ok !== true ||
    task.steps.filter((s) => s.attempt_id === attempt.id && s.state === 'interrupted').length !==
      1 ||
    task.steps.some((s) => !['pending', 'interrupted'].includes(s.state)) ||
    store.db.prepare('SELECT 1 FROM task_checks WHERE task_id=?').get(task.id) ||
    store.db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session)
  );
}
