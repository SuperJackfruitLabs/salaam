import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Artifacts } from './artifacts.js';
import type { Supervisor } from './supervisor.js';
import { digest, ServiceError, type Attempt, type ChildTask } from './protocol.js';

export class ChildWork {
  private paused = false;
  private starts = new Set<Promise<void>>();
  constructor(
    readonly store: Store,
    private artifacts: Artifacts,
    private supervisor: Supervisor,
  ) {
    store.finishChild = (attempt) => this.finish(attempt);
    store.cancelChildren = (attempt) => this.cancelIntents(attempt);
  }
  owned(session: string): ChildTask | undefined {
    return this.store.db
      .prepare('SELECT * FROM child_tasks WHERE child_session=?')
      .get(session) as unknown as ChildTask | undefined;
  }
  list(parent: string): ChildTask[] {
    return (
      this.store.db
        .prepare('SELECT * FROM child_tasks WHERE parent_session=? ORDER BY rowid')
        .all(parent) as unknown as ChildTask[]
    ).map((child) => ({ ...child, worker: this.store.workerBoundary.view(child.id) }));
  }
  inspect(parent: string, id: string): ChildTask {
    const row = this.store.db
      .prepare('SELECT * FROM child_tasks WHERE id=? AND parent_session=?')
      .get(id, parent) as unknown as ChildTask | undefined;
    if (!row) throw new ServiceError('not_found', 'Child task not found', 404);
    return { ...row, worker: this.store.workerBoundary.view(row.id) };
  }
  spawn(
    parent: string,
    epoch: number,
    attempt: string,
    step: string,
    prompt: string,
    budget: number,
    requested: string[],
  ): ChildTask {
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8)
      throw new ServiceError('invalid_budget', 'Child request budget must be 1–8');
    if (
      step.length > 128 ||
      !step.length ||
      prompt.length > 32768 ||
      !prompt.trim() ||
      prompt.trimStart().startsWith('/')
    )
      throw new ServiceError('invalid_child', 'Invalid child step or prompt');
    // Current child authority is deliberately read-only and closed-world.
    const authority = requested
      .filter((x) => x === 'salaam_probe')
      .filter((x, i, a) => a.indexOf(x) === i)
      .sort();
    const input = digest({ prompt, budget, requested: [...new Set(requested)].sort() });
    let fresh = false;
    const child = this.store.transaction(() => {
      const old = this.store.db
        .prepare('SELECT * FROM child_tasks WHERE parent_session=? AND step_key=?')
        .get(parent, step) as unknown as ChildTask | undefined;
      if (old) {
        if (old.input_digest !== input)
          throw new ServiceError('spawn_conflict', 'Step key already binds a different child');
        return old;
      }
      if (this.paused) throw new ServiceError('stopping', 'Child dispatch is stopping');
      this.supervisor.assertActive(parent, epoch, attempt);
      this.supervisor.assertSessionProviderSupported(parent);
      if (this.owned(parent))
        throw new ServiceError('depth_exceeded', 'Child depth is limited to one');
      if (!authority.length)
        throw new ServiceError('authority_denied', 'No requested read-only authority is available');
      if (this.list(parent).filter((x) => x.state === 'accepted').length >= 2)
        throw new ServiceError('child_limit', 'At most two children may be active');
      this.store.usage.budget(attempt);
      const changed = this.store.db
        .prepare(
          'UPDATE attempt_budgets SET reserved_requests=reserved_requests+? WHERE attempt_id=? AND spent_requests+reserved_requests+?<=limit_requests',
        )
        .run(budget, attempt, budget);
      if (!changed.changes)
        throw new ServiceError('budget_exhausted', 'Parent cannot reserve this child budget');
      const id = randomUUID(),
        session = randomUUID(),
        submission = randomUUID(),
        childAttempt = randomUUID();
      this.store.db
        .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
        .run(session, this.store.session(parent).cwd, session);
      this.store.db
        .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
        .run(submission, session, prompt, childAttempt);
      this.store.db
        .prepare(
          "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,?,'accepted')",
        )
        .run(childAttempt, session, submission);
      this.store.db
        .prepare(
          "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES (?,?,?,?,?,?,?,?,?,'accepted')",
        )
        .run(
          id,
          parent,
          attempt,
          step,
          input,
          session,
          childAttempt,
          JSON.stringify(authority),
          budget,
        );
      this.store.taskChildReserve?.(parent, childAttempt, budget);
      this.store.usage.budget(childAttempt, budget);
      const artifact = this.artifacts.prepare(session, prompt);
      artifact.commit();
      this.store.workerBoundary.freeze(this.owned(session)!, artifact.id);
      this.store.event(session, 'session.created', { parent_session: parent, child_id: id });
      this.store.event(session, 'submission.accepted', {
        attempt_id: childAttempt,
        submission_id: submission,
      });
      this.store.event(parent, 'child.spawned', {
        child_id: id,
        child_session: session,
        step_key: step,
        budget,
        authority,
      });
      fresh = true;
      return this.inspect(parent, id);
    });
    // Repeated calls only return the durable binding. They never restart a child.
    if (
      fresh &&
      this.store.session(child.child_session).epoch === 0 &&
      this.store.attempt(child.child_attempt).state === 'accepted'
    )
      this.start(child);
    return child;
  }
  private start(child: ChildTask): void {
    const task = this.supervisor
      .start(child.child_session)
      .catch((error) => {
        this.store.transaction(() => {
          const attempt = this.store.attempt(child.child_attempt);
          if (attempt.state !== 'accepted') return;
          this.store.db
            .prepare("UPDATE attempts SET state='interrupted',error=? WHERE id=?")
            .run(String(error), attempt.id);
          this.store.db
            .prepare("UPDATE submissions SET state='interrupted' WHERE id=?")
            .run(attempt.submission_id);
          this.finish(this.store.attempt(attempt.id));
        });
      })
      .catch((error) => this.supervisor.failControl(child.parent_session, error as Error))
      .finally(() => this.starts.delete(task));
    this.starts.add(task);
  }
  workerLost(session: string, reason: string): void {
    const child = this.owned(session);
    if (!child || child.state !== 'accepted') return;
    this.store.transaction(() => {
      const attempt = this.store.attempt(child.child_attempt);
      if (attempt.state !== 'accepted') {
        this.finish(attempt);
        return;
      }
      const state = this.store.cancelled(attempt.id) ? 'cancelled' : 'interrupted';
      this.store.db
        .prepare('UPDATE attempts SET state=?,error=? WHERE id=?')
        .run(state, reason, attempt.id);
      this.store.db
        .prepare('UPDATE submissions SET state=? WHERE id=?')
        .run(state, attempt.submission_id);
      this.finish(this.store.attempt(attempt.id));
    });
  }
  private finish(attempt: Attempt): void {
    const child = this.owned(attempt.session_id);
    if (
      !child ||
      child.state !== 'accepted' ||
      ['accepted', 'running', 'dispatching'].includes(attempt.state)
    )
      return;
    const artifact = this.artifacts.prepare(
      attempt.session_id,
      JSON.stringify({
        schema_version: 1,
        child_id: child.id,
        attempt_id: attempt.id,
        state: attempt.state,
        text: attempt.result,
        error: attempt.error,
      }),
    );
    artifact.commit();
    const result = randomUUID();
    this.store.db
      .prepare('UPDATE child_tasks SET state=?,result_id=?,artifact_id=? WHERE id=?')
      .run(attempt.state, result, artifact.id, child.id);
    this.store.workerBoundary.finish(child, attempt.state === 'interrupted');
    this.store.event(child.parent_session, 'child.result_available', {
      child_id: child.id,
      result_id: result,
      artifact_id: artifact.id,
      state: attempt.state,
    });
  }
  consume(parent: string, childId: string, resultId: string): unknown {
    const child = this.inspect(parent, childId);
    if (!child.result_id || child.result_id !== resultId || !child.artifact_id)
      throw new ServiceError('result_unavailable', 'No matching durable child result');
    return {
      result_id: resultId,
      artifact_id: child.artifact_id,
      result: JSON.parse(this.artifacts.read(child.artifact_id)),
      acknowledged: !!child.acknowledged,
    };
  }
  acknowledge(parent: string, id: string, result: string, request: string): unknown {
    return this.store.request(`inbox:${parent}`, request, { id, result }, () => {
      const child = this.inspect(parent, id);
      if (!child.result_id || child.result_id !== result)
        throw new ServiceError('result_unavailable', 'Result ID changed');
      if (!child.acknowledged) {
        this.store.db.prepare('UPDATE child_tasks SET acknowledged=1 WHERE id=?').run(id);
        this.store.event(parent, 'child.result_acknowledged', { child_id: id, result_id: result });
      }
      return { result_id: result, acknowledged: true };
    });
  }
  recover(): void {
    this.store.transaction(() => {
      for (const row of this.store.db
        .prepare("SELECT * FROM child_tasks WHERE state='accepted'")
        .all() as unknown as ChildTask[]) {
        const attempt = this.store.attempt(row.child_attempt);
        if (attempt.state === 'accepted') {
          this.store.db
            .prepare(
              "UPDATE attempts SET state='interrupted',error='Service restart interrupted undispatched child' WHERE id=?",
            )
            .run(attempt.id);
          this.store.db
            .prepare("UPDATE submissions SET state='interrupted' WHERE id=?")
            .run(attempt.submission_id);
        }
        this.finish(this.store.attempt(attempt.id));
      }
    });
  }
  private cancelIntents(attempt: string): void {
    for (const child of this.store.db
      .prepare("SELECT * FROM child_tasks WHERE parent_session=? AND state='accepted'")
      .all(this.store.attempt(attempt).session_id) as unknown as ChildTask[]) {
      this.store.db
        .prepare("INSERT OR IGNORE INTO cancellations VALUES (?,'parent-cancellation')")
        .run(child.child_attempt);
      const work = this.store.attempt(child.child_attempt);
      if (work.state === 'accepted') {
        this.store.db.prepare("UPDATE attempts SET state='cancelled' WHERE id=?").run(work.id);
        this.store.db
          .prepare("UPDATE submissions SET state='cancelled' WHERE id=?")
          .run(work.submission_id);
        this.finish(this.store.attempt(work.id));
      }
      this.store.event(child.child_session, 'attempt.cancel_requested', {
        attempt_id: work.id,
        parent_attempt: attempt,
      });
    }
  }
  async cancelOwned(attempt: string): Promise<void> {
    const children = this.store.db
      .prepare('SELECT * FROM child_tasks WHERE parent_session=?')
      .all(this.store.attempt(attempt).session_id) as unknown as ChildTask[];
    await Promise.all(
      children
        .filter((child) => this.store.cancelled(child.child_attempt))
        .map((child) => this.supervisor.cancelAttempt(child.child_attempt)),
    );
  }
  pause(): void {
    this.paused = true;
  }
  async close(): Promise<void> {
    await Promise.all(this.starts);
  }
}
