import type { FailureRule, MissReporting, RuleStore, StoppedRun } from './rule.js';

export const CHECK_FAILED_MISSES = [
  'cf:reason',
  'cf:check',
  'cf:task_state',
  'cf:auto',
  'cf:reserved',
  'cf:attempts',
  'cf:steps',
  'cf:operations',
  'cf:approvals',
  'cf:calls',
  'cf:children',
] as const;
export type CheckFailedMiss = (typeof CHECK_FAILED_MISSES)[number];

/** A task its own acceptance check stopped (staging card_d74eac4509f1453c): the latest receipt
 * for the check the stop names failed definitely, and the run is as closed as a
 * verification-budget stop. The board then gets a failed run with that reason, not a park. */
export class CheckFailedStop implements FailureRule, MissReporting<CheckFailedMiss> {
  readonly name = 'check_failed_stop';
  miss: CheckFailedMiss | null = null;
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
    const miss = (code: CheckFailedMiss) => {
      this.miss = code;
      return null;
    };
    this.miss = null;
    const prefix = 'Verification failed or became stale: ';
    const reason = String(runtime?.auto_error ?? '');
    if (!runtime || runtime.blocked_reason || !reason.startsWith(prefix)) return miss('cf:reason');
    const db = this.store.db;
    const check = db
      .prepare(
        'SELECT id,state FROM task_checks WHERE task_id=? AND check_key=? AND plan_revision=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(task.id, reason.slice(prefix.length), task.plan_revision) as
      { id: string; state: string } | undefined;
    if (check?.state !== 'failed') return miss('cf:check');
    if (!['blocked', 'partially_completed'].includes(task.state)) return miss('cf:task_state');
    if (runtime.auto_enabled) return miss('cf:auto');
    if (runtime.reserved_requests || runtime.reserved_tokens) return miss('cf:reserved');
    if (
      !attempts.length ||
      attempts.some((a) => !['completed', 'failed'].includes(String(a.state)))
    )
      return miss('cf:attempts');
    if (task.steps.some((s) => !['completed', 'failed'].includes(s.state))) return miss('cf:steps');
    const operations = db
      .prepare('SELECT id,state FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = db
      .prepare(
        'SELECT id,kind,state,helper_state FROM station_calls WHERE session_id=? ORDER BY rowid',
      )
      .all(session);
    if (operations.some((o) => !['succeeded', 'failed_definite'].includes(String(o.state))))
      return miss('cf:operations');
    if (db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'").get(session))
      return miss('cf:approvals');
    if (
      calls.some(
        (c) =>
          ['prepared', 'dispatching', 'outcome_unknown'].includes(String(c.state)) ||
          !['none', 'stopped'].includes(String(c.helper_state)),
      )
    )
      return miss('cf:calls');
    if (db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session))
      return miss('cf:children');
    return {
      reason,
      check: check.id,
      steps: task.steps.map((s) => ({ id: s.id, state: s.state })),
      attempts: attempts.map((a) => ({ id: a.id, state: a.state })),
      operations,
      calls,
    };
  }
}
