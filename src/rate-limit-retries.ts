import type { Store } from './store.js';

/**
 * A provider 429 on a step is retried as a fresh admitted attempt of that step, after a backoff,
 * up to RATE_LIMIT_MAX_FAILURES rate-limited attempts in all. Each retry is a new attempt with its
 * own admission and budget charge, never a replay of the refused request. After the last one the
 * task stops with RATE_LIMIT_STOP, a block the stopped-run recovery can prove and settle.
 */
export const RATE_LIMIT_MAX_FAILURES = 3;
export const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000, 120_000];
export const RATE_LIMIT_STOP = 'Provider rate limit reached';

type Step = { id: string; state: string; attempt_id: string | null };
export type RetryDecision =
  | { action: 'none' }
  | { action: 'wait' }
  | { action: 'retry'; step: string; n: number }
  | { action: 'stop'; reason: string };

export class RateLimitRetries {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_rate_limits(
      task_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      failures INTEGER NOT NULL,
      retry_at INTEGER NOT NULL,
      PRIMARY KEY(task_id, step_id, failures))`);
  }
  /** Whether this attempt failed because the provider rate-limited it. */
  rateLimited(attempt: string): boolean {
    const row = this.store.db.prepare('SELECT state,outcome FROM attempts WHERE id=?').get(attempt);
    if (!row || row.state !== 'failed' || typeof row.outcome !== 'string') return false;
    try {
      return JSON.parse(row.outcome)?.failure?.kind === 'rate_limit';
    } catch {
      return false;
    }
  }
  /** What the driver does with a task whose step failed. Records each rate-limited attempt once. */
  decide(task: { id: string; steps: Step[] }, now = Date.now()): RetryDecision {
    const failed = task.steps.filter((s) =>
      ['failed', 'interrupted', 'cancelled'].includes(s.state),
    );
    const step = failed[0];
    if (failed.length !== 1 || !step || step.state !== 'failed' || !step.attempt_id)
      return { action: 'none' };
    if (!this.rateLimited(step.attempt_id)) return { action: 'none' };
    let row = this.store.db
      .prepare('SELECT failures,retry_at FROM task_rate_limits WHERE attempt_id=?')
      .get(step.attempt_id) as { failures: number; retry_at: number } | undefined;
    if (!row) {
      const prior = Number(
        this.store.db
          .prepare('SELECT count(*) AS n FROM task_rate_limits WHERE task_id=? AND step_id=?')
          .get(task.id, step.id)!.n,
      );
      const failures = prior + 1;
      const retry_at = now + (RATE_LIMIT_BACKOFF_MS[failures - 1] ?? RATE_LIMIT_BACKOFF_MS.at(-1)!);
      this.store.db
        .prepare('INSERT INTO task_rate_limits VALUES (?,?,?,?,?)')
        .run(task.id, step.id, step.attempt_id, failures, retry_at);
      row = { failures, retry_at };
    }
    if (row.failures >= RATE_LIMIT_MAX_FAILURES) return { action: 'stop', reason: RATE_LIMIT_STOP };
    if (now < row.retry_at) return { action: 'wait' };
    return { action: 'retry', step: step.id, n: row.failures };
  }
}
