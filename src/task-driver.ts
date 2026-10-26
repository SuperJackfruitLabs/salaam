import { requiredChecks } from './task-policy.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { TaskWork, WorkTask } from './task-work.js';
import type { TaskBudget } from './task-budget.js';
import type { TaskVerification } from './task-verification.js';
import type { Supervisor } from './supervisor.js';
import type { ChildWork } from './children.js';
import type { CodingWork } from './coding.js';
import { commandTerminal } from './coding.js';
import { canonical, ServiceError, type Controller } from './protocol.js';

/** Persisted, operator-bounded progression. Unknown attempts/commands never become retries. */
export class TaskDriver {
  private timer?: NodeJS.Timeout;
  awaitingAuthorityRenewal?: (session: string) => boolean;
  private active?: Promise<void>;
  private stopped = true;
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly budget: TaskBudget,
    readonly verification: TaskVerification,
    readonly supervisor: Supervisor,
    readonly children: ChildWork,
    readonly coding: CodingWork,
  ) {
    tasks.assertProgressionBinding = (task, binding) => {
      if (canonical(this.verification.binding(task)) !== binding)
        throw new ServiceError(
          'task_progression_stale',
          'Workspace or execution environment changed since the bounded grant',
        );
    };
  }
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), 200);
    this.timer.unref();
    this.kick();
  }
  kick(): void {
    if (this.stopped || this.active) return;
    this.active = this.tick()
      .catch((error) => {
        // A persistence failure cannot authorize more work. Fence all affected task workers.
        this.children.external?.failAll(error as Error);
        for (const row of this.store.db.prepare('SELECT session_id FROM durable_tasks').all())
          this.supervisor.failControl(String(row.session_id), error as Error);
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  private changed(task: WorkTask, state: WorkTask['state'], reason: string): void {
    if (task.state === state && task.reason === reason) return;
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE durable_tasks SET state=?,reason=?,revision=revision+1 WHERE id=?')
        .run(state, reason, task.id);
      this.store.event(task.session_id, 'work_task.state', { task_id: task.id, state, reason });
    });
  }
  configure(
    id: string,
    request: string,
    expected: number,
    steps: number,
    compact: boolean,
    controller: Controller,
  ): unknown {
    const result = this.store.request(
      'local-operator',
      request,
      { kind: 'task-auto', id, expected, steps, compact },
      () =>
        this.configureInTransaction(id, expected, steps, compact, () => {
          this.store.authorizeControl(this.tasks.get(id).session_id, controller);
        }),
    );
    this.kick();
    return result;
  }
  /** Caller must commit its domain acceptance and this grant in the same request transaction. */
  configureInTransaction(
    id: string,
    expected: number,
    steps: number,
    compact: boolean,
    authorize: () => void,
  ): { task_id: string } {
    if (!this.store.db.isTransaction) throw new Error('Task grant requires a transaction');
    authorize();
    const task = this.tasks.get(id);
    if (task.revision !== expected)
      throw new ServiceError('task_revision_conflict', 'Task revision changed');
    if (!Number.isSafeInteger(steps) || steps < 0 || steps > 32)
      throw new ServiceError('invalid_limit', 'Bound progression to 0–32 new steps', 400);
    if (steps) {
      this.verification.assertIdle(task);
      this.budget.check(task.session_id);
      if (['succeeded', 'succeeded_with_exception', 'cancelled'].includes(task.state))
        throw new ServiceError('task_settled', 'Revise a settled task before enabling progression');
      if (
        task.steps.some(
          (s) =>
            s.state !== 'completed' &&
            (!s.checks?.length || ['interrupted', 'failed', 'cancelled'].includes(s.state)),
        )
      )
        throw new ServiceError(
          'verification_required',
          'Every unfinished automatic step needs checks and an unambiguous state',
        );
    }
    this.store.db
      .prepare(
        'UPDATE task_runtime SET auto_enabled=?,remaining_steps=?,auto_plan_revision=?,auto_compact=?,auto_error=NULL,auto_epoch=auto_epoch+1,started_at=CASE WHEN ? THEN coalesce(started_at,?) ELSE started_at END WHERE task_id=?',
      )
      .run(steps ? 1 : 0, steps, task.plan_revision, compact ? 1 : 0, steps, Date.now(), id);
    if (steps)
      this.store.db
        .prepare('UPDATE task_runtime SET auto_binding=? WHERE task_id=?')
        .run(canonical(this.verification.binding(task)), id);
    this.store.db.prepare('UPDATE durable_tasks SET revision=revision+1 WHERE id=?').run(id);
    this.store.event(task.session_id, 'work_task.progression_configured', {
      task_id: id,
      plan_revision: task.plan_revision,
      max_new_steps: steps,
      compact,
      enabled: steps > 0,
    });
    return { task_id: id };
  }
  private stop(task: WorkTask, reason: string): void {
    if (
      ['cancelled', 'succeeded', 'succeeded_with_exception'].includes(this.tasks.get(task.id).state)
    )
      return;
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE task_runtime SET auto_enabled=0,auto_error=? WHERE task_id=?')
        .run(reason, task.id);
      const state = task.steps.some((s) => s.state === 'completed')
        ? 'partially_completed'
        : 'blocked';
      this.store.db
        .prepare('UPDATE durable_tasks SET state=?,reason=?,revision=revision+1 WHERE id=?')
        .run(state, reason, task.id);
      this.store.event(task.session_id, 'work_task.progression_stopped', {
        task_id: task.id,
        reason,
      });
    });
  }
  private async stopActive(task: WorkTask): Promise<void> {
    const attempts = this.store.db
      .prepare(
        "SELECT id,state,submission_id FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running','delegated')",
      )
      .all(task.session_id) as { id: string; state: string; submission_id: string }[];
    this.store.transaction(() => {
      for (const attempt of attempts) {
        this.store.db
          .prepare("INSERT OR IGNORE INTO cancellations VALUES (?,'task-stop')")
          .run(attempt.id);
        this.store.cancelChildren?.(attempt.id);
        if (attempt.state === 'accepted') {
          this.store.db.prepare("UPDATE attempts SET state='cancelled' WHERE id=?").run(attempt.id);
          this.store.db
            .prepare("UPDATE submissions SET state='cancelled' WHERE id=?")
            .run(attempt.submission_id);
          this.store.projectTaskAttempt?.(this.store.attempt(attempt.id));
        }
        this.store.event(task.session_id, 'attempt.cancel_requested', {
          attempt_id: attempt.id,
          source: 'task-stop',
        });
      }
    });
    for (const attempt of attempts) {
      await this.children.cancelOwned(attempt.id);
      await this.supervisor.cancelAttempt(attempt.id);
    }
    await this.children.external?.cancelRoot(task.session_id);
    await this.verification.station?.station.stopSession(task.session_id);
    const compactions = this.store.db
      .prepare("SELECT id FROM compactions WHERE session_id=? AND state='running'")
      .all(task.session_id) as { id: string }[];
    for (const work of compactions)
      this.supervisor.cancelCompaction(work.id, 'task-stop:compact:' + work.id, () => {});
    for (const run of this.coding.list(task.session_id))
      if (!commandTerminal(run.state))
        this.coding.cancel(
          task.session_id,
          run.id,
          'task-stop:' + task.id + ':' + run.id,
          () => {},
        );
  }
  async cancel(
    id: string,
    request: string,
    expected: number,
    controller: Controller,
  ): Promise<WorkTask> {
    this.store.request('local-operator', request, { kind: 'task-cancel', id, expected }, () => {
      return this.cancelInTransaction(id, expected, () => {
        this.store.authorizeControl(this.tasks.get(id).session_id, controller);
      });
    });
    if (this.tasks.get(id).state === 'cancelled') await this.stopCancelled(id);
    return this.tasks.get(id);
  }
  /** Revocation is durable before any process abort, including a job cancellation. */
  cancelInTransaction(
    id: string,
    expected: number,
    authorize: () => void,
    peer?: { peer: string; tenant: string },
  ): { id: string } {
    if (!this.store.db.isTransaction) throw new Error('Task cancellation requires a transaction');
    authorize();
    const task = this.tasks.get(id);
    if (task.revision !== expected)
      throw new ServiceError('task_revision_conflict', 'Task revision changed');
    if (['succeeded', 'succeeded_with_exception', 'cancelled'].includes(task.state))
      throw new ServiceError('task_settled', 'Task already settled');
    this.store.db.prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?').run(id);
    this.children.cancelSessionInTransaction(task.session_id);
    this.store.db
      .prepare("UPDATE durable_tasks SET state='cancelled',reason=?,revision=revision+1 WHERE id=?")
      .run(
        peer
          ? 'Authenticated peer cancelled its dedicated task; inspect any uncertain effects'
          : 'Operator cancelled the task; inspect any uncertain effects',
        id,
      );
    this.store.event(task.session_id, 'work_task.cancelled', {
      task_id: id,
      ...(peer ? { peer } : {}),
    });
    return { id };
  }
  async stopCancelled(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (task.state !== 'cancelled')
      throw new ServiceError('task_not_cancelled', 'Persist cancellation before aborting work');
    await this.stopActive(task);
  }
  private async worker(task: WorkTask): Promise<boolean> {
    const s = this.supervisor.inspect(task.session_id);
    if (s.state === 'ready') {
      this.supervisor.assertIdle(task.session_id);
      return true;
    }
    if (s.state === 'starting') return false;
    if (s.state === 'unhealthy') {
      this.stop(task, s.error ?? 'Worker readiness failed');
      return false;
    }
    await this.supervisor.start(task.session_id);
    return !this.stopped;
  }
  private compact(task: WorkTask, stepId: string): boolean {
    const epoch = Number(this.budget.state(task.id).auto_epoch);
    let row = this.store.db
      .prepare(
        'SELECT * FROM task_compactions WHERE task_id=? AND step_id=? AND plan_revision=? AND epoch=?',
      )
      .get(task.id, stepId, task.plan_revision, epoch) as
      | {
          request_id: string;
          compaction_id: string | null;
          task_version: number;
          skip_reason: string | null;
        }
      | undefined;
    if (!row) {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            'INSERT INTO task_compactions(task_id,step_id,plan_revision,request_id,compaction_id,task_version,epoch) VALUES (?,?,?,?,NULL,?,?)',
          )
          .run(
            task.id,
            stepId,
            task.plan_revision,
            'task-compact:' + randomUUID(),
            this.supervisor.tasks.state(task.session_id).version,
            epoch,
          );
        this.store.event(task.session_id, 'work_task.compaction_requested', {
          task_id: task.id,
          step_id: stepId,
          plan_revision: task.plan_revision,
        });
      });
      row = this.store.db
        .prepare(
          'SELECT * FROM task_compactions WHERE task_id=? AND step_id=? AND plan_revision=? AND epoch=?',
        )
        .get(task.id, stepId, task.plan_revision, epoch) as typeof row;
    }
    const r = row!;
    if (r.skip_reason) return true;
    if (!r.compaction_id) {
      const work = this.supervisor.compact(task.session_id, r.request_id, r.task_version, () => {
        this.budget.check(task.session_id);
        this.supervisor.assertIdle(task.session_id);
        if (!this.budget.state(task.id).auto_enabled)
          throw new ServiceError('task_authority', 'Progression was paused');
      });
      this.store.transaction(() =>
        this.store.db
          .prepare(
            'UPDATE task_compactions SET compaction_id=? WHERE task_id=? AND step_id=? AND plan_revision=? AND epoch=?',
          )
          .run(work.id, task.id, stepId, task.plan_revision, epoch),
      );
      r.compaction_id = work.id;
    }
    const work = this.supervisor.tasks.compaction(r.compaction_id);
    if (work.state === 'completed') return true;
    if (work.state === 'failed' && work.error?.includes('Nothing to compact (session too small)')) {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            'UPDATE task_compactions SET skip_reason=? WHERE task_id=? AND step_id=? AND plan_revision=? AND epoch=?',
          )
          .run(work.error!, task.id, stepId, task.plan_revision, epoch);
        this.store.event(task.session_id, 'work_task.compaction_skipped', {
          task_id: task.id,
          step_id: stepId,
          compaction_id: work.id,
          reason: work.error,
        });
      });
      return true;
    }
    if (work.state !== 'running')
      this.stop(task, 'Managed compaction ' + work.state + '; inspect before continuing');
    return false;
  }
  private async check(task: WorkTask, key: string, step: string | null): Promise<boolean> {
    const receipt = this.verification.latest(task, key, step);
    if (!receipt) {
      this.verification.start(
        task.id,
        key,
        step,
        'auto-check:' + task.id + ':' + task.plan_revision + ':' + (step ?? 'final') + ':' + key,
        task.revision,
        () => {
          this.budget.check(task.session_id);
          const runtime = this.budget.state(task.id);
          if (!runtime.auto_enabled || runtime.auto_plan_revision !== task.plan_revision)
            throw new ServiceError('task_authority', 'Progression grant changed');
        },
      );
      return false;
    }
    if (receipt.state === 'accepted' || receipt.state === 'running') return false;
    if (!(await this.verification.freshAsync(receipt))) {
      this.stop(task, 'Verification failed or became stale: ' + key);
      return false;
    }
    return true;
  }
  private async progress(task: WorkTask): Promise<void> {
    const r = this.budget.state(task.id);
    if (!r.auto_enabled) return;
    if (r.auto_plan_revision !== task.plan_revision) {
      this.stop(task, 'Plan changed; enable a new bounded progression grant');
      return;
    }
    if (task.steps.some((s) => ['interrupted', 'failed', 'cancelled'].includes(s.state))) {
      this.stop(task, 'An interrupted or failed step requires explicit operator review');
      return;
    }
    const active = this.budget.active(task);
    if (active > 0) {
      const accepted = task.steps.some(
        (s) => s.state === 'queued' && !this.tasks.delegatedStep?.(task.id, s.id),
      );
      if (
        accepted &&
        !['ready', 'starting'].includes(this.supervisor.inspect(task.session_id).state)
      )
        await this.worker(task);
      const rootActive = this.store.db
        .prepare(
          "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
        )
        .get(task.session_id);
      if (
        rootActive ||
        active >= task.limits.concurrency ||
        this.children.activeCount(task.session_id) >= 2 ||
        this.children.activeCount() >= 8
      )
        return;
    }
    const reviewing = task.steps.find((s) => s.state === 'awaiting_review');
    if (reviewing && !active) {
      this.tasks.assertStepReview?.(task.id, reviewing.id);
      if (!reviewing.checks?.length) {
        this.stop(task, 'Step requires operator review');
        return;
      }
      for (const key of reviewing.checks) if (!(await this.check(task, key, reviewing.id))) return;
      await this.verification.verifiedStepAsync(task, reviewing.id);
      return;
    }
    if (task.steps.every((s) => s.state === 'completed')) {
      if (!task.acceptance.length || !task.deliverables.length) {
        this.stop(task, 'Configure acceptance checks and deliverable evidence before completion');
        return;
      }
      // A passed receipt cannot be re-observed while another final check owns
      // the native workspace. Wait for the whole set before testing freshness;
      // finishAsync still performs the final transactional evidence validation.
      if (
        requiredChecks(task).some((check) => {
          const receipt = this.verification.latest(task, check.key, null);
          return receipt?.state === 'accepted' || receipt?.state === 'running';
        })
      )
        return;
      for (const check of requiredChecks(task))
        if (!(await this.check(task, check.key, null))) return;
      await this.verification.finishAsync(
        task.id,
        'auto-finish:' + task.id + ':' + task.plan_revision,
        task.revision,
        null,
        () => {
          if (!this.budget.state(task.id).auto_enabled)
            throw new ServiceError('task_authority', 'Progression paused before completion');
        },
      );
      return;
    }
    if (Number(r.remaining_steps) < 1) {
      if (active) return;
      this.stop(task, 'Bounded progression step limit reached');
      return;
    }
    this.tasks.assertProgressionBinding?.(task, String(r.auto_binding));
    const next = task.steps.find(
      (s) =>
        s.state === 'pending' &&
        (!active || this.tasks.delegatedStep?.(task.id, s.id)) &&
        s.depends_on.every((k) => task.steps.find((p) => p.key === k)?.state === 'completed'),
    );
    if (!next) {
      if (active) return;
      this.stop(task, 'No eligible step; inspect the plan');
      return;
    }
    const assigned = this.tasks.delegatedStep?.(task.id, next.id);
    if ((!assigned && !(await this.worker(task))) || this.stopped) return;
    if (
      !assigned &&
      r.auto_compact &&
      task.steps.some((s) => s.state === 'completed') &&
      !this.compact(task, next.id)
    )
      return;
    let grant = this.store.db
      .prepare(
        'SELECT id FROM task_grants WHERE task_id=? AND step_id=? AND plan_revision=? AND epoch=?',
      )
      .get(task.id, next.id, task.plan_revision, Number(r.auto_epoch)) as
      { id: string } | undefined;
    if (!grant) {
      const id = randomUUID();
      this.store.transaction(() => {
        this.store.db
          .prepare("INSERT INTO task_grants VALUES (?,?,?,?,?,'prepared',?,?)")
          .run(
            id,
            task.id,
            next.id,
            task.plan_revision,
            task.revision,
            String(r.auto_binding),
            Number(r.auto_epoch),
          );
        this.store.event(task.session_id, 'work_task.step_granted', {
          task_id: task.id,
          step_id: next.id,
          grant_id: id,
          plan_revision: task.plan_revision,
        });
      });
      grant = { id };
    }
    this.tasks.advance(grant.id);
  }
  private async tick(): Promise<void> {
    await this.verification.reconcileAsync();
    for (const row of this.store.db
      .prepare('SELECT id FROM durable_tasks ORDER BY rowid')
      .all() as { id: string }[]) {
      if (this.stopped) return;
      let task = this.tasks.get(row.id);
      const r = this.budget.state(task.id);
      if (['succeeded', 'succeeded_with_exception', 'cancelled'].includes(task.state)) continue;
      if (this.awaitingAuthorityRenewal?.(task.session_id)) continue;
      if (r.started_at !== null && Date.now() - Number(r.started_at) >= task.limits.runtime_ms) {
        this.budget.block(task.session_id, 'Task runtime limit reached');
        await this.stopActive(task);
        continue;
      }
      if (task.steps.some((s) => ['queued', 'running'].includes(s.state)) && !r.blocked_reason) {
        let state: WorkTask['state'] = 'running',
          reason = 'Explicit step attempt in progress';
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM approvals WHERE state='pending' AND (session_id=? OR session_id IN (SELECT child_session FROM child_tasks WHERE parent_session=?))",
            )
            .get(task.session_id, task.session_id)
        ) {
          state = 'waiting_for_person';
          reason = 'An operation-bound human approval is pending';
        } else if (
          this.store.db
            .prepare("SELECT 1 FROM child_tasks WHERE parent_session=? AND state='accepted'")
            .get(task.session_id)
        ) {
          state = 'waiting_for_child';
          reason = 'A child worker is pending';
        } else if (this.supervisor.inspect(task.session_id).state !== 'ready') {
          state = 'waiting_for_infrastructure';
          reason = 'Waiting for worker readiness';
        }
        this.changed(task, state, reason);
        task = this.tasks.get(task.id);
      }
      try {
        if (r.auto_enabled) {
          this.budget.check(task.session_id);
          await this.progress(task);
        }
      } catch (error) {
        if (
          error instanceof ServiceError &&
          ['worker_busy', 'workspace_busy', 'task_busy'].includes(error.code)
        )
          continue;
        this.store.taskBudgetDenied?.(task.session_id, error);
        this.stop(this.tasks.get(task.id), (error as Error).message);
      }
    }
  }
  async viewAsync(
    id: string,
  ): Promise<WorkTask & { runtime: Record<string, any>; verification: any }> {
    const result = this.view(id);
    if (!this.verification.station) return result;
    result.verification = await this.verification.viewAsync(this.tasks.get(id));
    const current = this.tasks.get(id);
    if (
      result.verification.completion?.fresh &&
      ['succeeded', 'succeeded_with_exception'].includes(current.state)
    ) {
      result.state = current.state;
      result.reason = current.reason;
    }
    return result;
  }
  view(id: string): WorkTask & { runtime: Record<string, any>; verification: any } {
    const task = this.tasks.get(id),
      runtime = this.budget.state(id),
      verification = this.verification.view(task) as any;
    let state = task.state,
      reason = task.reason;
    if (task.state !== 'cancelled' && verification.completion && !verification.completion.fresh) {
      state = 'blocked';
      reason = 'Completion evidence is stale at the current workspace revision';
    }
    if (
      runtime.blocked_reason &&
      !['cancelled', 'succeeded', 'succeeded_with_exception'].includes(task.state)
    ) {
      state = 'blocked';
      reason = runtime.blocked_reason;
    }
    if (
      task.steps.some((s) => ['queued', 'running'].includes(s.state)) &&
      !['blocked', 'cancelled'].includes(state)
    ) {
      if (
        this.store.db
          .prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending'")
          .get(task.session_id)
      ) {
        state = 'waiting_for_person';
        reason = 'An operation-bound human approval is pending';
      } else if (
        this.store.db
          .prepare("SELECT 1 FROM child_tasks WHERE parent_session=? AND state='accepted'")
          .get(task.session_id)
      ) {
        state = 'waiting_for_child';
        reason = 'Read-only child work is pending';
      } else if (this.supervisor.inspect(task.session_id).state !== 'ready') {
        state = 'waiting_for_infrastructure';
        reason = 'Waiting for worker readiness';
      }
    }
    return { ...task, state, reason, runtime, verification };
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
  }
}
