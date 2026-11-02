// Retirement of an unreported local success (abandon): the task succeeded with a fresh verified
// completion, one approved workspace write applied through its own patch call, and every check
// passed on the completion's tree. Anything else refuses; nothing here observes the live tree.
import { canonical, digest, ServiceError, type WorkTask } from '../../core/index.js';
import type { Artifacts } from '../../store/index.js';
import { requiredChecks } from '../../tasks/index.js';
import type { Row, RuleStore } from './rule.js';

/** What the abandonment check reads through. */
export interface LocalSuccessDeps {
  readonly store: RuleStore;
  readonly verification: { readonly artifacts: Pick<Artifacts, 'read'> };
}

/** The rows an unreported local success is proven from. */
interface SuccessJournal {
  completion: Row | undefined;
  attempts: Row[];
  operations: Row[];
  checks: Row[];
  calls: Row[];
}

const fail = (): never => {
  throw new ServiceError(
    'work_settlement_unsafe',
    'Only historically verified local success with known approved effects may retire',
  );
};

/** The evidence an abandonment's digest covers, in its recorded order. */
export function unreportedLocalSuccess(
  deps: LocalSuccessDeps,
  session: string,
  rootDigest: string,
  task: WorkTask,
) {
  const journal = successJournal(deps.store, session, task);
  const evidence = completionEvidence(deps, journal, task, rootDigest);
  const approval = appliedWrite(deps.store, journal, evidence, rootDigest);
  const checkEvidence = passedChecks(deps, journal, task, evidence, rootDigest);
  const { completion, attempts, operations, checks, calls } = journal;
  return { completion, evidence, attempts, operations, approval, checks, checkEvidence, calls };
}

/** The task succeeded, once, with one completed attempt, one operation and its checks. */
function successJournal(store: RuleStore, session: string, task: WorkTask): SuccessJournal {
  const runtime = store.db.prepare('SELECT * FROM task_runtime WHERE task_id=?').get(task.id);
  const completion = store.db
    .prepare('SELECT * FROM task_completions WHERE task_id=?')
    .get(task.id);
  const attempts = store.db.prepare('SELECT * FROM attempts WHERE session_id=?').all(session);
  const operations = store.db.prepare('SELECT * FROM operations WHERE session_id=?').all(session);
  const checks = store.db.prepare('SELECT * FROM task_checks WHERE task_id=?').all(task.id);
  const calls = store.db.prepare('SELECT * FROM station_calls WHERE session_id=?').all(session);
  if (
    task.state !== 'succeeded' ||
    !runtime ||
    runtime.auto_enabled ||
    runtime.reserved_requests ||
    runtime.reserved_tokens ||
    !completion ||
    completion.state !== 'succeeded' ||
    completion.exception !== null ||
    completion.plan_revision !== task.plan_revision ||
    attempts.length !== 1 ||
    attempts[0]!.state !== 'completed' ||
    operations.length !== 1 ||
    !checks.length ||
    task.steps.some((s) => s.state !== 'completed') ||
    store.db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session)
  )
    fail();
  return { completion, attempts, operations, checks, calls };
}

/** The completion's own evidence: verified, no exception, on the station's workspace. */
function completionEvidence(
  deps: LocalSuccessDeps,
  journal: SuccessJournal,
  task: WorkTask,
  rootDigest: string,
): Row {
  const artifacts = deps.verification.artifacts;
  const { completion } = journal;
  const evidence = JSON.parse(artifacts.read(String(completion!.artifact_id)));
  if (
    evidence.task_id !== task.id ||
    evidence.plan_revision !== task.plan_revision ||
    evidence.verified !== true ||
    evidence.exception !== null ||
    evidence.missing_requirements?.length !== 0 ||
    evidence.diff?.backend !== 'linux-systemd-station-v1' ||
    evidence.diff.root_digest !== rootDigest ||
    evidence.workspace?.id !== 'station:' + rootDigest ||
    evidence.workspace.digest !== completion!.workspace_digest ||
    evidence.diff.workspace_digest !== completion!.workspace_digest ||
    !Array.isArray(evidence.checks)
  )
    fail();
  return evidence;
}

/** The one operation: an approved workspace write applied through its own patch call. */
function appliedWrite(
  store: RuleStore,
  journal: SuccessJournal,
  evidence: Row,
  rootDigest: string,
): Row | undefined {
  const { attempts, operations, calls } = journal;
  const op = operations[0]!;
  const approval = store.db
    .prepare('SELECT * FROM approvals WHERE operation_id=?')
    .get(String(op.id));
  const effect = op.receipt ? JSON.parse(String(op.receipt)) : null;
  const call = calls.find((c) => c.id === effect?.call_id);
  if (
    op.kind !== 'workspace' ||
    op.state !== 'succeeded' ||
    op.attempt_id !== attempts[0]!.id ||
    op.resolution !== 'workspace-content-receipt-v1' ||
    !approval ||
    approval.state !== 'decided' ||
    approval.decision !== 'approve' ||
    approval.operation_digest !== op.operation_digest ||
    !effect ||
    effect.version !== 1 ||
    effect.scope !== 'station-workspace' ||
    !call ||
    call.kind !== 'patch' ||
    call.operation_id !== op.id ||
    call.attempt_id !== op.attempt_id ||
    effect.root_digest !== rootDigest ||
    call.root_digest !== rootDigest ||
    effect.configuration_digest !== evidence.diff.configuration_digest ||
    effect.configuration_digest !== call.configuration_digest ||
    effect.input_digest !== call.input_digest ||
    !call.result_json ||
    canonical(effect.result) !== canonical(JSON.parse(String(call.result_json))) ||
    effect.result?.ok !== true ||
    calls.some(
      (c) =>
        (c.state !== 'returned' &&
          !(
            c.kind === 'read' &&
            c.state === 'cancelled' &&
            c.tool_call_id === c.id &&
            c.result_json === null &&
            ['inspect', 'read'].includes(JSON.parse(String(c.args_json)).action)
          )) ||
        c.helper_state !== 'stopped' ||
        !['read', 'patch', 'check'].includes(String(c.kind)),
    ) ||
    calls.filter((c) => c.kind === 'patch').length !== 1
  )
    fail();
  return approval;
}

/** Every check passed on the completion's tree, and every required check is among them. */
function passedChecks(
  deps: LocalSuccessDeps,
  journal: SuccessJournal,
  task: WorkTask,
  evidence: Row,
  rootDigest: string,
): Row[] {
  const artifacts = deps.verification.artifacts;
  const { completion, checks, calls } = journal;
  const checkEvidence = checks.map((check) => {
    if (
      check.state !== 'passed' ||
      check.plan_revision !== task.plan_revision ||
      check.engine_id !== 'linux-systemd-station-v1' ||
      check.workspace_digest !== completion!.workspace_digest ||
      !check.artifact_id
    )
      fail();
    const e = JSON.parse(artifacts.read(String(check.artifact_id)));
    const c = calls.find((c) => c.id === e.call_id);
    if (
      e.version !== 1 ||
      e.backend !== 'linux-systemd-station-v1' ||
      e.check_id !== check.id ||
      e.plan_revision !== task.plan_revision ||
      e.root_digest !== rootDigest ||
      e.tree_digest !== completion!.workspace_digest ||
      e.configuration_digest !== evidence.diff.configuration_digest ||
      !c ||
      c.kind !== 'check' ||
      c.root_digest !== rootDigest ||
      c.configuration_digest !== e.configuration_digest ||
      !c.result_json ||
      digest(JSON.parse(String(c.result_json))) !== e.result_digest
    )
      fail();
    return e;
  });
  if (
    evidence.checks.some((id: unknown) => !checks.some((c) => c.id === id)) ||
    requiredChecks(task).some(
      (a) => !checks.some((c) => c.step_id === null && c.check_key === a.key),
    ) ||
    calls.some((c) => c.kind === 'check' && !checkEvidence.some((e) => e.call_id === c.id))
  )
    fail();
  return checkEvidence;
}
