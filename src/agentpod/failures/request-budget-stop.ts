import { noLedgeredEffects } from './ledgers.js';
import { budgetInterruption } from './budget-interruption.js';
import { operatorMcpCalls } from './operator-mcp-tools.js';
import type { FailureRule, RuleStore, StoppedRun } from './rule.js';

/** An attempt the request-budget control interrupted after its operator MCP calls kept failing:
 * every call is journaled as failed or tool_error, the only station calls are closed reads, and
 * no tool ran after the stop. The failed calls are preserved as the known effects. */
export class RequestBudgetStop implements FailureRule {
  readonly name = 'request_budget_stop';
  constructor(private readonly store: RuleStore) {}
  match(run: StoppedRun) {
    const { session, task } = run;
    // Stopped by the budget control, not cancelled by anyone.
    const stop = budgetInterruption(this.store, run);
    if (!stop) return null;
    const { attempt, events, unhealthy, interrupted } = stop;
    // Tools: operator MCP (catalog reads, or a journaled failed call) and station reads, every one
    // closed before the stop.
    const calls = operatorMcpCalls(events, {
      attempt: attempt.id,
      before: Number(unhealthy.seq),
      tools: ['salaam_operator_mcp', 'salaam_station', 'salaam_board'],
      outcomes: ['failed', 'tool_error'],
    });
    if (!calls) return null;
    const units = noLedgeredEffects(this.store, session, task, { stationReads: true });
    if (!units) return null;
    return {
      unhealthy,
      interrupted,
      operator_mcp_calls: calls,
      reads: this.store.db
        .prepare('SELECT id,input_digest FROM station_calls WHERE session_id=? ORDER BY id')
        .all(session),
      unbound_stopped_units: units,
    };
  }
}
