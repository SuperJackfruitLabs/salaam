import type { Store } from './store.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import type { TaskWork, WorkTask } from './task-work.js';
import type { TaskDriver } from './task-driver.js';
import type { TaskVerification } from './task-verification.js';
import { canonical, digest, ServiceError } from './protocol.js';
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
        if (
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
        )
          throw new ServiceError(
            'work_settlement_unsafe',
            'Only the exact expired unanswered unapplied operation can be settled',
          );
        driver.cancelInTransaction(task.id, task.revision, stopped);
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
      if (
        unit.session_id !== null ||
        unit.call_id !== null ||
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
    return {
      block: blocks[0],
      activity,
      model: models[0],
      policy: policies[0],
      link: links[0],
      unbound_stopped_units: units,
    };
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
    const stopped = () => {
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
    };
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

        const zeroEffect = this.zeroEffectConcurrencyFailure(
          root.session_id,
          task,
          runtime,
          attempts,
        );
        if (
          !zeroEffect &&
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
            'Only exact budget-blocked interrupted work with one known approved patch or a proven zero-effect child denial can retire',
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
        });
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
          task.acceptance.some(
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
    };
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
        if (steps !== task.steps.length || steps < 1 || steps > 32)
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
