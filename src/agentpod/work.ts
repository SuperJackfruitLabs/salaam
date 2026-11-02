import { BoardReads } from '../runtime/index.js';
import type { StationWork } from './station-work.js';
import { StationCheckpoints } from './station-checkpoints.js';
import {
  planUpdate,
  canonical,
  digest,
  ServiceError,
  agentpodWorkAdmission,
  checkAgentPodWorkAdmission,
  type AgentPodBinding,
  type AgentPodWorkIdentity,
} from '../core/index.js';
import type { Store } from '../store/index.js';
import type { AgentPodAuthority } from './authority.js';
import type { TaskWork, TaskDriver, TaskVerification } from '../tasks/index.js';
import type { WorkTask } from '../core/index.js';
import { bindWorkTrace } from '../execution/index.js';
import { executionEvidence } from './evidence.js';
import { CHECK_FAILED_MISSES } from './failures/check-failed-stop.js';
import { KnownEffectsFailure } from './failures/known-effects.js';
import { MultiOfferReviewExpiry } from './failures/multi-offer-review-expiry.js';
import { unreportedLocalSuccess } from './failures/unreported-local-success.js';
import { VERIFICATION_LIMIT_MISSES } from './failures/verification-limit-stop.js';
import { workActivity } from './work-activity.js';

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
  /** Which part of the verification-budget stop shape a run misses (see its failure rule). */
  static readonly VERIFICATION_LIMIT_MISSES = VERIFICATION_LIMIT_MISSES;
  /** Which part of the check-failed stop shape a run misses (see its failure rule). */
  static readonly CHECK_FAILED_MISSES = CHECK_FAILED_MISSES;
  /** The stopped-run shapes a known-effects retirement can prove, asked in their fixed order. */
  private readonly failures: KnownEffectsFailure;
  /** The several-offer shape an expiry can prove when its history alone does not. */
  private readonly multiOffer: MultiOfferReviewExpiry;
  constructor(
    readonly store: Store,
    readonly authority: AgentPodAuthority,
    readonly tasks: TaskWork,
    readonly verification: TaskVerification,
  ) {
    this.failures = new KnownEffectsFailure(this);
    this.multiOffer = new MultiOfferReviewExpiry(store);
  }

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
            ? this.failures.history.match({
                binding: root.binding,
                task,
                runtime,
                expiry: { operation: op, approval, offered },
              })
            : null;
        const multi =
          !simple && !history
            ? this.multiOffer.match({ session: root.session_id, task, runtime, offered })
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
        const evidence_digest = this.failures.evidence(root, task);
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
  /** Status's read-only verdict: "known_effects_failure" when fail() would retire this run now. */
  private settlementReady(
    binding: unknown,
    root: { session_id: string; binding: AgentPodBinding },
    row: Record<string, unknown>,
    task: WorkTask,
  ): 'known_effects_failure' | { refused: string } {
    try {
      this.assertKnownEffectsStop(binding);
      this.assertPlan(task, JSON.parse(String(row.admission_json)));
      this.failures.evidence(root, task);
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
        const rootDigest = digest(root.binding);
        const evidence = unreportedLocalSuccess(this, root.session_id, rootDigest, task);
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
          evidence_digest: digest(evidence),
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
      // Board reads the agent is waiting on; the owner serves them (operator ruling 2026-10-28).
      ...(() => {
        const reads = new BoardReads(this.store).pending(root.session_id);
        return reads.length ? { board_reads: reads } : {};
      })(),
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
  /** The owner's answer to one of this run's board reads. */
  answerBoardRead(binding: unknown, answer: unknown) {
    const { root } = this.owned(binding);
    return new BoardReads(this.store).answer(root.session_id, answer);
  }
  /** The latest tool steps, oldest first, for the owner to show as card activity while the work
   * runs. Observation only: it carries no authority and changes nothing. Input is clipped. */
  /** The latest tool steps, oldest first, for the owner to show as card activity while the work
   * runs. Observation only: it carries no authority and changes nothing. Input is clipped. */
  activity(session: string) {
    return workActivity(this.store, session);
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
