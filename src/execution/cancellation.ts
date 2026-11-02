// Cancelling an attempt: a queued one never runs, its prepared operations are cancelled before
// dispatch, and a dispatched one's outcome becomes unknown. The caller holds the transaction.
import type { Operation } from '../core/index.js';
import type { OwnedResultDeps } from './owned-results.js';

export function cancelInTransaction(
  d: OwnedResultDeps,
  attempt: string,
  request: string,
  actor = 'local-operator',
) {
  if (!d.store.db.isTransaction) throw new Error('Cancellation requires a transaction');
  const work = d.store.attempt(attempt);
  d.store.db.prepare('INSERT OR IGNORE INTO cancellations VALUES (?,?)').run(attempt, actor);
  if (work.state === 'accepted') {
    d.store.db.prepare("UPDATE attempts SET state='cancelled' WHERE id=?").run(attempt);
    d.store.db
      .prepare("UPDATE submissions SET state='cancelled' WHERE id=?")
      .run(work.submission_id);
    d.store.finishChild?.(d.store.attempt(attempt));
    d.store.projectTaskAttempt?.(d.store.attempt(attempt));
  }
  const ops = d.store.db
    .prepare("SELECT * FROM operations WHERE attempt_id=? AND state IN ('prepared','dispatching')")
    .all(attempt) as unknown as Operation[];
  for (const op of ops) {
    d.records.invalidateApproval(d.records.forOperation(op.id), 'invalidated');
    d.records.transition(
      op,
      op.state === 'prepared' ? 'cancelled_before_dispatch' : 'outcome_unknown',
      'Cancellation requested',
    );
  }
  d.store.cancelChildren?.(attempt);
  d.store.event(work.session_id, 'attempt.cancel_requested', { attempt_id: attempt }, request);
  return {
    attempt_id: attempt,
    cancel_requested: true as const,
    unresolved_operations: (
      d.store.db
        .prepare("SELECT id FROM operations WHERE attempt_id=? AND state='outcome_unknown'")
        .all(attempt) as { id: string }[]
    ).map((row) => row.id),
  };
}
