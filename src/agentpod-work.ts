import type { Store } from './store.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import type { TaskWork, WorkTask } from './task-work.js';
import type { TaskDriver } from './task-driver.js';
import type { TaskVerification } from './task-verification.js';
import { canonical, digest, ServiceError } from './protocol.js';
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
        if (
          task.state !== 'blocked' ||
          !runtime ||
          runtime.blocked_reason !== bound ||
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
            .get(root.session_id)
        )
          throw new ServiceError(
            'work_settlement_unsafe',
            'Only exact budget-blocked interrupted work with one known approved patch can retire',
          );
        const evidence_digest = digest({
          binding: root.binding,
          task_id: task.id,
          plan_revision: task.plan_revision,
          blocked_reason: runtime.blocked_reason,
          attempt,
          operation: op,
          approval,
          call,
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
