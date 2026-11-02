import type { FailureRule, MissReporting, RuleStore, StoppedRun } from './rule.js';

/** Which part of the verification-budget stop shape a run misses: a closed set of codes, so a
 * refusal can say why without carrying any data. */
export const VERIFICATION_LIMIT_MISSES = [
  'vl:task_state',
  'vl:reason',
  'vl:auto',
  'vl:reserved',
  'vl:attempts',
  'vl:steps',
  'vl:operations',
  'vl:approvals',
  'vl:calls',
  'vl:children',
] as const;
export type VerificationLimitMiss = (typeof VERIFICATION_LIMIT_MISSES)[number];

/** A task its verification budget stopped after every step finished (staging run_54648a07).
 * Everything is closed and definite: every attempt completed or failed, every step completed or
 * failed, every operation succeeded or failed definitely with no approval pending, every station
 * call settled with its helper stopped, nothing reserved, no children. */
export class VerificationLimitStop implements FailureRule, MissReporting<VerificationLimitMiss> {
  readonly name = 'verification_limit_stop';
  miss: VerificationLimitMiss | null = null;
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
    const miss = (code: VerificationLimitMiss) => {
      this.miss = code;
      return null;
    };
    this.miss = null;
    // The stop is the verification budget's: the current reason, or the run's first budget block
    // when its runtime limit overwrote the reason later while it sat parked (staging run_54648a07).
    const firstBlock = this.store.db
      .prepare(
        "SELECT json_extract(payload,'$.reason') AS reason FROM events WHERE session_id=? AND kind='work_task.budget_blocked' AND json_extract(payload,'$.task_id')=? ORDER BY seq LIMIT 1",
      )
      .get(session, task.id) as { reason?: string } | undefined;
    if (
      !runtime ||
      !(
        runtime.blocked_reason === 'Task verification run limit reached' ||
        (runtime.blocked_reason === 'Task runtime limit reached' &&
          firstBlock?.reason === 'Task verification run limit reached')
      )
    )
      return miss('vl:reason');
    if (!['blocked', 'partially_completed'].includes(task.state)) return miss('vl:task_state');
    if (runtime.auto_enabled) return miss('vl:auto');
    if (runtime.reserved_requests || runtime.reserved_tokens) return miss('vl:reserved');
    if (
      !attempts.length ||
      attempts.some((a) => !['completed', 'failed'].includes(String(a.state)))
    )
      return miss('vl:attempts');
    if (task.steps.some((s) => !['completed', 'failed'].includes(s.state))) return miss('vl:steps');
    const db = this.store.db;
    const operations = db
      .prepare('SELECT id,state FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = db
      .prepare(
        'SELECT id,kind,state,helper_state FROM station_calls WHERE session_id=? ORDER BY rowid',
      )
      .all(session);
    if (operations.some((o) => !['succeeded', 'failed_definite'].includes(String(o.state))))
      return miss('vl:operations');
    if (db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'").get(session))
      return miss('vl:approvals');
    if (
      calls.some(
        (c) =>
          ['prepared', 'dispatching', 'outcome_unknown'].includes(String(c.state)) ||
          !['none', 'stopped'].includes(String(c.helper_state)),
      )
    )
      return miss('vl:calls');
    if (db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session))
      return miss('vl:children');
    return {
      steps: task.steps.map((s) => ({ id: s.id, state: s.state })),
      attempts: attempts.map((a) => ({ id: a.id, state: a.state })),
      operations,
      calls,
    };
  }
}
