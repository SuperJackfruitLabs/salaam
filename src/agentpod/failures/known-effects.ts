// The evidence a known-effects retirement records, or work_settlement_unsafe when the stopped run
// is not one of the exact shapes Salaam can prove. Reads only; fail() and status share it.
import { digest, ServiceError, type AgentPodBinding, type WorkTask } from '../../core/index.js';
import type { Artifacts, Store } from '../../store/index.js';
import { exactApprovedPatch, TOKEN_BOUND_STOP } from './approved-patch.js';
import { CheckFailedStop } from './check-failed-stop.js';
import { HistoricalKnownReadOnly } from './historical-known-readonly.js';
import { RateLimitStop } from './rate-limit-stop.js';
import { RequestBudgetStopKnownEffects } from './request-budget-known-effects.js';
import { RequestBudgetStop } from './request-budget-stop.js';
import { RevokeCancelled } from './revoke-cancelled.js';
import type { FailureRule, Row, StoppedRun } from './rule.js';
import { RuntimeStopRefusedWrites } from './runtime-stop-refused-writes.js';
import { VerificationLimitStop } from './verification-limit-stop.js';
import { ZeroEffectConcurrency } from './zero-effect-concurrency.js';

/** What the known-effects rules read through. */
export interface KnownEffectsDeps {
  readonly store: Store;
  readonly verification: { readonly artifacts: Pick<Artifacts, 'read'> };
}

const UNPROVABLE =
  'Only exact known approved-patch, zero-effect child denial, revoke-cancelled operator MCP reads, request budget stopped operator MCP reads, runtime-stopped refused workspace writes, request budget stopped known effects, a closed rate-limit, verification-budget or check-failed stop, or closed historical read-only evidence can retire';

export class KnownEffectsFailure {
  readonly history: HistoricalKnownReadOnly;
  private readonly verificationLimit: VerificationLimitStop;
  private readonly checkFailed: CheckFailedStop;
  /** The stop shapes, in the order they are asked; the first that matches is the evidence. */
  private readonly stops: FailureRule[];

  constructor(private readonly deps: KnownEffectsDeps) {
    const store = deps.store;
    this.history = new HistoricalKnownReadOnly(deps);
    this.verificationLimit = new VerificationLimitStop(store);
    this.checkFailed = new CheckFailedStop(store);
    this.stops = [
      new ZeroEffectConcurrency(store),
      new RevokeCancelled(store),
      new RequestBudgetStop(store),
      new RuntimeStopRefusedWrites(store),
      new RequestBudgetStopKnownEffects(store),
      new RateLimitStop(store),
      this.verificationLimit,
      this.checkFailed,
    ];
  }

  /** The evidence digest, or work_settlement_unsafe naming why it is not provable. */
  evidence(root: { session_id: string; binding: AgentPodBinding }, task: WorkTask): string {
    const db = this.deps.store.db;
    const runtime = db.prepare('SELECT * FROM task_runtime WHERE task_id=?').get(task.id);
    const attempts = db.prepare('SELECT * FROM attempts WHERE session_id=?').all(root.session_id);
    const ops = db.prepare('SELECT * FROM operations WHERE session_id=?').all(root.session_id);
    const calls = db
      .prepare("SELECT * FROM station_calls WHERE session_id=? AND kind!='read'")
      .all(root.session_id);
    const op = ops[0],
      attempt = attempts[0],
      call = calls[0];
    const approval = op
      ? db.prepare('SELECT * FROM approvals WHERE operation_id=?').get(String(op.id))
      : undefined;
    const effect = op?.receipt ? JSON.parse(String(op.receipt)) : null;
    const originalBlock = db
      .prepare(
        "SELECT seq,payload FROM events WHERE session_id=? AND kind='work_task.budget_blocked' AND json_extract(payload,'$.task_id')=? AND json_extract(payload,'$.reason')=? ORDER BY seq LIMIT 1",
      )
      .get(root.session_id, task.id, TOKEN_BOUND_STOP);
    const runtimeExpired =
      runtime?.blocked_reason === 'Task runtime limit reached' &&
      runtime.started_at !== null &&
      Number.isFinite(Number(runtime.started_at)) &&
      Date.now() - Number(runtime.started_at) >= task.limits.runtime_ms;

    const knownReadOnly = this.knownReadOnly(root.binding, task, runtime, ops, op, approval);
    const run: StoppedRun = {
      session: root.session_id,
      binding: root.binding,
      task,
      runtime,
      attempts,
    };
    let stop: { name: string; evidence: unknown } | null = null;
    for (const rule of this.stops) {
      const evidence = rule.match(run);
      if (evidence) {
        stop = { name: rule.name, evidence };
        break;
      }
    }
    if (
      !stop &&
      !knownReadOnly &&
      !exactApprovedPatch(this.deps.store, {
        ...run,
        ops,
        calls,
        attempt,
        op,
        call,
        approval,
        effect,
        originalBlock,
        runtimeExpired,
      })
    )
      throw new ServiceError('work_settlement_unsafe', this.unprovable());
    return digest({
      binding: root.binding,
      task_id: task.id,
      plan_revision: task.plan_revision,
      blocked_reason: runtime!.blocked_reason,
      attempt,
      operation: op ?? null,
      approval: approval ?? null,
      call: call ?? null,
      ...(stop ? { [stop.name]: stop.evidence } : {}),
      ...(knownReadOnly ? { historical_known_readonly: knownReadOnly } : {}),
    });
  }

  /** The historical read-only audit: plain, then with its one write invalidated unanswered (the
   * saved offer still there), then with it approved and applied. */
  private knownReadOnly(
    binding: AgentPodBinding,
    task: WorkTask,
    runtime: Row | undefined,
    ops: Row[],
    op: Row | undefined,
    approval: Row | undefined,
  ): Record<string, unknown> | null {
    const savedInvalidatedOffer =
      approval?.state === 'invalidated'
        ? this.deps.store.db
            .prepare(
              "SELECT response FROM requests WHERE actor='agentpod-work-decision-offer' AND id=?",
            )
            .get(String(approval.id))
        : undefined;
    return (
      this.history.match({ binding, task, runtime }) ??
      (ops.length === 1 && op && approval && savedInvalidatedOffer
        ? this.history.match({
            binding,
            task,
            runtime,
            expiry: {
              operation: op,
              approval,
              offered: JSON.parse(String(savedInvalidatedOffer.response)),
              invalidated: true,
            },
          })
        : null) ??
      (ops.length === 1 && op && approval
        ? this.history.match({ binding, task, runtime, applied: { operation: op, approval } })
        : null)
    );
  }

  /** Which guard refused: the verification-budget or check-failed shape's miss, when the run was
   * that kind of stop, else the closed list of what can retire. Codes and fixed text only. */
  private unprovable(): string {
    const vl = this.verificationLimit.miss,
      cf = this.checkFailed.miss;
    if (vl && vl !== 'vl:reason') return 'Verification-budget stop not provable: ' + vl;
    if (cf && cf !== 'cf:reason') return 'Check-failed stop not provable: ' + cf;
    return UNPROVABLE;
  }
}
