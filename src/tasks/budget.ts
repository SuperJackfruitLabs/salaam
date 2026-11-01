import type { Store } from '../store/store.js';
import type { TaskWork } from './work.js';
import type { WorkTask } from '../core/records.js';
import { ServiceError } from '../core/protocol.js';

export class TaskBudgetError extends ServiceError {
  constructor(
    readonly session_id: string,
    message: string,
  ) {
    super('task_budget_exhausted', message);
  }
}

/** Tools a critic review child may hold and still be left out of the verification busy check. */
export const READ_ONLY_REVIEW_TOOLS = [
  'salaam_findings',
  'salaam_probe',
  'salaam_repository',
] as const;

export class TaskBudget {
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
  ) {
    tasks.assertLimits = (session) => this.check(session);
    store.taskGrantCheck = (session) => this.check(session);
    store.taskModelAdmission = (session, attempt, input, output) =>
      this.admit(session, attempt, input, output);
    store.taskBudgetDenied = (session, error) => {
      if (error instanceof ServiceError && error.code === 'task_budget_exhausted')
        this.block(session, error.message);
    };
    store.taskChildReserve = (session, attempt, count) =>
      this.reserveChild(session, attempt, count);
    store.taskChildFinished = (attempt) => this.releaseChild(attempt);
    store.taskCommandAdmission = (session) => this.command(session);
    store.taskRemainingRuntime = (session) => this.remaining(session);
    // Only the task's own session: a child's attempt keeps the budget its reservation set.
    store.taskAttemptRequestLimit = (session) => this.tasks.forSession(session)?.limits.requests;
  }
  task(session: string): WorkTask | null {
    const direct = this.tasks.forSession(session);
    if (direct) return direct;
    const child = this.store.db
      .prepare('SELECT parent_session FROM child_tasks WHERE child_session=?')
      .get(session) as { parent_session: string } | undefined;
    return child ? this.tasks.forSession(child.parent_session) : null;
  }
  state(id: string): Record<string, any> {
    const runtime = this.store.db.prepare('SELECT * FROM task_runtime WHERE task_id=?').get(id)!;
    const n = Number(
      this.store.db.prepare('SELECT count(*) AS n FROM task_invocations WHERE task_id=?').get(id)!
        .n,
    );
    return { ...runtime, invocations_spent: n, external_model_usage: n ? 'unknown' : 'none' };
  }
  /** The child attempt of each running critic review of this task revision whose recorded
   * tools are all read-only (operator ruling 2026-10-30, option A). Only verification reads may
   * leave these out of the busy count: the reviewer reads a digest-bound snapshot and cannot
   * write the workspace, run a command or reach the station (staging card_019a647a169744ff). */
  private readOnlyReviews(task: WorkTask): string[] {
    if (
      !this.store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_critics'")
        .get()
    )
      return [];
    const rows = this.store.db
      .prepare(
        "SELECT c.child_attempt, c.authority FROM task_critics r JOIN child_tasks c ON c.id=r.child_id WHERE r.task_id=? AND r.plan_revision=? AND r.state='running' AND c.parent_session=?",
      )
      .all(task.id, task.plan_revision, task.session_id) as {
      child_attempt: string;
      authority: string;
    }[];
    return rows
      .filter((r) => {
        try {
          const tools = JSON.parse(r.authority) as unknown;
          return (
            Array.isArray(tools) &&
            tools.every((t) => (READ_ONLY_REVIEW_TOOLS as readonly unknown[]).includes(t))
          );
        } catch {
          return false;
        }
      })
      .map((r) => r.child_attempt);
  }
  /** Live work in the task's session tree. `verification` leaves out a running read-only review's
   * child attempt, for verification reads only; admission and concurrency count everything. */
  active(task: WorkTask, opts: { verification?: boolean } = {}): number {
    const excluded = JSON.stringify(opts.verification ? this.readOnlyReviews(task) : []);
    const row = this.store.db
      .prepare(
        `WITH tree(id) AS (SELECT ? UNION ALL SELECT child_session FROM child_tasks WHERE parent_session=?) SELECT
      (SELECT count(*) FROM attempts WHERE session_id IN (SELECT id FROM tree) AND state IN ('accepted','dispatching','running') AND id NOT IN (SELECT value FROM json_each(?))) +
      (SELECT count(*) FROM station_calls WHERE session_id IN (SELECT id FROM tree) AND kind='check' AND attempt_id IS NULL AND state IN ('prepared','dispatching')) +
      (SELECT count(*) FROM command_runs WHERE session_id IN (SELECT id FROM tree) AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')) +
      (SELECT count(*) FROM external_runs e JOIN child_tasks c ON c.id=e.child_id JOIN attempts a ON a.id=c.child_attempt WHERE c.parent_session=? AND e.stopped=0 AND a.state NOT IN ('accepted','dispatching','running')) AS n`,
      )
      .get(task.session_id, task.session_id, excluded, task.session_id)!;
    return Number(row.n);
  }
  private deny(session: string, message: string): never {
    throw new TaskBudgetError(session, message);
  }
  check(session: string): void {
    this.store.execution.assert(session);
    const task = this.task(session);
    if (!task) return;
    this.store.jobGrantCheck?.(task.session_id);
    const r = this.state(task.id);
    if (r.blocked_reason) this.deny(task.session_id, String(r.blocked_reason));
    if (r.started_at !== null && Date.now() - Number(r.started_at) >= task.limits.runtime_ms)
      this.deny(task.session_id, 'Task runtime limit reached');
    if (this.active(task) > task.limits.concurrency)
      this.deny(task.session_id, 'Task concurrency limit reached');
  }
  remaining(session: string): number {
    const task = this.task(session);
    if (!task) return 30000;
    const r = this.state(task.id);
    return Math.max(
      0,
      task.limits.runtime_ms - (r.started_at === null ? 0 : Date.now() - Number(r.started_at)),
    );
  }
  private admit(session: string, attempt: string | undefined, input: number, output: number): void {
    const task = this.task(session);
    if (!task) return;
    this.check(session);
    if (!attempt) this.deny(task.session_id, 'Task model work must belong to a durable attempt');
    const l = task.limits,
      r = this.state(task.id),
      charge = l.token_units === null ? 0 : l.input_token_bound + l.output_token_bound!;
    if (
      input > l.input_token_bound ||
      (l.output_token_bound !== null && output > l.output_token_bound)
    )
      this.deny(task.session_id, 'Provider payload exceeds declared per-request token bounds');
    const reservation = this.store.db
      .prepare('SELECT * FROM task_reservations WHERE attempt_id=? AND task_id=?')
      .get(attempt!, task.id) as
      { remaining_requests: number; remaining_tokens: number } | undefined;
    if (reservation) {
      if (reservation.remaining_requests < 1 || reservation.remaining_tokens < charge)
        this.deny(task.session_id, 'Child task reservation exhausted');
      this.store.db
        .prepare(
          'UPDATE task_reservations SET remaining_requests=remaining_requests-1,remaining_tokens=remaining_tokens-? WHERE attempt_id=?',
        )
        .run(charge, attempt!);
      this.store.db
        .prepare(
          'UPDATE task_runtime SET requests_spent=requests_spent+1,reserved_requests=reserved_requests-1,token_units=token_units+?,reserved_tokens=reserved_tokens-? WHERE task_id=?',
        )
        .run(charge, charge, task.id);
    } else {
      if (Number(r.requests_spent) + Number(r.reserved_requests) >= l.requests)
        this.deny(task.session_id, 'Task request limit reached');
      if (
        l.token_units !== null &&
        Number(r.token_units) + Number(r.reserved_tokens) + charge > l.token_units
      )
        this.deny(task.session_id, 'Task declared token budget reached');
      this.store.db
        .prepare(
          'UPDATE task_runtime SET requests_spent=requests_spent+1,token_units=token_units+? WHERE task_id=?',
        )
        .run(charge, task.id);
    }
  }
  private reserveChild(session: string, attempt: string, count: number): void {
    const task = this.task(session);
    if (!task) return;
    this.check(session);
    const r = this.state(task.id),
      tokens =
        task.limits.token_units === null
          ? 0
          : count * (task.limits.input_token_bound + task.limits.output_token_bound!);
    if (
      Number(r.requests_spent) + Number(r.reserved_requests) + count > task.limits.requests ||
      (task.limits.token_units !== null &&
        Number(r.token_units) + Number(r.reserved_tokens) + tokens > task.limits.token_units)
    )
      this.deny(task.session_id, 'Task cannot reserve the child request/token bounds');
    this.store.db
      .prepare('INSERT INTO task_reservations VALUES (?,?,?,?)')
      .run(attempt, task.id, count, tokens);
    this.store.db
      .prepare(
        'UPDATE task_runtime SET reserved_requests=reserved_requests+?,reserved_tokens=reserved_tokens+? WHERE task_id=?',
      )
      .run(count, tokens, task.id);
  }
  private releaseChild(attempt: string): void {
    if (this.store.attempt(attempt).state !== 'completed') return; // Uncertain outcomes retain their reservation.
    const r = this.store.db
      .prepare('SELECT * FROM task_reservations WHERE attempt_id=?')
      .get(attempt) as
      { task_id: string; remaining_requests: number; remaining_tokens: number } | undefined;
    if (!r) return;
    this.store.db
      .prepare(
        'UPDATE task_runtime SET reserved_requests=reserved_requests-?,reserved_tokens=reserved_tokens-? WHERE task_id=?',
      )
      .run(r.remaining_requests, r.remaining_tokens, r.task_id);
    this.store.db
      .prepare(
        'UPDATE task_reservations SET remaining_requests=0,remaining_tokens=0 WHERE attempt_id=?',
      )
      .run(attempt);
  }
  command(session: string): void {
    const task = this.task(session);
    if (!task) return;
    this.check(session);
    if (this.active(task) >= task.limits.concurrency)
      this.deny(task.session_id, 'Task command concurrency limit reached');
    this.store.db
      .prepare('UPDATE task_runtime SET started_at=coalesce(started_at,?) WHERE task_id=?')
      .run(Date.now(), task.id);
  }
  verification(task: WorkTask): void {
    this.check(task.session_id);
    const r = this.state(task.id);
    if (Number(r.verification_runs) >= task.limits.verification_runs)
      this.deny(task.session_id, 'Task verification run limit reached');
    this.store.db
      .prepare(
        'UPDATE task_runtime SET verification_runs=verification_runs+1,started_at=coalesce(started_at,?) WHERE task_id=?',
      )
      .run(Date.now(), task.id);
  }
  block(session: string, reason: string): void {
    const task = this.task(session);
    if (
      !task ||
      ['cancelled', 'succeeded', 'succeeded_with_exception'].includes(task.state) ||
      this.state(task.id).blocked_reason === reason
    )
      return;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'UPDATE task_runtime SET blocked_reason=?,auto_enabled=0,auto_error=? WHERE task_id=?',
        )
        .run(reason, reason, task.id);
      this.store.db
        .prepare("UPDATE durable_tasks SET state='blocked',reason=?,revision=revision+1 WHERE id=?")
        .run(reason, task.id);
      this.store.event(task.session_id, 'work_task.budget_blocked', { task_id: task.id, reason });
    });
  }
}
