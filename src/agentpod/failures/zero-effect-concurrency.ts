import { canonical } from '../../core/index.js';
import { noLedgeredEffects } from './ledgers.js';
import type { FailureRule, Row, RuleStore, StoppedRun } from './rule.js';

/** A disjoint failure profile: the native child was denied before any effect
 * ledger was created. Stopped resources alone never establish zero effects. */
export class ZeroEffectConcurrency implements FailureRule {
  readonly name = 'zero_effect_concurrency';
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
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
    const admitted = this.admittedSpawn(
      session,
      attempt,
      Number(activity[0]!.seq),
      Number(blocks[0]!.seq),
    );
    if (!admitted) return null;
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
    const units = noLedgeredEffects(this.store, session, task);
    if (!units) return null;
    return {
      block: blocks[0],
      activity,
      model: admitted.model,
      policy: admitted.policy,
      link: links[0],
      unbound_stopped_units: units,
    };
  }
  /** The one model admission before the spawn tool, and the one policy grant for it between the
   * tool and the budget block. Null otherwise. */
  private admittedSpawn(
    session: string,
    attempt: Row,
    toolSeq: number,
    blockSeq: number,
  ): { model: Row; policy: Row } | null {
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
      Number(models[0]!.seq) >= toolSeq ||
      policy.tool !== 'spawn_child' ||
      policy.attempt_id !== attempt.id ||
      policy.epoch !== attempt.worker_epoch ||
      Number(policies[0]!.seq) <= toolSeq ||
      Number(policies[0]!.seq) >= blockSeq
    )
      return null;
    return { model: models[0]!, policy: policies[0]! };
  }
}
