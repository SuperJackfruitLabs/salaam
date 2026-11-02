import { RATE_LIMIT_STOP, RateLimitRetries } from '../../providers/index.js';
import type { Store } from '../../store/index.js';
import type { FailureRule, StoppedRun } from './rule.js';

/** A task the provider rate limit stopped after its retries (RATE_LIMIT_STOP). Everything is
 * closed and definite: every attempt completed or failed, the one failed step's last attempt
 * rate-limited and recorded by the driver, every operation succeeded or failed definitely with
 * no approval pending, every station call settled with its helper stopped, no children. */
export class RateLimitStop implements FailureRule {
  readonly name = 'rate_limit_stop';
  constructor(private readonly store: Store) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
    if (
      !['blocked', 'partially_completed'].includes(task.state) ||
      !runtime ||
      runtime.blocked_reason !== RATE_LIMIT_STOP ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      attempts.some((a) => !['completed', 'failed'].includes(String(a.state)))
    )
      return null;
    const failed = task.steps.filter((s) => s.state === 'failed');
    if (
      failed.length !== 1 ||
      task.steps.some((s) => !['completed', 'failed', 'pending'].includes(s.state))
    )
      return null;
    const last = failed[0]!.attempt_id ?? '';
    const limits = new RateLimitRetries(this.store);
    const recorded = this.store.db
      .prepare(
        'SELECT attempt_id,failures FROM task_rate_limits WHERE task_id=? AND step_id=? ORDER BY failures',
      )
      .all(task.id, failed[0]!.id);
    if (!limits.rateLimited(last) || !recorded.some((r) => r.attempt_id === last)) return null;
    const db = this.store.db;
    const operations = db
      .prepare('SELECT id,state FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = db
      .prepare(
        'SELECT id,kind,state,helper_state FROM station_calls WHERE session_id=? ORDER BY rowid',
      )
      .all(session);
    if (
      operations.some((o) => !['succeeded', 'failed_definite'].includes(String(o.state))) ||
      db.prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'").get(session) ||
      calls.some(
        (c) =>
          ['prepared', 'dispatching', 'outcome_unknown'].includes(String(c.state)) ||
          !['none', 'stopped'].includes(String(c.helper_state)),
      ) ||
      db.prepare('SELECT 1 FROM child_tasks WHERE parent_session=?').get(session)
    )
      return null;
    return {
      step_id: failed[0]!.id,
      attempts: attempts.map((a) => ({ id: a.id, state: a.state })),
      rate_limited: recorded,
      operations,
      calls,
    };
  }
}
