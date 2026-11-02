// The request-budget control's interruption of a run's one attempt, shared by the rules for what
// the attempt did before it: the journal shows the control stopped it, and nobody cancelled it.
import type { Row, RuleStore, StoppedRun } from './rule.js';

/** The interrupted attempt, the session's events in order, and the stop's two events. */
export interface BudgetInterruption {
  attempt: Row;
  events: Row[];
  unhealthy: Row;
  interrupted: Row;
}

/** The run's one attempt the request-budget control interrupted, or null. */
export function budgetInterruption(
  store: RuleStore,
  { session, task, runtime, attempts }: StoppedRun,
): BudgetInterruption | null {
  const reason = 'Required control failed: No model request budget remains',
    // Picked by state, never by row order; the count below rejects any other attempt.
    attempt = attempts.find((a) => a.state === 'interrupted');
  if (
    task.state !== 'blocked' ||
    !runtime ||
    runtime.auto_enabled ||
    runtime.reserved_requests ||
    runtime.reserved_tokens ||
    runtime.verification_runs ||
    attempts.length !== 1 ||
    !attempt ||
    attempt.error !== reason ||
    attempt.resolved_by !== null ||
    attempt.continues_attempt_id !== null ||
    attempt.result !== null
  )
    return null;
  const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
  if (
    steps.length !== 1 ||
    steps[0]!.state !== 'interrupted' ||
    task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
  )
    return null;
  // Stopped by the budget control, not cancelled by anyone.
  if (store.db.prepare('SELECT 1 FROM cancellations WHERE attempt_id=?').get(String(attempt.id)))
    return null;
  const events = store.db
    .prepare('SELECT seq,kind,payload FROM events WHERE session_id=? ORDER BY seq')
    .all(session);
  const of = (e: Row) => JSON.parse(String(e.payload));
  const unhealthy = events.filter((e) => e.kind === 'worker.unhealthy'),
    interrupted = events.filter((e) => e.kind === 'attempt.interrupted');
  if (
    unhealthy.length !== 1 ||
    interrupted.length !== 1 ||
    of(unhealthy[0]!).error !== reason ||
    of(interrupted[0]!).attempt_id !== attempt.id ||
    of(interrupted[0]!).error !== reason ||
    Number(unhealthy[0]!.seq) >= Number(interrupted[0]!.seq)
  )
    return null;
  return { attempt, events, unhealthy: unhealthy[0]!, interrupted: interrupted[0]! };
}
