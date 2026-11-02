// Historical retirement of closed, policy-admitted reads: the run's whole journal, read back in a
// fixed order of steps, shows nothing but completed reads (and at most one boundary write, either
// offered and expired unanswered, or approved and applied). Each step reads its part of the
// journal into the audit and throws when the history is incomplete; any throw is uncertainty.
import type { AgentPodBinding, WorkTask } from '../../core/index.js';
import type { FailureRule, Row } from './rule.js';
import { appliedBoundary } from './history/applied.js';
import { historyRun, modelGrants, stepAttempts } from './history/attempts.js';
import { stationCalls, taskChecks } from './history/checks.js';
import { openHistory, type Applied, type Expiry, type HistoryDeps } from './history/context.js';
import { expiredBoundary } from './history/expiry.js';
import { delegatedChildren, effectLedgers, mcpReads } from './history/ledgers.js';
import { closedTools } from './history/tools.js';

export type { Applied, Expiry, HistoryDeps } from './history/context.js';

/** A run's history, with the boundary write it may hold. */
export interface HistoryInput {
  readonly binding: AgentPodBinding;
  readonly task: WorkTask;
  readonly runtime: Row | undefined;
  readonly expiry?: Expiry;
  readonly applied?: Applied;
}

/** Historical retirement of closed, policy-admitted reads. This does not
 * revalidate freshness, replay a check, or turn a protocol return into success. */
export class HistoricalKnownReadOnly implements FailureRule<HistoryInput> {
  readonly name = 'historical_known_readonly';
  constructor(private readonly deps: HistoryDeps) {}
  /** The audit of every row and artifact the history was proven from, or null. */
  match({ binding, task, runtime, expiry, applied }: HistoryInput): Record<string, unknown> | null {
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
      const h = openHistory(this.deps, binding, task, runtime);
      const unapplied = expiry ? expiredBoundary(h, expiry) : null;
      const run = historyRun(h, unapplied);
      modelGrants(h, run);
      const rootAttempts = stepAttempts(h, run, unapplied);
      const appliedPatch = applied ? appliedBoundary(h, applied) : null;
      const workers = effectLedgers(h, run, expiry || applied);
      delegatedChildren(h, run, rootAttempts, workers);
      const mcp = mcpReads(h, run, rootAttempts);
      const station = taskChecks(h, run);
      stationCalls(h, station, unapplied, appliedPatch);
      closedTools(h, run, mcp, unapplied, appliedPatch);
      h.audit.artifacts = h.artifactAudit;
      return h.audit;
    } catch {
      // Corrupt/missing source evidence is uncertainty, never a permissive default.
      return null;
    }
  }
}
