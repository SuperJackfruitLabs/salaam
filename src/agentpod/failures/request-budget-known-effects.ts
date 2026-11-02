import { canonical, digest } from '../../core/index.js';
import { noLedgeredEffects } from './ledgers.js';
import { budgetInterruption } from './budget-interruption.js';
import { operatorMcpCalls } from './operator-mcp-tools.js';
import type { FailureRule, Row, RuleStore, StoppedRun } from './rule.js';

/** An attempt the request-budget control interrupted after its approved work had succeeded:
 * each workspace write approved, applied through exactly one returned patch call and recorded
 * with that call's own receipt, and any review approved and read-only. Every other station call
 * is a closed read or a returned check whose unit stopped with a complete proof, and no tool ran
 * after the stop. The applied writes and the review are the known effects. */
export class RequestBudgetStopKnownEffects implements FailureRule {
  readonly name = 'request_budget_stop_known_effects';
  constructor(private readonly store: RuleStore) {}
  match(run: StoppedRun) {
    const { session, binding, task } = run;
    const stop = budgetInterruption(this.store, run);
    if (!stop) return null;
    const { attempt, events, unhealthy, interrupted } = stop;
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = this.store.db
      .prepare('SELECT * FROM station_calls WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (!ops.length) return null;
    const effects = this.knownEffects(digest(binding), attempt, ops, calls);
    if (!effects) return null;
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
    const mcp = operatorMcpCalls(events, {
      attempt: attempt.id,
      before: Number(unhealthy.seq),
      tools: ['salaam_operator_mcp', 'salaam_station', 'salaam_board', 'salaam_review'],
      outcomes: ['returned', 'failed', 'tool_error'],
    });
    if (!mcp) return null;
    const units = noLedgeredEffects(this.store, session, task, {
      operations: true,
      stationCalls: true,
      checkUnits: checks,
    });
    if (!units) return null;
    return {
      unhealthy,
      interrupted,
      known_effects: effects,
      station_calls: others.map((c) => ({ id: c.id, kind: c.kind, input_digest: c.input_digest })),
      operator_mcp_calls: mcp,
      unbound_stopped_units: units,
    };
  }
  /** Each operation an approved effect of the attempt: a write applied with its call's own
   * receipt, or a read-only review. Null when any is not. */
  private knownEffects(
    root: string,
    attempt: Row,
    ops: Row[],
    calls: Row[],
  ): Record<string, unknown>[] | null {
    const effects: Record<string, unknown>[] = [];
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
    return effects;
  }
}
