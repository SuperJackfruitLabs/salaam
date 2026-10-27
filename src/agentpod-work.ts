import type { StationWork } from './station-work.js';
import { StationCheckpoints } from './station-checkpoints.js';
import { requiredChecks } from './task-policy.js';
import { RATE_LIMIT_STOP, RateLimitRetries } from './rate-limit-retries.js';
import { planUpdate, toolMetadata, toolTitle } from './acp-outcome.js';
import type { Store } from './store.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import type { TaskWork, WorkTask } from './task-work.js';
import type { TaskDriver } from './task-driver.js';
import type { TaskVerification } from './task-verification.js';
import { canonical, digest, textDigest, ServiceError } from './protocol.js';
import { DIAGNOSTIC_PROFILE, NATIVE_CAPABILITIES } from './worker-boundary.js';
import { POLICY_DIGEST } from './config.js';
import { operationBinding } from './managed.js';
import { mcpAdmissionView } from './mcp-protocol.js';
import { executionEvidence } from './execution-evidence.js';
import { bindWorkTrace } from './execution-trace.js';
import {
  agentpodWorkAdmission,
  checkAgentPodWorkAdmission,
  type AgentPodWorkIdentity,
} from './agentpod-work-protocol.js';

export interface AgentPodWorkReceipt {
  version: 1;
  state: 'admitted';
  session_id: string;
  task_id: string;
  request_id: string;
  binding_digest: string;
  plan_revision: number;
}
/** Private control-only, not advertised. The authenticated control
 * adapter must supply its own session and independently admitted work identity.
 * This receipt records task admission, never successful work or permission to run.
 */
/** Extra progression steps a strict grant may carry, only ever spent on re-running a step. */
export const RERUN_ALLOWANCE = 3;
export class AgentPodWork {
  constructor(
    readonly store: Store,
    readonly authority: AgentPodAuthority,
    readonly tasks: TaskWork,
    readonly verification: TaskVerification,
  ) {}

  private owned(binding: unknown) {
    const root = this.authority.inspect(binding);
    const row = this.store.db
      .prepare('SELECT * FROM agentpod_work WHERE session_id=?')
      .get(root.session_id);
    if (!row) throw new ServiceError('work_missing', 'Admitted work required');
    const admission = agentpodWorkAdmission(JSON.parse(String(row.admission_json)));
    if (canonical(admission.binding) !== canonical(root.binding))
      throw new ServiceError('work_authority_mismatch', 'Exact work authority required');
    return { root, row, task: this.tasks.get(String(row.task_id)) };
  }
  private assertPlan(task: WorkTask, admission: unknown): void {
    const plan = {
      objective: task.objective,
      constraints: task.constraints,
      acceptance: task.acceptance,
      ...(task.completion_gate ? { completion_gate: task.completion_gate } : {}),
      deliverables: task.deliverables,
      limits: task.limits,
      steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
        key,
        title,
        instruction,
        depends_on,
        checks,
      })),
    };
    if (digest(plan) !== agentpodWorkAdmission(admission).work.plan_digest)
      throw new ServiceError('work_plan_changed', 'Task plan differs from original work admission');
  }
  /** Read committed evidence with historical ownership, without a live grant,
   * native recheck, task progression, or model dispatch. */
  evidence(binding: unknown) {
    return this.store.transaction(() => {
      const { root, row, task } = this.owned(binding);
      const admission = agentpodWorkAdmission(JSON.parse(String(row.admission_json)));
      return executionEvidence(
        this.store,
        this.verification.artifacts,
        admission,
        task.id,
        root.session_id,
      );
    });
  }
  trace(binding: unknown, traceparent: unknown) {
    const { root, row } = this.owned(binding);
    const record = bindWorkTrace(
      this.store,
      root.session_id,
      String(row.request_id),
      digest(root.binding),
      traceparent,
    );
    return {
      version: record.version,
      traceparent: record.traceparent,
      authority: record.authority,
    };
  }
  evidenceArtifacts(binding: unknown, input: unknown) {
    if (
      !Array.isArray(input) ||
      input.length < 1 ||
      input.length > 16 ||
      input.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) ||
      new Set(input).size !== input.length
    )
      throw new ServiceError(
        'invalid_evidence_artifacts',
        'Select one to sixteen distinct artifact IDs',
      );
    return this.store.transaction(() => {
      const { root, row, task } = this.owned(binding);
      const admission = agentpodWorkAdmission(JSON.parse(String(row.admission_json)));
      const evidence = executionEvidence(
        this.store,
        this.verification.artifacts,
        admission,
        task.id,
        root.session_id,
      );
      let total = 0;
      const artifacts = input.map((id: string) => {
        const artifact = evidence.artifacts.find((a) => a.id === id);
        if (!artifact || !['proposed', 'produced', 'integrated'].includes(artifact.disposition))
          throw new ServiceError(
            'evidence_artifact_unavailable',
            'Only selected produced work artifacts may be exported',
          );
        const content = this.verification.artifacts.read(id);
        total += Buffer.byteLength(content);
        if (total > 4 * 1024 * 1024)
          throw new ServiceError(
            'evidence_artifact_too_large',
            'Selected source artifacts exceed four MiB',
          );
        return {
          id: String(artifact.id),
          session_id: String(artifact.session_id),
          digest: String(artifact.digest),
          bytes: Number(artifact.bytes),
          disposition: artifact.disposition,
          content_base64: Buffer.from(content, 'utf8').toString('base64'),
        };
      });
      return { schema_version: 'salaam-execution-artifacts/v1' as const, evidence, artifacts };
    });
  }
  /** Explicit private operator settlement, restricted to work that never dispatched.
   * The Hub independently verifies the original producer terminal run/lease and
   * supplies its immutable digest. This is never success or authority renewal. */
  settle(
    binding: unknown,
    request: string,
    workRequest: string,
    terminalDigest: string,
    driver: TaskDriver,
  ) {
    const { root, row, task } = this.owned(binding);
    if (workRequest !== row.request_id || !/^[a-f0-9]{64}$/.test(terminalDigest))
      throw new ServiceError(
        'work_settlement_conflict',
        'Exact original work and producer terminal digest required',
      );
    const stopped = () => {
      const current = this.authority.inspect(binding);
      if (
        !current.revoked ||
        current.authorized ||
        !current.owned_execution_stopped ||
        current.unresolved_operations.length ||
        current.active_attempts.length ||
        current.interrupted_attempts.length
      )
        throw new ServiceError(
          'work_settlement_unsafe',
          'Exact revoked root must have confirmed stopped resources and no uncertainty',
        );
    };
    stopped();
    return this.store.request(
      'agentpod-work-settlement',
      workRequest,
      {
        request_id: request,
        binding: root.binding,
        work_request_id: workRequest,
        producer_terminal_digest: terminalDigest,
      },
      () => {
        stopped();
        this.assertPlan(task, JSON.parse(String(row.admission_json)));
        const runtime = this.store.db
          .prepare('SELECT * FROM task_runtime WHERE task_id=?')
          .get(task.id);
        if (
          task.state !== 'accepted' ||
          task.steps.some((s) => s.state !== 'pending') ||
          !runtime ||
          runtime.auto_enabled ||
          runtime.requests_spent ||
          runtime.reserved_requests ||
          runtime.reserved_tokens ||
          runtime.token_units ||
          runtime.verification_runs ||
          runtime.started_at !== null ||
          this.store.db.prepare('SELECT 1 FROM attempts WHERE session_id=?').get(root.session_id) ||
          this.store.db
            .prepare('SELECT 1 FROM operations WHERE session_id=?')
            .get(root.session_id) ||
          this.store.db
            .prepare('SELECT 1 FROM child_tasks WHERE parent_session=?')
            .get(root.session_id) ||
          this.store.db.prepare('SELECT 1 FROM task_grants WHERE task_id=?').get(task.id) ||
          this.store.db.prepare('SELECT 1 FROM task_checks WHERE task_id=?').get(task.id)
        )
          throw new ServiceError(
            'work_settlement_unsafe',
            'Only never-dispatched accepted work can be settled by this protocol',
          );
        driver.cancelInTransaction(task.id, task.revision, stopped);
        const receipt = {
          version: 1 as const,
          state: 'cancelled' as const,
          effects: 'never_dispatched' as const,
          request_id: request,
          work_request_id: workRequest,
          session_id: root.session_id,
          task_id: task.id,
          plan_revision: task.plan_revision,
          binding_digest: digest(root.binding),
          producer_terminal_digest: terminalDigest,
        };
        this.store.event(root.session_id, 'agentpod.work_settled', receipt, request);
        return receipt;
      },
    );
  }
  expire(
    binding: unknown,
    request: string,
    workRequest: string,
    decisionRequest: string,
    terminalDigest: string,
    driver: TaskDriver,
  ) {
    const { root, row, task } = this.owned(binding);
    if (workRequest !== row.request_id || !/^[a-f0-9]{64}$/.test(terminalDigest))
      throw new ServiceError(
        'work_settlement_conflict',
        'Exact original work and terminal digest required',
      );
    const saved = this.store.db
      .prepare(
        "SELECT response FROM requests WHERE actor='agentpod-work-decision-offer' AND json_extract(response,'$.request_id')=?",
      )
      .get(decisionRequest);
    const offered = saved ? JSON.parse(String(saved.response)) : null;
    if (
      !offered ||
      offered.work_request_id !== workRequest ||
      offered.task_id !== task.id ||
      offered.binding_digest !== digest(root.binding) ||
      offered.plan_revision !== task.plan_revision
    )
      throw new ServiceError('approval_mismatch', 'Exact original saved decision required');
    const stopped = () => {
      const current = this.authority.inspect(binding);
      if (
        !current.revoked ||
        current.authorized ||
        !current.owned_execution_stopped ||
        current.unresolved_operations.length ||
        current.active_attempts.length ||
        current.interrupted_attempts.length
      )
        throw new ServiceError(
          'work_settlement_unsafe',
          'Exact revoked root must have confirmed stopped resources and no uncertainty',
        );
    };
    stopped();
    return this.store.request(
      'agentpod-work-expiry',
      workRequest,
      {
        request_id: request,
        binding: root.binding,
        work_request_id: workRequest,
        decision_request_id: decisionRequest,
        producer_terminal_digest: terminalDigest,
      },
      () => {
        stopped();
        this.assertPlan(task, JSON.parse(String(row.admission_json)));
        const approval = this.store.db
          .prepare('SELECT * FROM approvals WHERE id=?')
          .get(offered.approval_id);
        const op = this.store.db
          .prepare('SELECT * FROM operations WHERE id=?')
          .get(offered.operation_id);
        const runtime = this.store.db
          .prepare('SELECT * FROM task_runtime WHERE task_id=?')
          .get(task.id);
        const simple = !(
          !approval ||
          !op ||
          approval.session_id !== root.session_id ||
          op.session_id !== root.session_id ||
          approval.operation_id !== op.id ||
          approval.operation_digest !== offered.operation_digest ||
          op.operation_digest !== offered.operation_digest ||
          approval.expires_at !== offered.expires_at ||
          Number(approval.expires_at) > Date.now() ||
          approval.state !== 'expired' ||
          Number(approval.revision) !== offered.approval_revision + 1 ||
          approval.decision !== null ||
          op.state !== 'cancelled_before_dispatch' ||
          !this.store.db
            .prepare("SELECT 1 FROM attempts WHERE id=? AND session_id=? AND state='cancelled'")
            .get(String(op.attempt_id), root.session_id) ||
          task.state !== 'blocked' ||
          task.steps.some((s) => !['pending', 'cancelled'].includes(s.state)) ||
          !runtime ||
          runtime.auto_enabled ||
          runtime.reserved_requests ||
          runtime.reserved_tokens ||
          runtime.verification_runs ||
          this.store.db
            .prepare('SELECT 1 FROM operations WHERE session_id=? AND id!=?')
            .get(root.session_id, String(op.id)) ||
          this.store.db
            .prepare("SELECT 1 FROM attempts WHERE session_id=? AND (id!=? OR state!='cancelled')")
            .get(root.session_id, String(op.attempt_id)) ||
          this.store.db
            .prepare('SELECT 1 FROM child_tasks WHERE parent_session=?')
            .get(root.session_id) ||
          this.store.db.prepare('SELECT 1 FROM task_checks WHERE task_id=?').get(task.id) ||
          this.store.db
            .prepare(
              "SELECT 1 FROM station_calls WHERE session_id=? AND kind!='read' AND (operation_id IS NULL OR operation_id!=? OR state!='cancelled' OR helper_state!='none')",
            )
            .get(root.session_id, String(op.id))
        );
        const history =
          !simple && approval && op
            ? this.historicalKnownReadOnlyFailure(root.binding, task, runtime, {
                operation: op,
                approval,
                offered,
              })
            : null;
        const multi =
          !simple && !history
            ? this.multiOfferReviewExpiry(root.session_id, task, runtime, offered)
            : null;
        if (!simple && !history && !multi)
          throw new ServiceError(
            'work_settlement_unsafe',
            'Only exact expired unanswered unapplied work with closed historical evidence can be settled',
          );
        if (history || multi)
          this.store.event(
            root.session_id,
            'agentpod.work_expiry_evidence',
            {
              version: 1,
              task_id: task.id,
              decision_request_id: decisionRequest,
              evidence_digest: digest({
                binding: root.binding,
                request_id: request,
                work_request_id: workRequest,
                producer_terminal_digest: terminalDigest,
                ...(history ? { history } : { several_review_offers: multi }),
              }),
            },
            request,
          );
        if (task.state !== 'cancelled') driver.cancelInTransaction(task.id, task.revision, stopped);
        const receipt = {
          version: 1 as const,
          state: 'cancelled' as const,
          effects: 'expired_approval_unapplied' as const,
          request_id: request,
          work_request_id: workRequest,
          decision_request_id: decisionRequest,
          approval_id: offered.approval_id,
          operation_digest: offered.operation_digest,
          session_id: root.session_id,
          task_id: task.id,
          plan_revision: task.plan_revision,
          binding_digest: digest(root.binding),
          producer_terminal_digest: terminalDigest,
        };
        this.store.event(root.session_id, 'agentpod.work_expired', receipt, request);
        return receipt;
      },
    );
  }
  /** Several unanswered review offers in one attempt: each one expired, or was invalidated by the
   * owner's revocation (a hub restart), before anyone answered it. Every operation was cancelled
   * before dispatch, the only station calls are closed reads, and nothing ran after the revoke. */
  private multiOfferReviewExpiry(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    offered: Record<string, any>,
  ) {
    if (
      task.state !== 'blocked' ||
      task.steps.some((s) => !['pending', 'cancelled'].includes(s.state)) ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs
    )
      return null;
    const attempts = this.store.db
      .prepare('SELECT * FROM attempts WHERE session_id=?')
      .all(session);
    const attempt = attempts[0];
    if (
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.resolved_by !== null ||
      attempt.result !== null
    )
      return null;
    // Cancelled by the node's revocation of this session, which names exactly this attempt.
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt.id));
    const revocations = this.store.db
      .prepare('SELECT * FROM session_revocations WHERE session_id=?')
      .all(session);
    if (
      cancellations.length !== 1 ||
      cancellations[0]!.requested_by !== 'agentpod-node' ||
      revocations.length !== 1
    )
      return null;
    const revocation = JSON.parse(String(revocations[0]!.receipt));
    if (
      revocation.revoked !== true ||
      canonical(revocation.attempt_ids) !== canonical([attempt.id]) ||
      canonical(revocation.unresolved_operations) !== canonical([])
    )
      return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload,causation_id FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const one = (kind: string) => {
      const found = events.filter((e) => e.kind === kind);
      return found.length === 1 ? found[0]! : null;
    };
    const requested = one('attempt.cancel_requested'),
      revoked = one('execution.revoked'),
      cancelled = one('attempt.cancelled');
    if (
      !requested ||
      !revoked ||
      !cancelled ||
      requested.causation_id !== 'agentpod-revocation' ||
      !(
        Number(requested.seq) < Number(revoked.seq) && Number(revoked.seq) < Number(cancelled.seq)
      ) ||
      events.some((e) => e.kind === 'tool.started' && Number(e.seq) > Number(requested.seq))
    )
      return null;
    // Two or more review operations, all on this attempt, all cancelled before dispatch.
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (
      ops.length < 2 ||
      !ops.some((op) => op.id === offered.operation_id) ||
      ops.some(
        (op) =>
          op.kind !== 'review' ||
          op.state !== 'cancelled_before_dispatch' ||
          op.attempt_id !== attempt.id,
      )
    )
      return null;
    const of = (e: Record<string, any>) => JSON.parse(String(e.payload));
    // The invalidations the revocation made: the contiguous block of invalidated approvals and
    // their cancelled operations that ends at the revocation's own cancel request.
    const block = new Set<string>();
    for (let n = events.indexOf(requested) - 1; n >= 0; n--) {
      const e = events[n]!;
      if (e.kind === 'operation.cancelled_before_dispatch') continue;
      if (e.kind !== 'approval.invalidated') break;
      block.add(String(of(e).approval_id));
    }
    const offers = [];
    for (const op of ops) {
      const approvals = this.store.db
        .prepare('SELECT * FROM approvals WHERE operation_id=?')
        .all(String(op.id));
      const approval = approvals[0];
      if (
        approvals.length !== 1 ||
        !approval ||
        approval.session_id !== session ||
        approval.decision !== null ||
        approval.operation_digest !== op.operation_digest
      )
        return null;
      if (approval.state === 'expired') {
        const expired = events.findIndex(
          (e) => e.kind === 'approval.expired' && of(e).approval_id === approval.id,
        );
        if (
          expired < 0 ||
          Number(approval.expires_at) > Date.now() ||
          events[expired + 1]?.kind !== 'operation.cancelled_before_dispatch' ||
          of(events[expired + 1]!).operation_id !== op.id
        )
          return null;
      } else if (approval.state !== 'invalidated' || !block.has(String(approval.id))) return null;
      offers.push({ operation_id: op.id, approval_id: approval.id, state: approval.state });
    }
    // The decision being settled is one that expired unanswered, exactly as it was offered.
    const settled = offers.find((o) => o.approval_id === offered.approval_id);
    const approval = this.store.db
      .prepare('SELECT * FROM approvals WHERE id=?')
      .get(String(offered.approval_id));
    if (
      settled?.state !== 'expired' ||
      !approval ||
      approval.operation_digest !== offered.operation_digest ||
      approval.expires_at !== offered.expires_at
    )
      return null;
    const units = this.noLedgeredEffects(session, task, { operations: true, stationReads: true });
    if (!units) return null;
    return {
      revocation,
      offers,
      reads: this.store.db
        .prepare('SELECT id,input_digest FROM station_calls WHERE session_id=? ORDER BY id')
        .all(session),
      unbound_stopped_units: units,
    };
  }
  /** An attempt the request-budget control interrupted after its operator MCP calls kept failing:
   * every call is journaled as failed or tool_error, the only station calls are closed reads, and
   * no tool ran after the stop. The failed calls are preserved as the known effects. */
  private requestBudgetStopFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    const reason = 'Required control failed: No model request budget remains',
      // Picked by state, never by row order; the count below rejects any other attempt.
      attempt = attempts.find((a) => a.state === 'interrupted');
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.error !== reason ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'interrupted' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    // Stopped by the budget control, not cancelled by anyone.
    if (
      this.store.db
        .prepare('SELECT 1 FROM cancellations WHERE attempt_id=?')
        .get(String(attempt.id))
    )
      return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const of = (e: Record<string, any>) => JSON.parse(String(e.payload));
    const unhealthy = events.filter((e) => e.kind === 'worker.unhealthy'),
      interrupted = events.filter((e) => e.kind === 'attempt.interrupted');
    if (
      unhealthy.length !== 1 ||
      interrupted.length !== 1 ||
      of(unhealthy[0]!).error !== reason ||
      of(interrupted[0]!).attempt_id !== attempt.id ||
      of(interrupted[0]!).error !== reason ||
      Number(unhealthy[0]!.seq) >= Number(interrupted[0]!.seq)
    )
      return null;
    // Tools: operator MCP (catalog reads, or a journaled failed call) and station reads, every one
    // closed before the stop. Tools may run in parallel, and a call does not name its tool, so each
    // call takes an open operator MCP tool that has none yet; a call with no such tool is refused.
    const calls: Record<string, any>[] = [];
    const open = new Map<string, { tool: string; calls: number }>();
    for (const e of events) {
      if (!['tool.started', 'tool.finished', 'operator_mcp.call'].includes(String(e.kind)))
        continue;
      const payload = of(e);
      if (Number(e.seq) >= Number(unhealthy[0]!.seq) || payload.attempt_id !== attempt.id)
        return null;
      if (e.kind === 'tool.started') {
        if (
          !['salaam_operator_mcp', 'salaam_station'].includes(String(payload.tool)) ||
          typeof payload.tool_call_id !== 'string' ||
          !payload.tool_call_id ||
          payload.parent_tool_call_id
        )
          return null;
        open.set(payload.tool_call_id, { tool: String(payload.tool), calls: 0 });
      } else if (e.kind === 'tool.finished') {
        const started = open.get(String(payload.tool_call_id));
        if (!started || payload.tool !== started.tool) return null;
        open.delete(String(payload.tool_call_id));
      } else {
        const free = [...open.values()].find(
          (t) => t.tool === 'salaam_operator_mcp' && t.calls === 0,
        );
        if (!free || !['failed', 'tool_error'].includes(String(payload.outcome))) return null;
        free.calls++;
        calls.push({ seq: e.seq, ...payload });
      }
    }
    if (open.size) return null;
    const units = this.noLedgeredEffects(session, task, { stationReads: true });
    if (!units) return null;
    return {
      unhealthy: unhealthy[0],
      interrupted: interrupted[0],
      operator_mcp_calls: calls,
      reads: this.store.db
        .prepare('SELECT id,input_digest FROM station_calls WHERE session_id=? ORDER BY id')
        .all(session),
      unbound_stopped_units: units,
    };
  }
  /** An attempt the task runtime limit stopped while its approved workspace writes were all
   * refused by the protected filesystem before their mutation boundary. Each write is journaled
   * failed_definite: refused by the station helper after its approval, or (the one still waiting
   * when the stop came) cancelled before dispatch with its approval invalidated. Every other
   * station call is a closed read, every operator MCP call is closed inside its own tool, and no
   * tool started after the stop. The refused writes and the reads are the known effects. */
  private runtimeStopRefusedWritesFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    const reason = 'Task runtime limit reached',
      refused = 'Protected filesystem refused before its mutation boundary',
      notSent = 'Workspace apply was cancelled before dispatch',
      attempt = attempts[0];
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.blocked_reason !== reason ||
      runtime.started_at === null ||
      !Number.isFinite(Number(runtime.started_at)) ||
      Date.now() - Number(runtime.started_at) < task.limits.runtime_ms ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.error !== 'Attempt aborted' ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'cancelled' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    // Stopped by the runtime limit's own task stop, not by anyone.
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt.id));
    if (cancellations.length !== 1 || cancellations[0]!.requested_by !== 'task-stop') return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const of = (e: Record<string, any>) => JSON.parse(String(e.payload));
    const blocks = events.filter(
        (e) => e.kind === 'work_task.budget_blocked' && of(e).reason === reason,
      ),
      requested = events.filter((e) => e.kind === 'attempt.cancel_requested'),
      cancelled = events.filter((e) => e.kind === 'attempt.cancelled');
    if (
      blocks.length !== 1 ||
      requested.length !== 1 ||
      cancelled.length !== 1 ||
      of(requested[0]!).attempt_id !== attempt.id ||
      of(cancelled[0]!).attempt_id !== attempt.id ||
      !(
        Number(blocks[0]!.seq) < Number(requested[0]!.seq) &&
        Number(requested[0]!.seq) < Number(cancelled[0]!.seq)
      )
    )
      return null;
    // Every operation is a workspace write on this attempt that never crossed its boundary.
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = this.store.db
      .prepare('SELECT * FROM station_calls WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (!ops.length) return null;
    const writes: Record<string, unknown>[] = [];
    for (const op of ops) {
      const approval = this.store.db
        .prepare('SELECT * FROM approvals WHERE operation_id=?')
        .get(String(op.id));
      const linked = calls.filter((c) => c.operation_id === op.id);
      const call = linked[0];
      if (
        op.kind !== 'workspace' ||
        op.attempt_id !== attempt.id ||
        op.state !== 'failed_definite' ||
        linked.length !== 1 ||
        !call ||
        call.kind !== 'patch' ||
        call.attempt_id !== attempt.id ||
        !approval ||
        approval.operation_digest !== op.operation_digest
      )
        return null;
      if (op.error === refused) {
        // Approved, sent, and refused by the helper before it could change anything.
        if (
          approval.state !== 'decided' ||
          approval.decision !== 'approve' ||
          call.state !== 'failed' ||
          call.helper_state !== 'stopped' ||
          !call.result_json ||
          canonical(JSON.parse(String(call.result_json))) !==
            canonical({ code: 'station_files_changed' })
        )
          return null;
      } else if (op.error === notSent) {
        // Still waiting when the stop came: never sent to the helper at all.
        if (
          approval.state !== 'invalidated' ||
          call.state !== 'cancelled' ||
          call.helper_state !== 'none' ||
          call.result_json !== null
        )
          return null;
      } else return null;
      writes.push({
        operation_id: op.id,
        operation_digest: op.operation_digest,
        error: op.error,
        approval: approval.state,
        call_id: call.id,
        call_state: call.state,
      });
    }
    // The remaining station calls are closed reads.
    const reads = calls.filter((c) => c.operation_id === null);
    if (reads.some((c) => c.kind !== 'read' || c.state !== 'returned')) return null;
    // Tools: station calls and operator MCP tools, every one closed, none started after the stop,
    // each operator MCP call inside an open operator MCP tool that has no call yet.
    const mcp: Record<string, any>[] = [];
    const open = new Map<string, { tool: string; calls: number }>();
    for (const e of events) {
      if (!['tool.started', 'tool.finished', 'operator_mcp.call'].includes(String(e.kind)))
        continue;
      const payload = of(e);
      if (Number(e.seq) >= Number(cancelled[0]!.seq) || payload.attempt_id !== attempt.id)
        return null;
      if (e.kind === 'tool.started') {
        if (
          Number(e.seq) >= Number(requested[0]!.seq) ||
          !['salaam_operator_mcp', 'salaam_station'].includes(String(payload.tool)) ||
          typeof payload.tool_call_id !== 'string' ||
          !payload.tool_call_id ||
          payload.parent_tool_call_id
        )
          return null;
        open.set(payload.tool_call_id, { tool: String(payload.tool), calls: 0 });
      } else if (e.kind === 'tool.finished') {
        const started = open.get(String(payload.tool_call_id));
        if (!started || payload.tool !== started.tool) return null;
        open.delete(String(payload.tool_call_id));
      } else {
        const free = [...open.values()].find(
          (t) => t.tool === 'salaam_operator_mcp' && t.calls === 0,
        );
        if (!free || !['returned', 'failed', 'tool_error'].includes(String(payload.outcome)))
          return null;
        free.calls++;
        mcp.push({ seq: e.seq, ...payload });
      }
    }
    if (open.size) return null;
    const units = this.noLedgeredEffects(session, task, { operations: true, stationCalls: true });
    if (!units) return null;
    return {
      blocked: blocks[0],
      cancel_requested: requested[0],
      cancelled: cancelled[0],
      refused_writes: writes,
      reads: reads.map((c) => ({ id: c.id, input_digest: c.input_digest })),
      operator_mcp_calls: mcp,
      unbound_stopped_units: units,
    };
  }
  /** An attempt the request-budget control interrupted after its approved work had succeeded:
   * each workspace write approved, applied through exactly one returned patch call and recorded
   * with that call's own receipt, and any review approved and read-only. Every other station call
   * is a closed read or a returned check whose unit stopped with a complete proof, and no tool ran
   * after the stop. The applied writes and the review are the known effects. */
  private requestBudgetStopKnownEffectsFailure(
    session: string,
    binding: unknown,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    const reason = 'Required control failed: No model request budget remains',
      attempt = attempts.find((a) => a.state === 'interrupted');
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.error !== reason ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'interrupted' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    if (
      this.store.db
        .prepare('SELECT 1 FROM cancellations WHERE attempt_id=?')
        .get(String(attempt.id))
    )
      return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const of = (e: Record<string, any>) => JSON.parse(String(e.payload));
    const unhealthy = events.filter((e) => e.kind === 'worker.unhealthy'),
      interrupted = events.filter((e) => e.kind === 'attempt.interrupted');
    if (
      unhealthy.length !== 1 ||
      interrupted.length !== 1 ||
      of(unhealthy[0]!).error !== reason ||
      of(interrupted[0]!).attempt_id !== attempt.id ||
      of(interrupted[0]!).error !== reason ||
      Number(unhealthy[0]!.seq) >= Number(interrupted[0]!.seq)
    )
      return null;
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = this.store.db
      .prepare('SELECT * FROM station_calls WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (!ops.length) return null;
    const root = digest(binding),
      effects: Record<string, unknown>[] = [];
    for (const op of ops) {
      const approval = this.store.db
        .prepare('SELECT * FROM approvals WHERE operation_id=?')
        .get(String(op.id));
      const linked = calls.filter((c) => c.operation_id === op.id);
      if (
        op.attempt_id !== attempt.id ||
        op.state !== 'succeeded' ||
        !approval ||
        approval.state !== 'decided' ||
        approval.decision !== 'approve' ||
        approval.operation_digest !== op.operation_digest ||
        !op.receipt
      )
        return null;
      if (op.kind === 'workspace') {
        const call = linked[0],
          effect = JSON.parse(String(op.receipt));
        if (
          op.resolution !== 'workspace-content-receipt-v1' ||
          // station_calls.operation_id is unique, so a write has at most one call.
          !call ||
          call.kind !== 'patch' ||
          call.state !== 'returned' ||
          call.helper_state !== 'stopped' ||
          call.attempt_id !== attempt.id ||
          !call.result_json ||
          effect.version !== 1 ||
          effect.scope !== 'station-workspace' ||
          effect.call_id !== call.id ||
          effect.root_digest !== root ||
          effect.root_digest !== call.root_digest ||
          effect.configuration_digest !== call.configuration_digest ||
          effect.input_digest !== call.input_digest ||
          canonical(effect.result) !== canonical(JSON.parse(String(call.result_json))) ||
          effect.result?.ok !== true
        )
          return null;
        effects.push({
          operation_id: op.id,
          operation_digest: op.operation_digest,
          call_id: call.id,
          effect,
        });
      } else if (op.kind === 'review') {
        if (
          op.connector !== 'local-review-v1' ||
          op.replay !== 'read-only' ||
          op.resolution !== 'local-review-receipt' ||
          linked.length
        )
          return null;
        effects.push({ operation_id: op.id, operation_digest: op.operation_digest, review: true });
      } else return null;
    }
    // Other station calls: closed reads, or returned checks whose own unit stopped with proof.
    const others = calls.filter((c) => c.operation_id === null);
    if (
      others.some(
        (c) =>
          c.state !== 'returned' ||
          !(c.kind === 'read' || (c.kind === 'check' && c.helper_state === 'stopped')),
      )
    )
      return null;
    const checks = others.filter((c) => c.kind === 'check').map((c) => String(c.id));
    const mcp: Record<string, any>[] = [];
    const open = new Map<string, { tool: string; calls: number }>();
    for (const e of events) {
      if (!['tool.started', 'tool.finished', 'operator_mcp.call'].includes(String(e.kind)))
        continue;
      const payload = of(e);
      if (Number(e.seq) >= Number(unhealthy[0]!.seq) || payload.attempt_id !== attempt.id)
        return null;
      if (e.kind === 'tool.started') {
        if (
          !['salaam_operator_mcp', 'salaam_station', 'salaam_review'].includes(
            String(payload.tool),
          ) ||
          typeof payload.tool_call_id !== 'string' ||
          !payload.tool_call_id ||
          payload.parent_tool_call_id
        )
          return null;
        open.set(payload.tool_call_id, { tool: String(payload.tool), calls: 0 });
      } else if (e.kind === 'tool.finished') {
        const started = open.get(String(payload.tool_call_id));
        if (!started || payload.tool !== started.tool) return null;
        open.delete(String(payload.tool_call_id));
      } else {
        const free = [...open.values()].find(
          (t) => t.tool === 'salaam_operator_mcp' && t.calls === 0,
        );
        if (!free || !['returned', 'failed', 'tool_error'].includes(String(payload.outcome)))
          return null;
        free.calls++;
        mcp.push({ seq: e.seq, ...payload });
      }
    }
    if (open.size) return null;
    const units = this.noLedgeredEffects(session, task, {
      operations: true,
      stationCalls: true,
      checkUnits: checks,
    });
    if (!units) return null;
    return {
      unhealthy: unhealthy[0],
      interrupted: interrupted[0],
      known_effects: effects,
      station_calls: others.map((c) => ({ id: c.id, kind: c.kind, input_digest: c.input_digest })),
      operator_mcp_calls: mcp,
      unbound_stopped_units: units,
    };
  }
  /** A disjoint failure profile: the native child was denied before any effect
   * ledger was created. Stopped resources alone never establish zero effects. */
  private zeroEffectConcurrencyFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    const reason = 'Task concurrency limit reached',
      attempt = attempts[0];
    if (
      task.state !== 'blocked' ||
      task.limits.concurrency !== 1 ||
      !runtime ||
      runtime.blocked_reason !== reason ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      runtime.requests_spent !== 1 ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'interrupted' ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null ||
      attempt.error !== 'Pi exited (0)' ||
      task.steps.filter((s) => s.state === 'interrupted' && s.attempt_id === attempt.id).length !==
        1 ||
      task.steps[0]?.attempt_id !== attempt.id ||
      task.steps[0]?.state !== 'interrupted' ||
      task.steps.slice(1).some((s) => s.state !== 'pending' || s.attempt_id !== null)
    )
      return null;
    const blocks = this.store.db
      .prepare(
        "SELECT seq,payload FROM events WHERE session_id=? AND kind='work_task.budget_blocked'",
      )
      .all(session);
    if (
      blocks.length !== 1 ||
      canonical(JSON.parse(String(blocks[0]!.payload))) !== canonical({ task_id: task.id, reason })
    )
      return null;
    const activity = this.store.db
      .prepare(
        "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished','worker.unhealthy','attempt.interrupted') ORDER BY seq",
      )
      .all(session);
    if (
      activity.length !== 3 ||
      activity[0]!.kind !== 'tool.started' ||
      activity[1]!.kind !== 'worker.unhealthy' ||
      activity[2]!.kind !== 'attempt.interrupted' ||
      Number(activity[0]!.seq) >= Number(blocks[0]!.seq) ||
      Number(activity[1]!.seq) <= Number(blocks[0]!.seq)
    )
      return null;
    const tool = JSON.parse(String(activity[0]!.payload)),
      unhealthy = JSON.parse(String(activity[1]!.payload)),
      interrupted = JSON.parse(String(activity[2]!.payload));
    if (
      tool.tool !== 'spawn_child' ||
      tool.attempt_id !== attempt.id ||
      tool.worker_epoch !== attempt.worker_epoch ||
      typeof tool.tool_call_id !== 'string' ||
      !tool.tool_call_id ||
      tool.parent_tool_call_id ||
      unhealthy.epoch !== attempt.worker_epoch ||
      unhealthy.error !== 'Required control failed: ' + reason ||
      interrupted.attempt_id !== attempt.id ||
      interrupted.error !== attempt.error
    )
      return null;
    const models = this.store.db
      .prepare("SELECT seq,payload FROM events WHERE session_id=? AND kind='model.admitted'")
      .all(session);
    const policies = this.store.db
      .prepare("SELECT seq,payload FROM events WHERE session_id=? AND kind='policy.allowed'")
      .all(session);
    if (models.length !== 1 || policies.length !== 1) return null;
    const model = JSON.parse(String(models[0]!.payload)),
      policy = JSON.parse(String(policies[0]!.payload));
    if (
      model.attempt_id !== attempt.id ||
      model.epoch !== attempt.worker_epoch ||
      Number(models[0]!.seq) >= Number(activity[0]!.seq) ||
      policy.tool !== 'spawn_child' ||
      policy.attempt_id !== attempt.id ||
      policy.epoch !== attempt.worker_epoch ||
      Number(policies[0]!.seq) <= Number(activity[0]!.seq) ||
      Number(policies[0]!.seq) >= Number(blocks[0]!.seq)
    )
      return null;
    const links = this.store.db
      .prepare(
        'SELECT b.* FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=?',
      )
      .all(task.id);
    if (
      links.length !== 1 ||
      links[0]!.attempt_id !== attempt.id ||
      links[0]!.plan_revision !== task.plan_revision ||
      links[0]!.step_id !== task.steps.find((s) => s.attempt_id === attempt.id)?.id
    )
      return null;
    const units = this.noLedgeredEffects(session, task);
    if (!units) return null;
    return {
      block: blocks[0],
      activity,
      model: models[0],
      policy: policies[0],
      link: links[0],
      unbound_stopped_units: units,
    };
  }
  /** Every execution/effect ledger, including read calls, is empty for this session and task,
   * and any station unit is unbound with a complete durable stop proof. Returns those units. */
  private noLedgeredEffects(
    session: string,
    task: WorkTask,
    checked: {
      operations?: boolean;
      stationReads?: boolean;
      stationCalls?: boolean;
      checkUnits?: string[];
    } = {},
  ): Record<string, any>[] | null {
    // These are all independent execution/effect ledgers, including read calls.
    for (const table of [
      'operations',
      'mcp_calls',
      'toolkit_calls',
      'toolkit_resources',
      'station_calls',
      'local_calls',
      'command_runs',
    ]) {
      // A caller that proves its own operations or closed reads checks those itself.
      if (table === 'operations' && checked.operations) continue;
      if (table === 'station_calls' && checked.stationCalls) continue;
      if (
        table === 'station_calls' &&
        checked.stationReads &&
        !this.store.db
          .prepare(
            "SELECT 1 FROM station_calls WHERE session_id=? AND NOT (kind='read' AND state='returned')",
          )
          .get(session)
      )
        continue;
      if (this.store.db.prepare(`SELECT 1 FROM ${table} WHERE session_id=?`).get(session))
        return null;
    }
    if (
      this.store.db
        .prepare('SELECT 1 FROM child_tasks WHERE parent_session=? OR child_session=?')
        .get(session, session) ||
      this.store.db
        .prepare('SELECT 1 FROM worker_integrations WHERE parent_session=?')
        .get(session) ||
      this.store.db
        .prepare(
          'SELECT 1 FROM workspace_mutations m JOIN workspaces w ON w.id=m.workspace_id WHERE w.session_id=?',
        )
        .get(session)
    )
      return null;
    for (const table of [
      'task_reservations',
      'task_checks',
      'task_invocations',
      'task_mutations',
      'task_restores',
      'task_completions',
    ]) {
      if (this.store.db.prepare(`SELECT 1 FROM ${table} WHERE task_id=?`).get(task.id)) return null;
    }
    // Detect partially journaled or orphaned child execution as uncertainty too.
    if (
      this.store.db
        .prepare(
          'SELECT 1 FROM child_workers w LEFT JOIN child_tasks c ON c.id=w.child_id WHERE c.id IS NULL OR c.parent_session=?',
        )
        .get(session) ||
      this.store.db
        .prepare(
          'SELECT 1 FROM external_runs e LEFT JOIN child_tasks c ON c.id=e.child_id WHERE c.id IS NULL OR c.parent_session=?',
        )
        .get(session) ||
      this.store.db
        .prepare(
          'SELECT 1 FROM external_model_requests m LEFT JOIN child_tasks c ON c.id=m.child_id WHERE c.id IS NULL OR c.parent_session=?',
        )
        .get(session)
    )
      return null;
    // Unbound startup verification units are outside this work's ownership. Only
    // their complete durable stop proof allows them to coexist with retirement.
    const units = this.store.db
      .prepare('SELECT * FROM station_units WHERE session_id=? OR session_id IS NULL')
      .all(session);
    for (const unit of units) {
      // A proven returned check's own unit belongs to this session; it still needs its stop proof.
      const ownCheck =
        unit.session_id === session &&
        typeof unit.call_id === 'string' &&
        !!checked.checkUnits?.includes(unit.call_id);
      if (
        (!ownCheck && (unit.session_id !== null || unit.call_id !== null)) ||
        unit.state !== 'stopped' ||
        !unit.stop_json
      )
        return null;
      const stop = JSON.parse(String(unit.stop_json));
      if (
        stop.version !== 1 ||
        stop.observed_empty !== true ||
        stop.unit !== `salaam-station-${unit.id}.service` ||
        stop.cgroup !== `/system.slice/${stop.unit}` ||
        typeof stop.invocation !== 'string' ||
        !/^[a-f0-9]{32}$/.test(stop.invocation)
      )
        return null;
    }
    return units;
  }
  /** An attempt the owner's authority revocation cancelled (for example a hub restart) before
   * any ledgered effect. The only tool activity allowed is closed operator MCP calls, each
   * journaled with argument and result digests; they are preserved as the known effects. */
  private revokeCancelledFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    const attempt = attempts[0];
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null ||
      !attempt.outcome
    )
      return null;
    const outcome = JSON.parse(String(attempt.outcome));
    if (
      outcome.version !== 1 ||
      outcome.stopReason !== 'cancelled' ||
      outcome.failure?.kind !== 'cancelled' ||
      outcome.failure.code !== 'attempt_cancelled' ||
      outcome.failure.retryable !== false ||
      outcome.failure.sessionId !== session ||
      outcome.failure.attemptId !== attempt.id
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'cancelled' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    const links = this.store.db
      .prepare(
        'SELECT b.* FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=?',
      )
      .all(task.id);
    if (
      links.length !== 1 ||
      links[0]!.attempt_id !== attempt.id ||
      links[0]!.plan_revision !== task.plan_revision ||
      links[0]!.step_id !== steps[0]!.id
    )
      return null;
    // The cancellation came from the node's revocation of this session, not a local operator.
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt.id));
    const revocations = this.store.db
      .prepare('SELECT * FROM session_revocations WHERE session_id=?')
      .all(session);
    if (
      cancellations.length !== 1 ||
      cancellations[0]!.requested_by !== 'agentpod-node' ||
      revocations.length !== 1
    )
      return null;
    const revocation = JSON.parse(String(revocations[0]!.receipt));
    if (
      revocation.revoked !== true ||
      revocation.session_id !== session ||
      canonical(revocation.session_ids) !== canonical([session]) ||
      canonical(revocation.attempt_ids) !== canonical([attempt.id]) ||
      canonical(revocation.unresolved_operations) !== canonical([]) ||
      typeof revocation.request_id !== 'string' ||
      !revocation.request_id
    )
      return null;
    const marks = this.store.db
      .prepare(
        "SELECT seq,kind,payload,causation_id FROM events WHERE session_id=? AND kind IN ('attempt.cancel_requested','execution.revoked','attempt.cancelled') ORDER BY seq",
      )
      .all(session);
    const only = (kind: string) => {
      const found = marks.filter((e) => e.kind === kind);
      return found.length === 1 ? found[0]! : null;
    };
    const requested = only('attempt.cancel_requested'),
      revoked = only('execution.revoked'),
      cancelled = only('attempt.cancelled');
    if (
      marks.length !== 3 ||
      !requested ||
      !revoked ||
      !cancelled ||
      requested.causation_id !== 'agentpod-revocation' ||
      JSON.parse(String(requested.payload)).attempt_id !== attempt.id ||
      revoked.causation_id !== revocation.request_id ||
      JSON.parse(String(revoked.payload)).owner_session !== session ||
      JSON.parse(String(cancelled.payload)).attempt_id !== attempt.id ||
      !(Number(requested.seq) < Number(revoked.seq) && Number(revoked.seq) < Number(cancelled.seq))
    )
      return null;
    // Tool activity: only operator MCP tools, each closed before the revocation, each holding
    // at most one journaled call (none for a catalog read), and no call outside a tool.
    const activity = this.store.db
      .prepare(
        "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished','operator_mcp.call','policy.allowed','policy.denied') ORDER BY seq",
      )
      .all(session);
    const calls: Record<string, any>[] = [];
    let open: { id: string; calls: number } | null = null;
    for (const event of activity) {
      const payload = JSON.parse(String(event.payload));
      if (Number(event.seq) >= Number(requested.seq)) return null;
      if (payload.attempt_id !== attempt.id) return null;
      if (event.kind === 'tool.started') {
        if (
          open ||
          payload.tool !== 'salaam_operator_mcp' ||
          typeof payload.tool_call_id !== 'string' ||
          !payload.tool_call_id ||
          payload.parent_tool_call_id
        )
          return null;
        open = { id: payload.tool_call_id, calls: 0 };
      } else if (event.kind === 'tool.finished') {
        if (!open || payload.tool_call_id !== open.id || payload.tool !== 'salaam_operator_mcp')
          return null;
        open = null;
      } else if (event.kind === 'operator_mcp.call') {
        if (
          !open ||
          ++open.calls > 1 ||
          !['returned', 'tool_error', 'failed'].includes(String(payload.outcome))
        )
          return null;
        calls.push({ seq: event.seq, ...payload });
      } else if (event.kind === 'policy.allowed') {
        if (!open || payload.tool !== 'salaam_operator_mcp') return null;
      } else return null;
    }
    if (open) return null;
    const units = this.noLedgeredEffects(session, task);
    if (!units) return null;
    return {
      revocation,
      cancellation: cancellations[0],
      events: marks,
      operator_mcp_calls: calls,
      link: links[0],
      unbound_stopped_units: units,
    };
  }
  /** Historical retirement of closed, policy-admitted reads. This does not
   * revalidate freshness, replay a check, or turn a protocol return into success. */
  private historicalKnownReadOnlyFailure(
    binding: import('./agentpod-protocol.js').AgentPodBinding,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    expiry?: {
      operation: Record<string, any>;
      approval: Record<string, any>;
      offered: Record<string, any>;
      invalidated?: true;
    },
    applied?: { operation: Record<string, any>; approval: Record<string, any> },
  ) {
    if (
      (!['partially_completed', 'failed', 'blocked'].includes(task.state) &&
        !(expiry && !expiry.invalidated && !applied && task.state === 'cancelled')) ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens
    )
      return null;
    try {
      const require = (condition: unknown): void => {
        if (!condition) throw new Error('Incomplete historical read-only evidence');
      };
      const audit: Record<string, unknown> = {};
      const rows = (key: string, sql: string, ...args: any[]): Record<string, any>[] => {
        const result = this.store.db.prepare(sql).all(...args);
        require(result.length <= 256);
        audit[key] = result;
        return result;
      };
      const root = digest(binding),
        session = task.session_id;
      const original = this.store.db
        .prepare(
          'SELECT verification_json,request_id FROM agentpod_work WHERE task_id=? AND session_id=?',
        )
        .get(task.id, session);
      require(original);
      const originalVerification = JSON.parse(String(original!.verification_json));
      let unapplied: { attempt: string; call: Record<string, any>; tool: string } | null = null;
      if (expiry) {
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
            offered.work_request_id === original!.request_id &&
            offered.binding_digest === root &&
            offered.task_id === task.id &&
            offered.plan_revision === task.plan_revision &&
            approval.operation_digest === offered.operation_digest &&
            op.operation_digest === offered.operation_digest &&
            operationBinding(op as unknown as import('./protocol.js').Operation) ===
              op.operation_digest &&
            approval.state === (expiry.invalidated ? 'invalidated' : 'expired') &&
            approval.revision === offered.approval_revision + 1 &&
            approval.expires_at === offered.expires_at &&
            (expiry.invalidated || approval.expires_at <= Date.now()) &&
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
            op.policy_digest === POLICY_DIGEST &&
            call.session_id === session &&
            call.attempt_id === op.attempt_id &&
            call.worker_epoch === op.worker_epoch &&
            call.tool_call_id === op.tool_call_id &&
            call.id ===
              digest(['station-work-v1', session, call.worker_epoch, call.tool_call_id]) &&
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
            !this.store.db
              .prepare('SELECT 1 FROM station_units WHERE call_id=?')
              .get(String(call.id)) &&
            args.action === 'patch' &&
            Object.keys(args).sort().join(',') ===
              'action,content,expected_hash,expected_tree,path' &&
            typeof args.path === 'string' &&
            /^[a-f0-9]{64}$/.test(args.expected_tree) &&
            (args.expected_hash === null || /^[a-f0-9]{64}$/.test(args.expected_hash)) &&
            (args.content === null || typeof args.content === 'string') &&
            call.input_digest === digest(args) &&
            op.value === canonical(args) &&
            op.target === 'station:' + args.path &&
            op.target_version ===
              digest({ id: call.id, root, configuration: call.configuration_digest, args }) &&
            op.argument_digest ===
              digest({ target: op.target, value: op.value, target_version: op.target_version }) &&
            op.action_key ===
              digest({
                id: op.id,
                attempt: op.attempt_id,
                epoch: op.worker_epoch,
                call: op.tool_call_id,
                target: op.target,
                value: op.value,
                version: op.target_version,
              }),
        );
        const offerRecord = this.store.db
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
        const operationEvents = rows(
          expiry.invalidated ? 'invalidated_operation_history' : 'expired_operation_history',
          "SELECT * FROM events WHERE session_id=? AND kind LIKE 'operation.%' AND json_extract(payload,'$.operation_id')=?",
          session,
          op.id,
        );
        require(
          operationEvents.length === 2 &&
            operationEvents.every((e) =>
              ['operation.prepared', 'operation.cancelled_before_dispatch'].includes(
                String(e.kind),
              ),
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
          !this.store.db
            .prepare(
              "SELECT 1 FROM requests WHERE actor='agentpod-work-decision-answer' AND json_extract(response,'$.approval_id')=?",
            )
            .get(String(approval.id)),
        );
        const events = rows(
          expiry.invalidated ? 'invalidation_events' : 'expiry_events',
          "SELECT * FROM events WHERE session_id=? AND kind IN ('approval.expired','approval.invalidated','operation.cancelled_before_dispatch','station.call.cancelled','attempt.cancelled','approval.dialog_replied','attempt.cancel_requested','execution.revoked')",
          session,
        );
        const one = (kind: string, predicate: (p: Record<string, any>) => boolean) => {
          const found = events.filter(
            (e) => e.kind === kind && predicate(JSON.parse(String(e.payload))),
          );
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
          (p) => p.approval_id === approval.id && p.pi_request_id === dialogs[0]!.pi_request_id,
        );
        require(
          Number(expired.seq) < Number(cancelled.seq) &&
            Number(cancelled.seq) < Number(dialogEvent.seq) &&
            Number(cancelled.seq) < Number(stopped.seq) &&
            Number(stopped.seq) < Number(attemptEvent.seq),
        );
        const attempt = this.store.db
          .prepare('SELECT * FROM attempts WHERE id=? AND session_id=?')
          .get(String(op.attempt_id), session);
        require(
          attempt &&
            attempt.state === 'cancelled' &&
            attempt.worker_epoch === op.worker_epoch &&
            attempt.result === null &&
            attempt.continues_attempt_id === null &&
            attempt.resolved_by === null &&
            this.store.db
              .prepare('SELECT 1 FROM cancellations WHERE attempt_id=?')
              .get(String(attempt.id)),
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
        if (expiry.invalidated) {
          require(
            !this.store.db
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
              revocation.session_ids.every(
                (id: unknown) => typeof id === 'string' && id.length > 0,
              ) &&
              Array.isArray(revocation.attempt_ids) &&
              revocation.attempt_ids.every(
                (id: unknown) => typeof id === 'string' && id.length > 0,
              ) &&
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
        audit[expiry.invalidated ? 'invalidated_unanswered_boundary' : 'expired_boundary'] = {
          offered,
          operation: op,
          approval,
        };
        unapplied = { attempt: String(op.attempt_id), call, tool: String(op.tool_call_id) };
      }
      const children = rows(
        'children',
        'SELECT * FROM child_tasks WHERE parent_session=?',
        session,
      );
      const sessions = [session, ...children.map((c) => String(c.child_session))];
      require(new Set(sessions).size === sessions.length && sessions.length <= 33);
      const marks = sessions.map(() => '?').join(',');
      require(
        !this.store.db
          .prepare(
            `SELECT 1 FROM child_tasks WHERE child_session=? OR (parent_session IN (${marks}) AND parent_session!=?)`,
          )
          .get(session, ...sessions, session),
      );
      const attempts = rows(
        'attempts',
        `SELECT * FROM attempts WHERE session_id IN (${marks})`,
        ...sessions,
      );
      require(
        attempts.length > 0 &&
          attempts.every(
            (a) =>
              (unapplied?.attempt === a.id
                ? a.state === 'cancelled'
                : a.state === 'completed' && a.error === null) &&
              a.continues_attempt_id === null &&
              a.resolved_by === null &&
              (unapplied?.attempt === a.id ||
                canonical(JSON.parse(String(a.outcome))) ===
                  canonical({ version: 1, stopReason: 'end_turn' })),
          ),
      );
      // Native model grants are independently journaled: a completed attempt
      // cannot hide an unmatched request, unknown receipt, or orphan budget.
      const attemptIds = attempts.map((a) => String(a.id)),
        attemptMarks = attemptIds.map(() => '?').join(',');
      const usage = rows(
        'usage',
        `SELECT * FROM usage_observations WHERE session_id IN (${marks}) OR attempt_id IN (${attemptMarks})`,
        ...sessions,
        ...attemptIds,
      );
      const admissions = rows(
        'usage_admitted',
        `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='usage.admitted' ORDER BY seq`,
        ...sessions,
      );
      const models = rows(
        'model_admitted',
        `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='model.admitted' ORDER BY seq`,
        ...sessions,
      );
      const budgets = rows(
        'attempt_budgets',
        `SELECT b.* FROM attempt_budgets b LEFT JOIN attempts a ON a.id=b.attempt_id WHERE a.id IS NULL OR a.session_id IN (${marks})`,
        ...sessions,
      );
      require(
        usage.length === admissions.length &&
          models.length === admissions.length &&
          budgets.length === attempts.length &&
          runtime.requests_spent === usage.length,
      );
      for (const a of attempts) {
        const receipts = usage.filter(
          (u) => u.attempt_id === a.id && u.session_id === a.session_id,
        );
        const grants = admissions.filter(
          (e) => JSON.parse(String(e.payload)).attempt_id === a.id && e.session_id === a.session_id,
        );
        const dispatched = models.filter(
          (e) => JSON.parse(String(e.payload)).attempt_id === a.id && e.session_id === a.session_id,
        );
        const budget = budgets.find((b) => b.attempt_id === a.id),
          route = this.store.providerRoute(String(a.session_id));
        require(
          new Set(grants.map((e) => JSON.parse(String(e.payload)).source_key)).size ===
            grants.length &&
            receipts.every((r) =>
              grants.some((e) => JSON.parse(String(e.payload)).source_key === r.source_key),
            ),
        );
        require(
          route &&
            budget &&
            receipts.length > 0 &&
            receipts.length === grants.length &&
            grants.length === dispatched.length &&
            budget.spent_requests === receipts.length &&
            budget.spent_requests + budget.reserved_requests <= budget.limit_requests &&
            budget.reserved_requests ===
              children
                .filter((c) => c.parent_attempt === a.id)
                .reduce((n, c) => n + Number(c.budget), 0),
        );
        if (a.session_id !== session)
          require(
            budget!.limit_requests === children.find((c) => c.child_attempt === a.id)?.budget,
          );
        for (let i = 0; i < grants.length; i++) {
          const grant = grants[i]!,
            modelEvent = dispatched[i]!,
            p = JSON.parse(String(grant.payload)),
            model = JSON.parse(String(modelEvent.payload));
          const receipt = receipts.find((u) => u.source_key === p.source_key);
          require(
            receipt &&
              ['known', 'estimated'].includes(receipt.status) &&
              receipt.payload_digest &&
              receipt.provider === route!.provider &&
              receipt.model === route!.model &&
              model.provider === receipt.provider &&
              model.epoch === a.worker_epoch &&
              /^[a-f0-9]{64}$/.test(model.context_digest) &&
              /^[a-f0-9]{64}$/.test(model.payload_digest) &&
              Number(grant.seq) < Number(modelEvent.seq),
          );
          const values = [
            receipt!.input,
            receipt!.output,
            receipt!.cache_read,
            receipt!.cache_write,
            receipt!.cost,
          ];
          require(
            values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) &&
              receipt!.payload_digest ===
                digest({
                  provider: receipt!.provider,
                  model: receipt!.model,
                  values,
                  status: receipt!.status,
                }),
          );
        }
      }
      require(
        rows('compactions', `SELECT * FROM compactions WHERE session_id IN (${marks})`, ...sessions)
          .length === 0,
      );
      require(
        attempts.filter((a) => a.session_id !== session).length === children.length &&
          attempts
            .filter((a) => a.session_id !== session)
            .every((a) =>
              children.some((c) => c.child_attempt === a.id && c.child_session === a.session_id),
            ),
      );
      require(!unapplied || !children.some((c) => c.parent_attempt === unapplied!.attempt));
      const rootAttempts = attempts.filter((a) => a.session_id === session);
      const links = rows(
        'step_attempts',
        'SELECT b.* FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=?',
        task.id,
      );
      require(
        rootAttempts.length > 0 &&
          links.length === rootAttempts.length &&
          links.every(
            (l) =>
              l.plan_revision === task.plan_revision &&
              rootAttempts.some((a) => a.id === l.attempt_id) &&
              task.steps.some(
                (s) =>
                  s.id === l.step_id &&
                  s.attempt_id === l.attempt_id &&
                  (s.attempt_id === unapplied?.attempt
                    ? s.state === 'cancelled'
                    : ['completed', 'awaiting_review'].includes(s.state)),
              ),
          ),
      );
      require(
        task.steps.every((s) =>
          s.state === 'pending'
            ? s.attempt_id === null
            : (s.attempt_id === unapplied?.attempt
                ? s.state === 'cancelled'
                : ['completed', 'awaiting_review'].includes(s.state)) &&
              links.some((l) => l.step_id === s.id),
        ),
      );
      require(
        !this.store.db
          .prepare(`SELECT 1 FROM workers WHERE session_id IN (${marks}) AND state!='exited'`)
          .get(...sessions),
      );
      const artifactAudit: Record<string, any>[] = [];
      const artifact = (id: unknown, owner: string, json = true): any => {
        require(typeof id === 'string');
        const row = this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(String(id));
        require(row && row.session_id === owner);
        const text = this.verification.artifacts.read(String(id));
        require(Buffer.byteLength(text) === row!.bytes);
        artifactAudit.push(row!);
        return json ? JSON.parse(text) : text;
      };
      let appliedCall: Record<string, any> | null = null;
      let appliedTransition: { before: string; after: string; settled: number } | null = null;
      if (applied) {
        const { operation: op, approval: a } = applied;
        const cs = rows(
          'applied_patch_calls',
          'SELECT * FROM station_calls WHERE operation_id=?',
          op.id,
        );
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
            operationBinding(op as unknown as import('./protocol.js').Operation) ===
              op.operation_digest,
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
            c.helper_pid > 0 &&
            c.helper_identity &&
            !this.store.db.prepare('SELECT 1 FROM station_units WHERE call_id=?').get(String(c.id)),
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
        require(
          args.action === 'patch' &&
            Object.keys(args).sort().join(',') ===
              'action,content,expected_hash,expected_tree,path' &&
            typeof args.path === 'string' &&
            /^[a-f0-9]{64}$/.test(args.expected_tree) &&
            (args.expected_hash === null || /^[a-f0-9]{64}$/.test(args.expected_hash)) &&
            (args.content === null || typeof args.content === 'string') &&
            c.input_digest === digest(args) &&
            op.value === canonical(args) &&
            op.target === 'station:' + args.path &&
            op.target_version ===
              digest({ id: c.id, root, configuration: c.configuration_digest, args }) &&
            op.argument_digest ===
              digest({ target: op.target, value: op.value, target_version: op.target_version }) &&
            op.action_key ===
              digest({
                id: op.id,
                attempt: op.attempt_id,
                epoch: op.worker_epoch,
                call: op.tool_call_id,
                target: op.target,
                value: op.value,
                version: op.target_version,
              }),
        );
        require(
          result.version === 1 &&
            result.ok === true &&
            result.files === 1 &&
            result.path === args.path &&
            result.before_tree_digest === args.expected_tree &&
            /^[a-f0-9]{64}$/.test(result.tree_digest) &&
            /^[a-f0-9]{64}$/.test(result.root_identity) &&
            result.sha256 === (args.content === null ? null : textDigest(args.content)),
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
        const work = this.store.db
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
        appliedTransition = {
          before: args.expected_tree,
          after: result.tree_digest,
          settled: Number(succeeded[0]!.seq),
        };
        appliedCall = c;
      }
      for (const table of [
        'operations',
        'approvals',
        'toolkit_calls',
        'toolkit_resources',
        'local_calls',
        'command_runs',
      ])
        require(
          rows(table, `SELECT * FROM ${table} WHERE session_id IN (${marks})`, ...sessions).every(
            (r) =>
              (expiry || applied) &&
              ((table === 'operations' && r.id === (expiry || applied)!.operation.id) ||
                (table === 'approvals' && r.id === (expiry || applied)!.approval.id)),
          ),
        );
      require(
        rows('reservations', 'SELECT * FROM task_reservations WHERE task_id=?', task.id).every(
          (r) =>
            r.remaining_requests === 0 &&
            r.remaining_tokens === 0 &&
            children.some((c) => c.child_attempt === r.attempt_id),
        ),
      );
      for (const table of [
        'task_invocations',
        'task_mutations',
        'task_restores',
        'task_completions',
      ])
        require(rows(table, `SELECT * FROM ${table} WHERE task_id=?`, task.id).length === 0);
      require(
        rows(
          'workspace_mutations',
          `SELECT m.* FROM workspace_mutations m JOIN workspaces w ON w.id=m.workspace_id WHERE w.session_id IN (${marks})`,
          ...sessions,
        ).length === 0,
      );
      require(
        rows(
          'integrations',
          `SELECT * FROM worker_integrations WHERE parent_session IN (${marks})`,
          ...sessions,
        ).length === 0,
      );
      // Inspect independent child registries, including partial/orphan records.
      const workers = rows(
        'child_workers',
        `SELECT w.* FROM child_workers w LEFT JOIN child_tasks c ON c.id=w.child_id WHERE c.id IS NULL OR c.parent_session IN (${marks}) OR json_extract(w.binding,'$.owner_session')=?`,
        ...sessions,
        session,
      );
      require(
        workers.length === children.length &&
          workers.every((w) => children.some((c) => c.id === w.child_id)),
      );
      for (const table of ['external_runs', 'external_model_requests'])
        require(
          rows(
            table,
            `SELECT e.* FROM ${table} e LEFT JOIN child_tasks c ON c.id=e.child_id WHERE c.id IS NULL OR c.parent_session IN (${marks})`,
            ...sessions,
          ).length === 0,
        );
      const profile = this.store.db
        .prepare('SELECT * FROM worker_profiles WHERE id=? AND revision=?')
        .get(DIAGNOSTIC_PROFILE.id, DIAGNOSTIC_PROFILE.revision);
      if (children.length)
        require(
          profile &&
            !profile.revoked &&
            profile.digest === digest(DIAGNOSTIC_PROFILE) &&
            digest(JSON.parse(String(profile.document))) === profile.digest,
        );
      for (const child of children) {
        const worker = workers.find((w) => w.child_id === child.id)!,
          b = JSON.parse(String(worker.binding));
        const attempt = attempts.find(
          (a) => a.id === child.child_attempt && a.session_id === child.child_session,
        );
        require(
          child.state === 'completed' &&
            child.result_id &&
            attempt &&
            rootAttempts.some((a) => a.id === child.parent_attempt) &&
            worker.dispatch_state === 'terminal' &&
            worker.generation === 1 &&
            worker.worker_epoch === attempt!.worker_epoch &&
            worker.binding_digest === digest(b) &&
            b.schema_version === 1 &&
            b.legacy === false &&
            b.runtime === 'native-pi' &&
            !b.agent &&
            !b.assignment &&
            !b.external &&
            !b.isolation &&
            !b.repository &&
            b.workspace === null &&
            b.owner_session === session &&
            b.owner_task === task.id &&
            b.parent_attempt === child.parent_attempt &&
            b.session_id === child.child_session &&
            b.attempt_id === child.child_attempt &&
            b.step_key === child.step_key &&
            b.input_digest === child.input_digest &&
            b.policy_digest === POLICY_DIGEST &&
            b.profile_digest === digest(DIAGNOSTIC_PROFILE) &&
            canonical(b.profile) === canonical(DIAGNOSTIC_PROFILE) &&
            canonical(b.tools) === canonical(['salaam_probe']) &&
            child.authority === JSON.stringify(b.tools) &&
            b.capability_digest === digest(NATIVE_CAPABILITIES) &&
            canonical(b.capabilities) === canonical(NATIVE_CAPABILITIES) &&
            b.bounds?.scope === 'model-requests' &&
            b.bounds.requests === child.budget &&
            canonical(b.route) === canonical(this.store.providerRoute(child.child_session)),
        );
        const prompt = artifact(b.input_artifact, child.child_session, false);
        const submission = this.store.db
          .prepare('SELECT * FROM submissions WHERE id=? AND attempt_id=? AND session_id=?')
          .get(String(attempt!.submission_id), String(attempt!.id), String(child.child_session));
        require(
          submission?.text === prompt &&
            child.input_digest === digest({ prompt, budget: child.budget, requested: b.tools }),
        );
        const result = artifact(child.artifact_id, child.child_session);
        require(
          canonical(result) ===
            canonical({
              schema_version: 1,
              child_id: child.id,
              attempt_id: attempt!.id,
              state: 'completed',
              text: attempt!.result,
              error: null,
            }),
        );
      }
      const mcp = rows(
        'mcp',
        `SELECT * FROM mcp_calls WHERE session_id IN (${marks})`,
        ...sessions,
      );
      const assigned = rows(
        'mcp_admissions',
        `SELECT * FROM events WHERE session_id IN (${marks}) AND kind='mcp.assigned'`,
        ...sessions,
      );
      for (const call of mcp) {
        require(
          call.session_id === session &&
            call.binding_digest === root &&
            call.policy === 'read' &&
            call.state === 'returned' &&
            call.operation_id === null &&
            call.error === null &&
            rootAttempts.some(
              (a) => a.id === call.attempt_id && a.worker_epoch === call.worker_epoch,
            ),
        );
        const view = assigned
          .filter((e) => e.session_id === call.session_id)
          .map((e) => mcpAdmissionView(JSON.parse(String(e.payload))))
          .find(
            (v) =>
              v.binding_digest === root &&
              v.assignment_digest === call.assignment_digest &&
              v.profile_digest === call.profile_digest &&
              v.credential_generation === call.credential_generation,
          );
        require(
          view?.servers
            .find((s) => s.name === call.server_name)
            ?.tools.some((t) => t.name === call.tool_name && t.policy === 'read'),
        );
        require(
          call.input_digest ===
            digest({
              session,
              epoch: call.worker_epoch,
              attempt: call.attempt_id,
              call: call.tool_call_id,
              server: call.server_name,
              tool: call.tool_name,
              arguments: JSON.parse(String(call.arguments_json)),
            }),
        );
        const result = artifact(call.result_artifact, session);
        require(
          result.protocol_result === 'returned' &&
            result.is_error === false &&
            Array.isArray(result.content),
        );
      }
      const checks = rows('checks', 'SELECT * FROM task_checks WHERE task_id=?', task.id);
      require(runtime.verification_runs === checks.length);
      const calls = rows(
        'station_calls',
        `SELECT * FROM station_calls WHERE session_id IN (${marks})`,
        ...sessions,
      );
      const units = rows(
        'station_units',
        `SELECT * FROM station_units WHERE session_id IN (${marks}) OR session_id IS NULL`,
        ...sessions,
      );
      const observed = rows(
        'verification_observed',
        "SELECT * FROM events WHERE session_id=? AND kind='station.verification_observed'",
        session,
      );
      const plan = digest({
        objective: task.objective,
        constraints: task.constraints,
        acceptance: task.acceptance,
        ...(task.completion_gate ? { completion_gate: task.completion_gate } : {}),
        deliverables: task.deliverables,
        limits: task.limits,
        steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
          key,
          title,
          instruction,
          depends_on,
          checks,
        })),
      });
      const proofByCheck = new Map<
        string,
        { call: Record<string, any>; tree: string; config: string }
      >();
      const stopUnit = (unit: Record<string, any>) => {
        require(unit.state === 'stopped' && unit.stop_json);
        const stop = JSON.parse(String(unit.stop_json));
        require(
          stop.version === 1 &&
            stop.observed_empty === true &&
            stop.unit === `salaam-station-${unit.id}.service` &&
            stop.cgroup === `/system.slice/${stop.unit}` &&
            /^[a-f0-9]{32}$/.test(stop.invocation),
        );
        return stop;
      };
      for (const check of checks) {
        const evidence = artifact(check.artifact_id, session);
        const saved = this.store.db
          .prepare("SELECT * FROM requests WHERE actor='station-task-check' AND id=?")
          .get(String(check.id));
        require(saved);
        const bindingArtifact = JSON.parse(String(saved!.response)),
          bound = artifact(bindingArtifact, session);
        const call = calls.find((c) => c.id === bound.call_id),
          configured = requiredChecks(task).find((c) => c.key === check.check_key);
        require(
          check.state === 'passed' &&
            check.plan_revision === task.plan_revision &&
            check.engine_id === 'linux-systemd-station-v1' &&
            check.command_run_id === null &&
            call &&
            configured?.cwd === '.' &&
            (check.step_id === null ||
              task.steps.some(
                (s) => s.id === check.step_id && s.checks?.includes(check.check_key),
              )),
        );
        const c = call!,
          args = JSON.parse(String(c.args_json)),
          station = bound.station;
        require(
          bound.version === 1 &&
            bound.check_id === check.id &&
            bound.task_id === task.id &&
            bound.plan_revision === task.plan_revision &&
            bound.plan_digest === plan &&
            bound.check_digest ===
              digest({
                id: check.id,
                task: task.id,
                key: check.check_key,
                step: check.step_id,
                plan_revision: task.plan_revision,
              }) &&
            bound.call_digest ===
              digest({
                id: c.id,
                session: c.session_id,
                epoch: c.worker_epoch,
                attempt: c.attempt_id,
                tool: c.tool_call_id,
                kind: c.kind,
                input: c.input_digest,
                root: c.root_digest,
                configuration: c.configuration_digest,
                args: c.args_json,
              }) &&
            saved!.hash === digest({ checkID: check.id, callID: c.id }) &&
            station?.version === 1 &&
            station.runner === 'linux-systemd-station-v1' &&
            canonical(station) === canonical(originalVerification) &&
            (runtime.auto_binding === null ||
              canonical(JSON.parse(String(runtime.auto_binding))) === canonical(station)) &&
            station.root_digest === root &&
            station.configuration_digest === c.configuration_digest &&
            station.network === 'none' &&
            station.command_workspace === 'read-only-reviewed-snapshot' &&
            check.workspace_id === 'station:' + root &&
            check.workspace_revision === 0 &&
            check.workspace_digest === bound.tree_digest &&
            check.profile_digest === c.configuration_digest &&
            c.session_id === session &&
            c.kind === 'check' &&
            c.task_check_id === check.id &&
            c.tool_call_id === 'task-check:' + check.id &&
            c.attempt_id === null &&
            canonical(args) ===
              canonical({
                action: 'check',
                command: configured!.command,
                expected_tree: bound.tree_digest,
              }),
        );
        const result = JSON.parse(String(c.result_json)),
          unit = units.find((u) => u.call_id === c.id);
        require(
          unit &&
            unit.session_id === session &&
            unit.context_digest ===
              digest({
                id: c.id,
                root,
                configuration: c.configuration_digest,
                input: c.input_digest,
              }) &&
            digest(JSON.parse(String(unit.config_json))) === c.configuration_digest &&
            unit.unit_json,
        );
        const stop = stopUnit(unit!),
          description = JSON.parse(String(unit!.unit_json));
        require(
          description.id === stop.unit &&
            description.cgroup === stop.cgroup &&
            description.invocation === stop.invocation &&
            canonical(result.cleanup) === canonical(stop) &&
            result.exit_code === 0 &&
            result.verified_check === true &&
            result.expected_tree === bound.tree_digest &&
            result.observed_tree === bound.tree_digest &&
            result.network === 'none' &&
            result.workspace === 'read-only-reviewed-snapshot',
        );
        require(
          canonical(evidence) ===
            canonical({
              version: 1,
              backend: 'linux-systemd-station-v1',
              binding_artifact: bindingArtifact,
              check_id: check.id,
              call_id: c.id,
              plan_revision: task.plan_revision,
              root_digest: root,
              configuration_digest: c.configuration_digest,
              tree_digest: bound.tree_digest,
              result_digest: digest(result),
            }),
        );
        proofByCheck.set(String(check.id), {
          call: c,
          tree: bound.tree_digest,
          config: c.configuration_digest,
        });
      }
      require(
        !unapplied ||
          (calls.some((c) => canonical(c) === canonical(unapplied!.call)) &&
            [...proofByCheck.values()].some(
              (p) => p.tree === JSON.parse(String(unapplied!.call.args_json)).expected_tree,
            )),
      );
      if (appliedCall) {
        const args = JSON.parse(String(appliedCall.args_json)),
          result = JSON.parse(String(appliedCall.result_json));
        require(
          calls.some((c) => canonical(c) === canonical(appliedCall)) &&
            [...proofByCheck.values()].every(
              (p) => p.tree === args.expected_tree || p.tree === result.tree_digest,
            ),
        );
      }
      for (const call of calls) {
        if (appliedCall && canonical(call) === canonical(appliedCall)) continue;
        if (unapplied && canonical(call) === canonical(unapplied.call)) continue;
        require(
          call.session_id === session &&
            call.root_digest === root &&
            call.operation_id === null &&
            call.state === 'returned' &&
            ['read', 'check'].includes(call.kind) &&
            call.helper_state === 'stopped' &&
            call.helper_stop_json &&
            call.helper_identity &&
            call.helper_pid > 0 &&
            call.input_digest === digest(JSON.parse(String(call.args_json))),
        );
        const stop = JSON.parse(String(call.helper_stop_json));
        require(
          stop.version === 1 &&
            stop.scope === 'local_process_group' &&
            stop.method === 'observed_exit' &&
            stop.pid === call.helper_pid &&
            stop.identity === call.helper_identity,
        );
        const proof = proofByCheck.get(String(call.task_check_id));
        require(proof && call.configuration_digest === proof.config);
        if (call.kind === 'check') require(proof!.call.id === call.id);
        else {
          require(
            call.attempt_id === null &&
              call.tool_call_id === call.id &&
              call.result_json === null &&
              canonical(JSON.parse(String(call.args_json))) === canonical({ action: 'inspect' }),
          );
          require(
            observed.some((e) => {
              const p = JSON.parse(String(e.payload));
              return (
                p.inspection_call === call.id &&
                (p.tree_digest === proof!.tree ||
                  (appliedTransition &&
                    proof!.tree === appliedTransition.before &&
                    p.tree_digest === appliedTransition.after &&
                    Number(e.seq) > appliedTransition.settled)) &&
                (p.source_call === proof!.call.id ||
                  canonical(p.source_call) === canonical({ task_check_id: call.task_check_id }))
              );
            }),
          );
        }
      }
      for (const unit of units) {
        if (unit.session_id === null) {
          require(unit.call_id === null);
          stopUnit(unit);
        } else
          require(
            unit.session_id === session &&
              checks.some((c) => proofByCheck.get(String(c.id))?.call.id === unit.call_id),
          );
      }
      const tools = rows(
        'tools',
        `SELECT * FROM events WHERE session_id IN (${marks}) AND kind IN ('tool.started','tool.finished') ORDER BY seq`,
        ...sessions,
      );
      const starts = tools.filter((e) => e.kind === 'tool.started');
      require(tools.length === starts.length * 2 - (unapplied ? 1 : 0));
      require(
        !appliedCall ||
          starts.filter((e) => {
            const p = JSON.parse(String(e.payload));
            return (
              e.session_id === session &&
              p.attempt_id === appliedCall!.attempt_id &&
              p.tool_call_id === appliedCall!.tool_call_id
            );
          }).length === 1,
      );
      const matchedChildren = new Set<string>();
      require(
        mcp.every((c) =>
          starts.some((e) => {
            const p = JSON.parse(String(e.payload));
            return (
              e.session_id === c.session_id &&
              p.tool === 'salaam_mcp' &&
              JSON.parse(p.input).action === 'call' &&
              p.attempt_id === c.attempt_id &&
              p.worker_epoch === c.worker_epoch &&
              p.tool_call_id === c.tool_call_id
            );
          }),
        ),
      );
      for (const start of starts) {
        const p = JSON.parse(String(start.payload)),
          owner = attempts.find(
            (a) =>
              a.id === p.attempt_id &&
              a.session_id === start.session_id &&
              a.worker_epoch === p.worker_epoch,
          );
        const ends = tools.filter((e) => {
          const q = JSON.parse(String(e.payload));
          return (
            e.kind === 'tool.finished' &&
            e.session_id === start.session_id &&
            q.attempt_id === p.attempt_id &&
            q.worker_epoch === p.worker_epoch &&
            q.tool_call_id === p.tool_call_id &&
            q.tool === p.tool &&
            q.failed === false &&
            Number(e.seq) > Number(start.seq)
          );
        });
        require(
          owner &&
            typeof p.tool_call_id === 'string' &&
            p.tool_call_id &&
            (unapplied && p.attempt_id === unapplied.attempt && p.tool_call_id === unapplied.tool
              ? ends.length === 0
              : ends.length === 1) &&
            !p.input_truncated &&
            typeof p.input === 'string' &&
            textDigest(p.input) === p.input_digest,
        );
        if (unapplied && p.attempt_id === unapplied.attempt && p.tool_call_id === unapplied.tool) {
          require(
            start.session_id === session &&
              p.worker_epoch === unapplied.call.worker_epoch &&
              p.tool === 'salaam_station' &&
              canonical(JSON.parse(p.input)) === unapplied.call.args_json,
          );
        } else if (
          appliedCall &&
          p.attempt_id === appliedCall.attempt_id &&
          p.tool_call_id === appliedCall.tool_call_id
        ) {
          require(
            start.session_id === session &&
              p.worker_epoch === appliedCall.worker_epoch &&
              p.tool === 'salaam_station' &&
              canonical(JSON.parse(p.input)) === appliedCall.args_json,
          );
        } else if (p.tool === 'salaam_mcp') {
          const input = JSON.parse(p.input);
          const call =
            input.action === 'call' &&
            mcp.some(
              (c) =>
                c.session_id === start.session_id &&
                c.attempt_id === p.attempt_id &&
                c.tool_call_id === p.tool_call_id,
            );
          const catalog =
            input.action === 'catalog' &&
            start.session_id === session &&
            Object.keys(input).every((k) => ['action', 'server', 'tool'].includes(k)) &&
            assigned.some((e) => {
              if (e.session_id !== session) return false;
              const v = mcpAdmissionView(JSON.parse(String(e.payload)));
              return (
                v.binding_digest === root &&
                (input.server === undefined
                  ? input.tool === undefined
                  : v.servers.some(
                      (server) =>
                        server.name === input.server &&
                        (input.tool === undefined ||
                          server.tools.some((t) => t.name === input.tool)),
                    ))
              );
            });
          require(
            catalog ||
              (call &&
                mcp.some(
                  (c) =>
                    c.session_id === start.session_id &&
                    c.attempt_id === p.attempt_id &&
                    c.tool_call_id === p.tool_call_id &&
                    canonical(JSON.parse(p.input)) ===
                      canonical({
                        action: 'call',
                        server: c.server_name,
                        tool: c.tool_name,
                        arguments: JSON.parse(String(c.arguments_json)),
                      }),
                )),
          );
        } else if (p.tool === 'spawn_child') {
          require(start.session_id === session);
          const input = JSON.parse(p.input),
            authority = input.authority ?? ['salaam_probe'],
            budget = input.budget ?? 2;
          require(!input.profile && canonical(authority) === canonical(['salaam_probe']));
          const tasks = input.tasks ?? [
            { step_key: input.step_key ?? '', prompt: input.prompt ?? '' },
          ];
          require(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 2);
          for (const t of tasks) {
            const child = children.find(
              (c) =>
                c.parent_attempt === p.attempt_id &&
                c.step_key === t.step_key &&
                c.budget === budget &&
                c.input_digest === digest({ prompt: t.prompt, budget, requested: authority }),
            );
            require(child);
            matchedChildren.add(String(child!.id));
          }
        } else if (p.tool === 'inspect_child' || p.tool === 'consume_child_result') {
          require(start.session_id === session);
          const input = JSON.parse(p.input);
          if (p.tool === 'inspect_child')
            require(
              canonical(input) ===
                canonical(input.child_id === undefined ? {} : { child_id: input.child_id }) &&
                (input.child_id === undefined || children.some((c) => c.id === input.child_id)),
            );
          else
            require(
              children.some((c) => c.id === input.child_id && c.result_id === input.result_id) &&
                Object.keys(input).every((k) =>
                  ['child_id', 'result_id', 'acknowledge'].includes(k),
                ) &&
                (input.acknowledge === undefined || typeof input.acknowledge === 'boolean'),
            );
        } else {
          require(p.tool === 'salaam_probe');
          const input = JSON.parse(p.input);
          require(
            Object.keys(input).every((k) => k === 'nested') &&
              (input.nested === undefined || typeof input.nested === 'boolean'),
          );
        }
      }
      require(matchedChildren.size === children.length);
      require(
        !unapplied ||
          starts.filter((e) => {
            const p = JSON.parse(String(e.payload));
            return (
              e.session_id === session &&
              p.attempt_id === unapplied!.attempt &&
              p.tool_call_id === unapplied!.tool
            );
          }).length === 1,
      );
      audit.artifacts = artifactAudit;
      return audit;
    } catch {
      // Corrupt/missing source evidence is uncertainty, never a permissive default.
      return null;
    }
  }
  fail(
    binding: unknown,
    request: string,
    workRequest: string,
    terminalDigest: string,
    driver: TaskDriver,
  ) {
    const { root, row, task } = this.owned(binding);
    if (workRequest !== row.request_id || !/^[a-f0-9]{64}$/.test(terminalDigest))
      throw new ServiceError(
        'work_settlement_conflict',
        'Exact original work and terminal digest required',
      );
    const stopped = () => this.assertKnownEffectsStop(binding);
    stopped();
    return this.store.request(
      'agentpod-work-failure',
      workRequest,
      {
        binding: root.binding,
        request_id: request,
        work_request_id: workRequest,
        producer_terminal_digest: terminalDigest,
      },
      () => {
        stopped();
        this.assertPlan(task, JSON.parse(String(row.admission_json)));
        const evidence_digest = this.failureEvidence(root, task);
        driver.cancelInTransaction(task.id, task.revision, stopped);
        const receipt = {
          version: 1 as const,
          state: 'cancelled' as const,
          effects: 'known_effects_preserved' as const,
          request_id: request,
          work_request_id: workRequest,
          session_id: root.session_id,
          task_id: task.id,
          plan_revision: task.plan_revision,
          binding_digest: digest(root.binding),
          producer_terminal_digest: terminalDigest,
          evidence_digest,
        };
        this.store.event(root.session_id, 'agentpod.work_failed', receipt, request);
        return receipt;
      },
    );
  }
  /** A revoked root whose execution stopped with nothing unresolved or still running. */
  private assertKnownEffectsStop(binding: unknown): void {
    const current = this.authority.inspect(binding);
    if (
      !current.revoked ||
      current.authorized ||
      !current.owned_execution_stopped ||
      current.unresolved_operations.length ||
      current.active_attempts.length
    )
      throw new ServiceError(
        'work_settlement_unsafe',
        'Revoked stopped root with known effects required',
      );
  }
  /** The evidence a known-effects retirement records, or work_settlement_unsafe when the stopped
   * run is not one of the exact shapes Salaam can prove. Reads only; fail() and status share it. */
  /** A task the provider rate limit stopped after its retries (RATE_LIMIT_STOP). Everything is
   * closed and definite: every attempt completed or failed, the one failed step's last attempt
   * rate-limited and recorded by the driver, every operation succeeded or failed definitely with
   * no approval pending, every station call settled with its helper stopped, no children. */
  private rateLimitStopFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    if (
      !['blocked', 'partially_completed'].includes(task.state) ||
      !runtime ||
      runtime.blocked_reason !== RATE_LIMIT_STOP ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      attempts.some((a) => !['completed', 'failed'].includes(String(a.state)))
    )
      return null;
    const failed = task.steps.filter((s) => s.state === 'failed');
    if (
      failed.length !== 1 ||
      task.steps.some((s) => !['completed', 'failed', 'pending'].includes(s.state))
    )
      return null;
    const last = String(failed[0]!.attempt_id ?? '');
    const limits = new RateLimitRetries(this.store);
    const recorded = this.store.db
      .prepare(
        'SELECT attempt_id,failures FROM task_rate_limits WHERE task_id=? AND step_id=? ORDER BY failures',
      )
      .all(task.id, failed[0]!.id);
    if (!limits.rateLimited(last) || !recorded.some((r) => r.attempt_id === last)) return null;
    const db = this.store.db;
    const operations = db
      .prepare('SELECT id,state FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = db
      .prepare(
        'SELECT id,kind,state,helper_state FROM station_calls WHERE session_id=? ORDER BY rowid',
      )
      .all(session);
    if (
      operations.some((o) => !['succeeded', 'failed_definite'].includes(String(o.state))) ||
      db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'").get(session) ||
      calls.some(
        (c) =>
          ['prepared', 'dispatching', 'outcome_unknown'].includes(String(c.state)) ||
          !['none', 'stopped'].includes(String(c.helper_state)),
      ) ||
      db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session)
    )
      return null;
    return {
      step_id: failed[0]!.id,
      attempts: attempts.map((a) => ({ id: a.id, state: a.state })),
      rate_limited: recorded,
      operations,
      calls,
    };
  }
  /** A task its verification budget stopped after every step finished (staging run_54648a07).
   * Everything is closed and definite: every attempt completed or failed, every step completed or
   * failed, every operation succeeded or failed definitely with no approval pending, every station
   * call settled with its helper stopped, nothing reserved, no children. */
  private verificationLimitStopFailure(
    session: string,
    task: WorkTask,
    runtime: Record<string, any> | undefined,
    attempts: Record<string, any>[],
  ) {
    if (
      !['blocked', 'partially_completed'].includes(task.state) ||
      !runtime ||
      runtime.blocked_reason !== 'Task verification run limit reached' ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      !attempts.length ||
      attempts.some((a) => !['completed', 'failed'].includes(String(a.state))) ||
      task.steps.some((s) => !['completed', 'failed'].includes(s.state))
    )
      return null;
    const db = this.store.db;
    const operations = db
      .prepare('SELECT id,state FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = db
      .prepare(
        'SELECT id,kind,state,helper_state FROM station_calls WHERE session_id=? ORDER BY rowid',
      )
      .all(session);
    if (
      operations.some((o) => !['succeeded', 'failed_definite'].includes(String(o.state))) ||
      db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'").get(session) ||
      calls.some(
        (c) =>
          ['prepared', 'dispatching', 'outcome_unknown'].includes(String(c.state)) ||
          !['none', 'stopped'].includes(String(c.helper_state)),
      ) ||
      db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session)
    )
      return null;
    return {
      steps: task.steps.map((s) => ({ id: s.id, state: s.state })),
      attempts: attempts.map((a) => ({ id: a.id, state: a.state })),
      operations,
      calls,
    };
  }
  private failureEvidence(
    root: { session_id: string; binding: import('./agentpod-protocol.js').AgentPodBinding },
    task: WorkTask,
  ): string {
    const runtime = this.store.db
      .prepare('SELECT * FROM task_runtime WHERE task_id=?')
      .get(task.id);
    const attempts = this.store.db
      .prepare('SELECT * FROM attempts WHERE session_id=?')
      .all(root.session_id);
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=?')
      .all(root.session_id);
    const calls = this.store.db
      .prepare("SELECT * FROM station_calls WHERE session_id=? AND kind!='read'")
      .all(root.session_id);
    const op = ops[0],
      attempt = attempts[0],
      call = calls[0];
    const approval = op
      ? this.store.db.prepare('SELECT * FROM approvals WHERE operation_id=?').get(String(op.id))
      : undefined;
    const effect = op?.receipt ? JSON.parse(String(op.receipt)) : null;
    const bound = 'Provider payload exceeds declared per-request token bounds';
    const originalBlock = this.store.db
      .prepare(
        "SELECT seq,payload FROM events WHERE session_id=? AND kind='work_task.budget_blocked' AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.reason')=? ORDER BY seq LIMIT 1",
      )
      .get(root.session_id, task.id, bound);
    const runtimeExpired =
      runtime?.blocked_reason === 'Task runtime limit reached' &&
      runtime.started_at !== null &&
      Number.isFinite(Number(runtime.started_at)) &&
      Date.now() - Number(runtime.started_at) >= task.limits.runtime_ms;

    const savedInvalidatedOffer =
      approval?.state === 'invalidated'
        ? this.store.db
            .prepare(
              "SELECT response FROM requests WHERE actor='agentpod-work-decision-offer' AND id=?",
            )
            .get(String(approval.id))
        : undefined;
    const knownReadOnly =
      this.historicalKnownReadOnlyFailure(root.binding, task, runtime) ??
      (ops.length === 1 && op && approval && savedInvalidatedOffer
        ? this.historicalKnownReadOnlyFailure(root.binding, task, runtime, {
            operation: op,
            approval,
            offered: JSON.parse(String(savedInvalidatedOffer.response)),
            invalidated: true,
          })
        : null) ??
      (ops.length === 1 && op && approval
        ? this.historicalKnownReadOnlyFailure(root.binding, task, runtime, undefined, {
            operation: op,
            approval,
          })
        : null);
    const zeroEffect = this.zeroEffectConcurrencyFailure(root.session_id, task, runtime, attempts);
    const revokeCancelled = zeroEffect
      ? null
      : this.revokeCancelledFailure(root.session_id, task, runtime, attempts);
    const budgetStop =
      zeroEffect || revokeCancelled
        ? null
        : this.requestBudgetStopFailure(root.session_id, task, runtime, attempts);
    const refusedWrites =
      zeroEffect || revokeCancelled || budgetStop
        ? null
        : this.runtimeStopRefusedWritesFailure(root.session_id, task, runtime, attempts);
    const budgetKnown =
      zeroEffect || revokeCancelled || budgetStop || refusedWrites
        ? null
        : this.requestBudgetStopKnownEffectsFailure(
            root.session_id,
            root.binding,
            task,
            runtime,
            attempts,
          );
    const rateLimit =
      zeroEffect || revokeCancelled || budgetStop || refusedWrites || budgetKnown
        ? null
        : this.rateLimitStopFailure(root.session_id, task, runtime, attempts);
    const verificationLimit =
      zeroEffect || revokeCancelled || budgetStop || refusedWrites || budgetKnown || rateLimit
        ? null
        : this.verificationLimitStopFailure(root.session_id, task, runtime, attempts);
    if (
      !zeroEffect &&
      !revokeCancelled &&
      !budgetStop &&
      !refusedWrites &&
      !rateLimit &&
      !verificationLimit &&
      !budgetKnown &&
      !knownReadOnly &&
      (task.state !== 'blocked' ||
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
        effect.root_digest !== digest(root.binding) ||
        effect.root_digest !== call.root_digest ||
        effect.configuration_digest !== call.configuration_digest ||
        effect.input_digest !== call.input_digest ||
        canonical(effect.result) !== canonical(JSON.parse(String(call.result_json))) ||
        effect.result?.ok !== true ||
        task.steps.filter((s) => s.attempt_id === attempt.id && s.state === 'interrupted')
          .length !== 1 ||
        task.steps.some((s) => !['pending', 'interrupted'].includes(s.state)) ||
        this.store.db.prepare('SELECT 1 FROM task_checks WHERE task_id=?').get(task.id) ||
        this.store.db
          .prepare('SELECT 1 FROM child_tasks WHERE parent_session=?')
          .get(root.session_id))
    )
      throw new ServiceError(
        'work_settlement_unsafe',
        'Only exact known approved-patch, zero-effect child denial, revoke-cancelled operator MCP reads, request budget stopped operator MCP reads, runtime-stopped refused workspace writes, request budget stopped known effects, a closed rate-limit or verification-budget stop, or closed historical read-only evidence can retire',
      );
    const evidence_digest = digest({
      binding: root.binding,
      task_id: task.id,
      plan_revision: task.plan_revision,
      blocked_reason: runtime!.blocked_reason,
      attempt,
      operation: op ?? null,
      approval: approval ?? null,
      call: call ?? null,
      ...(zeroEffect ? { zero_effect_concurrency: zeroEffect } : {}),
      ...(revokeCancelled ? { revoke_cancelled: revokeCancelled } : {}),
      ...(budgetStop ? { request_budget_stop: budgetStop } : {}),
      ...(refusedWrites ? { runtime_stop_refused_writes: refusedWrites } : {}),
      ...(budgetKnown ? { request_budget_stop_known_effects: budgetKnown } : {}),
      ...(rateLimit ? { rate_limit_stop: rateLimit } : {}),
      ...(verificationLimit ? { verification_limit_stop: verificationLimit } : {}),
      ...(knownReadOnly ? { historical_known_readonly: knownReadOnly } : {}),
    });
    return evidence_digest;
  }
  /** Status's read-only verdict: "known_effects_failure" when fail() would retire this run now. */
  private settlementReady(
    binding: unknown,
    root: { session_id: string; binding: import('./agentpod-protocol.js').AgentPodBinding },
    row: Record<string, unknown>,
    task: WorkTask,
  ): 'known_effects_failure' | { refused: string } {
    try {
      this.assertKnownEffectsStop(binding);
      this.assertPlan(task, JSON.parse(String(row.admission_json)));
      this.failureEvidence(root, task);
      return 'known_effects_failure';
    } catch (error) {
      return {
        refused:
          error instanceof ServiceError ? error.code + ': ' + error.message : 'settlement_unproven',
      };
    }
  }
  abandon(binding: unknown, request: string, workRequest: string, terminalDigest: string) {
    const { root, row, task } = this.owned(binding);
    if (workRequest !== row.request_id || !/^[a-f0-9]{64}$/.test(terminalDigest))
      throw new ServiceError(
        'work_settlement_conflict',
        'Exact original work and terminal digest required',
      );
    const stopped = () => {
      const current = this.authority.inspect(binding);
      if (
        !current.revoked ||
        current.authorized ||
        !current.owned_execution_stopped ||
        current.unresolved_operations.length ||
        current.active_attempts.length ||
        current.interrupted_attempts.length
      )
        throw new ServiceError('work_settlement_unsafe', 'Revoked stopped completed root required');
    };
    stopped();
    return this.store.request(
      'agentpod-work-abandonment',
      workRequest,
      {
        binding: root.binding,
        request_id: request,
        work_request_id: workRequest,
        producer_terminal_digest: terminalDigest,
      },
      () => {
        stopped();
        this.assertPlan(task, JSON.parse(String(row.admission_json)));
        this.verification.assertIdle(task);
        const runtime = this.store.db
          .prepare('SELECT * FROM task_runtime WHERE task_id=?')
          .get(task.id);
        const completion = this.store.db
          .prepare('SELECT * FROM task_completions WHERE task_id=?')
          .get(task.id);
        const attempts = this.store.db
          .prepare('SELECT * FROM attempts WHERE session_id=?')
          .all(root.session_id);
        const operations = this.store.db
          .prepare('SELECT * FROM operations WHERE session_id=?')
          .all(root.session_id);
        const checks = this.store.db
          .prepare('SELECT * FROM task_checks WHERE task_id=?')
          .all(task.id);
        const calls = this.store.db
          .prepare('SELECT * FROM station_calls WHERE session_id=?')
          .all(root.session_id);
        const fail = (): never => {
          throw new ServiceError(
            'work_settlement_unsafe',
            'Only historically verified local success with known approved effects may retire',
          );
        };
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
          this.store.db
            .prepare('SELECT 1 FROM child_tasks WHERE parent_session=?')
            .get(root.session_id)
        )
          fail();
        const evidence = JSON.parse(
          this.verification.artifacts.read(String(completion!.artifact_id)),
        );
        const rootDigest = digest(root.binding);
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
        const op = operations[0]!;
        const approval = this.store.db
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
        const checkEvidence = checks.map((check) => {
          if (
            check.state !== 'passed' ||
            check.plan_revision !== task.plan_revision ||
            check.engine_id !== 'linux-systemd-station-v1' ||
            check.workspace_digest !== completion!.workspace_digest ||
            !check.artifact_id
          )
            fail();
          const e = JSON.parse(this.verification.artifacts.read(String(check.artifact_id)));
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
        // Historical evidence only: do not observe a fresh tree, renew authority,
        // cancel successful local work, or turn this receipt into producer success.
        const receipt = {
          version: 1 as const,
          state: 'retired' as const,
          outcome: 'unreported_local_success' as const,
          request_id: request,
          work_request_id: workRequest,
          session_id: root.session_id,
          task_id: task.id,
          plan_revision: task.plan_revision,
          binding_digest: rootDigest,
          producer_terminal_digest: terminalDigest,
          evidence_digest: digest({
            completion,
            evidence,
            attempts,
            operations,
            approval,
            checks,
            checkEvidence,
            calls,
          }),
        };
        this.store.event(root.session_id, 'agentpod.work_abandoned', receipt, request);
        return receipt;
      },
    );
  }
  /** Item 11b: restore a checkpoint's files, operator-approved, only for a run that has ended (its
   * execution revoked and stopped with nothing unresolved), never while another run is active on
   * the station, and only exactly as reviewed: the restore digest is recomputed and must match. */
  async restore(
    binding: unknown,
    request: string,
    checkpoint: string,
    restoreDigest: string,
    approvedBy: string,
  ) {
    const { root, task } = this.owned(binding);
    const current = this.authority.inspect(binding);
    if (
      !current.revoked ||
      current.authorized ||
      !current.owned_execution_stopped ||
      current.unresolved_operations.length ||
      current.active_attempts.length
    )
      throw new ServiceError(
        'restore_unsafe',
        'Restore is only for a run that has ended and stopped',
      );
    if (
      this.store.db
        .prepare("SELECT 1 FROM agentpod_admissions WHERE state!='revoked' AND session_id<>?")
        .get(root.session_id)
    )
      throw new ServiceError('restore_busy', 'Another run is active on this station');
    const station = this.stationBoundary();
    if (!station)
      throw new ServiceError('restore_unavailable', 'Restore needs the station boundary');
    // A replay of a restore already journaled returns its receipt: the live tree it moved is no
    // reason to refuse the very approval that moved it.
    const replay = station.replayed?.(root.session_id, request, restoreDigest) ?? null;
    if (replay !== null) return replay;
    const plan = await new StationCheckpoints(this.store).restorePlan(
      task,
      checkpoint,
      await station.live(),
    );
    if (plan.restore_digest !== restoreDigest)
      throw new ServiceError('restore_changed', 'This restore no longer matches what was reviewed');
    return station.restore(root.session_id, digest(root.binding), plan, request, approvedBy);
  }
  /** Item 11: the run's checkpoints, from its own recorded station writes. Read-only. */
  checkpoints(binding: unknown) {
    const { task } = this.owned(binding);
    this.authority.inspect(binding);
    return {
      version: 1 as const,
      task_id: task.id,
      checkpoints: new StationCheckpoints(this.store).list(task),
    };
  }
  /** Item 11: what restoring a checkpoint would do to each file written after it. Read-only. */
  async checkpointDiff(binding: unknown, checkpoint: string) {
    const { task } = this.owned(binding);
    this.authority.inspect(binding);
    const checkpoints = new StationCheckpoints(this.store);
    checkpoints.get(task, checkpoint);
    const station = this.stationBoundary();
    if (!station)
      throw new ServiceError('restore_unavailable', 'A checkpoint diff needs the station boundary');
    return {
      version: 1 as const,
      task_id: task.id,
      ...(await checkpoints.diff(task, checkpoint, await station.live())),
    };
  }
  /** The station boundary, which reads the live workspace and writes restores. */
  private stationBoundary() {
    return (
      this.verification.station as unknown as
        | {
            station?: {
              restore: StationWork['restore'];
              live: StationWork['live'];
              replayed?: StationWork['replayed'];
            };
          }
        | undefined
    )?.station;
  }
  async status(binding: unknown, driver: TaskDriver) {
    const { root, row, task } = this.owned(binding);
    const view = await driver.viewAsync(task.id);
    this.authority.inspect(binding);
    return {
      ...view,
      version: 1 as const,
      work_request_id: String(row.request_id),
      task_id: task.id,
      plan_revision: this.tasks.get(task.id).plan_revision,
      binding_digest: digest(root.binding),
      auto_enabled: !!view.runtime.auto_enabled,
      activity: this.activity(root.session_id),
      plan: planUpdate(view),
      // The owner may settle a stopped run automatically only on this verdict.
      ...(() => {
        const ready = this.settlementReady(binding, root, row, task);
        if (ready === 'known_effects_failure') return { settlement_ready: ready };
        // Which guard refused, for a stopped run only: the owner logs it, so an unsettled run
        // says why instead of "cannot prove". Codes and fixed messages only; no data.
        return ready && this.authority.inspect(binding).revoked
          ? { settlement_refused: ready.refused }
          : {};
      })(),
    };
  }
  /** The latest tool steps, oldest first, for the owner to show as card activity while the work
   * runs. Observation only: it carries no authority and changes nothing. Input is clipped. */
  activity(session: string) {
    return this.store.db
      .prepare(
        "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished','permission.auto-approved','fetch.host_paused') ORDER BY seq DESC LIMIT 64",
      )
      .all(session)
      .reverse()
      .map((row) => {
        const p = JSON.parse(String(row.payload)) as Record<string, unknown>;
        // Approval scopes: a write the run grant answered says so on the card, with the grant.
        // A fetch host paused by the breaker: one line, and the run carries on.
        if (row.kind === 'fetch.host_paused')
          return {
            seq: Number(row.seq),
            phase: 'finished' as const,
            tool_call_id: 'fetch-pause:' + String(row.seq),
            title: `Paused requests to ${String(p.host)} for ${Math.round(Number(p.pause_ms) / 1000)}s after ${Number(p.failures)} failures`,
            kind: null,
            input: null,
            failed: false,
          };
        if (row.kind === 'permission.auto-approved')
          return {
            seq: Number(row.seq),
            phase: 'finished' as const,
            tool_call_id: 'approval:' + String(p.operation_id ?? ''),
            title:
              p.rule === 'run-grant'
                ? 'Approved by the run grant' +
                  (typeof p.granted_by === 'string' ? ` (granted by ${p.granted_by})` : '')
                : p.rule === 'agent-rule'
                  ? "Allowed by the agent's standing rule" +
                    (typeof p.set_by === 'string' ? ` (set by ${p.set_by})` : '')
                  : 'Approved by a standing policy',
            kind: null,
            input: null,
            failed: false,
          };
        const started = row.kind === 'tool.started',
          tool = typeof p.tool === 'string' ? p.tool : '';
        const input = typeof p.input === 'string' ? p.input.slice(0, 2048) : null;
        return {
          seq: Number(row.seq),
          phase: started ? ('started' as const) : ('finished' as const),
          tool_call_id: typeof p.tool_call_id === 'string' ? p.tool_call_id : '',
          title: tool ? toolTitle(tool, p.input) : 'Tool',
          kind: started ? String(p.kind ?? toolMetadata(tool, p.input).kind) : null,
          input: started ? input : null,
          failed: !started && p.failed === true,
        };
      });
  }
  progress(
    binding: unknown,
    request: string,
    workRequest: string,
    steps: number,
    driver: TaskDriver,
  ) {
    const { root, row, task } = this.owned(binding);
    if (workRequest !== row.request_id)
      throw new ServiceError('work_request_conflict', 'Original work request required');
    const receipt = this.store.request(
      'agentpod-work-progression',
      workRequest,
      {
        binding: root.binding,
        request_id: request,
        work_request_id: workRequest,
        max_steps: steps,
        compact: false,
      },
      () => {
        this.store.execution.assert(root.session_id);
        this.assertPlan(task, JSON.parse(String(row.admission_json)));
        // Exactly the plan's steps, or those plus the capped re-run allowance that funds a
        // rate-limited retry or a reopened step; steps complete once, so it never adds work.
        if (
          (steps !== task.steps.length && steps !== task.steps.length + RERUN_ALLOWANCE) ||
          steps < 1 ||
          steps > 32 + RERUN_ALLOWANCE
        )
          throw new ServiceError(
            'invalid_limit',
            'Progression must bind every admitted step within32',
          );
        if (this.store.controlView(root.session_id).expires_at > Date.now())
          throw new ServiceError('control_busy', 'Local controller currently owns this session');
        const runtime = this.store.db
          .prepare('SELECT auto_enabled FROM task_runtime WHERE task_id=?')
          .get(task.id);
        if (runtime?.auto_enabled)
          throw new ServiceError('work_request_conflict', 'Another progression grant exists');
        driver.configureInTransaction(task.id, task.revision, steps, false, () =>
          this.store.execution.assert(root.session_id),
        );
        this.store.execution.assert(root.session_id);
        return {
          version: 1 as const,
          request_id: request,
          work_request_id: workRequest,
          task_id: task.id,
          plan_revision: task.plan_revision,
          binding_digest: digest(root.binding),
        };
      },
    );
    driver.kick();
    return receipt;
  }

  async completion(binding: unknown) {
    const root = this.authority.inspect(binding);
    const row = this.store.db
      .prepare('SELECT * FROM agentpod_work WHERE session_id=?')
      .get(root.session_id);
    if (!row) throw new ServiceError('work_missing', 'Admitted work required');
    const admission = agentpodWorkAdmission(JSON.parse(String(row.admission_json)));
    if (canonical(admission.binding) !== canonical(root.binding))
      throw new ServiceError('work_authority_mismatch', 'Exact work authority required');
    this.store.execution.assert(root.session_id);
    const task = this.tasks.get(String(row.task_id));
    this.assertPlan(task, admission);
    if (!this.verification.station || task.state !== 'succeeded')
      throw new ServiceError('verification_required', 'Protected verified completion required');
    const view = (await this.verification.viewAsync(task)) as {
      completion: Record<string, unknown> | null;
    };
    this.store.execution.assert(root.session_id);
    const current = this.tasks.get(task.id),
      completion = view.completion;
    if (
      current.revision !== task.revision ||
      current.plan_revision !== task.plan_revision ||
      current.state !== 'succeeded' ||
      !completion?.fresh ||
      completion.state !== 'succeeded' ||
      completion.plan_revision !== task.plan_revision
    )
      throw new ServiceError('verification_required', 'Fresh unchanged completion required');
    this.verification.assertIdle(current);
    const record = this.store.db
      .prepare('SELECT * FROM task_completions WHERE task_id=?')
      .get(task.id);
    if (!record || record.artifact_id !== completion.artifact_id)
      throw new ServiceError('verification_required', 'Completion changed');
    const evidence = JSON.parse(this.verification.artifacts.read(String(record.artifact_id)));
    this.store.execution.assert(root.session_id);
    return {
      version: 1 as const,
      state: 'verified' as const,
      work_request_id: String(row.request_id),
      task_id: task.id,
      plan_revision: task.plan_revision,
      binding_digest: digest(root.binding),
      completion_id: String(record.artifact_id),
      evidence_digest: digest(evidence),
    };
  }

  admit(
    session: string,
    value: unknown,
    expected: Pick<AgentPodWorkIdentity, 'board_id' | 'card_id' | 'stage_key'>,
    input: unknown,
    rawPlan: unknown,
  ): AgentPodWorkReceipt {
    const admission = agentpodWorkAdmission(value);
    // Immutable root/principal read binding precedes saved receipt access; freshness
    // is reserved for NEW work below so a lost original reply remains recoverable.
    const root = this.authority.inspect(admission.binding);
    if (root.session_id !== session)
      throw new ServiceError('work_authority_mismatch', 'Work receipt belongs to another session');
    const plan = this.tasks.parse(rawPlan);
    const checked = checkAgentPodWorkAdmission(admission, {
      binding: root.binding,
      work: { ...expected, input_digest: digest(input), plan_digest: digest(plan) },
    });
    if (!checked.ok)
      throw new ServiceError(
        checked.code,
        'Work admission does not match admitted bytes or authority',
      );
    const receipt = this.store.request<AgentPodWorkReceipt>(
      'agentpod-work',
      admission.request_id,
      { kind: 'work-admit', session, admission, input, plan },
      () => {
        this.store.execution.assert(session);
        if (canonical(this.authority.binding(session)) !== canonical(admission.binding))
          throw new ServiceError('work_authority_mismatch', 'Work authority changed');
        const runKey = canonical({
          organization: admission.binding.organization_id,
          source: admission.binding.run.source,
          run: admission.binding.run.id,
        });
        const table = this.store.db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agentpod_work'")
          .get();
        if (
          table &&
          this.store.db
            .prepare('SELECT 1 FROM agentpod_work WHERE run_key=? OR session_id=?')
            .get(runKey, session)
        )
          throw new ServiceError(
            'work_request_conflict',
            'Recover the original work request; this run already owns a task',
          );
        if (
          this.store.hasUnknown(session) ||
          this.store.db
            .prepare(
              "SELECT 1 FROM station_calls WHERE session_id=? AND (state IN ('prepared','dispatching','outcome_unknown') OR helper_state NOT IN ('none','stopped'))",
            )
            .get(session) ||
          this.store.db
            .prepare("SELECT 1 FROM station_units WHERE session_id=? AND state!='stopped'")
            .get(session)
        )
          throw new ServiceError('work_uncertain', 'Station execution is active or not reconciled');
        const task = this.tasks.createInTransaction(session, admission.request_id, 0, plan, () =>
          this.store.execution.assert(session),
        );
        this.verification.assertIdle(task);
        // Admission requires the configured verifier to prove its actual execution
        // binding. A missing or unready backend rolls the entire task back.
        const verification = this.verification.binding(task);
        // Filesystem/profile verification can consume the remaining lease window.
        this.store.execution.assert(session);
        this.store.db.exec(`CREATE TABLE IF NOT EXISTS agentpod_work(
          run_key TEXT PRIMARY KEY NOT NULL,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
          task_id TEXT NOT NULL UNIQUE REFERENCES durable_tasks(id),request_id TEXT NOT NULL UNIQUE,
          admission_json TEXT NOT NULL,verification_json TEXT NOT NULL);
          `);
        if (Number(this.store.db.prepare('PRAGMA user_version').get()!.user_version) < 29)
          this.store.db.exec('PRAGMA user_version=29');
        this.store.db
          .prepare('INSERT INTO agentpod_work VALUES (?,?,?,?,?,?)')
          .run(
            runKey,
            session,
            task.id,
            admission.request_id,
            canonical(admission),
            canonical(verification),
          );
        const receipt: AgentPodWorkReceipt = {
          version: 1,
          state: 'admitted',
          session_id: session,
          task_id: task.id,
          request_id: admission.request_id,
          binding_digest: digest(admission.binding),
          plan_revision: task.plan_revision,
        };
        this.store.event(session, 'agentpod.work_admitted', receipt, admission.request_id);
        return receipt;
      },
    );
    const saved = this.store.db
      .prepare(
        'SELECT task_id,admission_json FROM agentpod_work WHERE session_id=? AND request_id=?',
      )
      .get(session, admission.request_id);
    if (
      !saved ||
      saved.task_id !== receipt.task_id ||
      saved.admission_json !== canonical(admission)
    )
      throw new ServiceError(
        'invalid_work_record',
        'Saved task admission mapping is unavailable or changed',
      );
    return receipt;
  }
}
