import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.js';
import type { TaskWork } from './work.js';
import type { TaskDriver } from './driver.js';
import type { TaskVerification } from './verification.js';
import type { ManagedWork } from '../execution/index.js';
import {
  POLICY_DIGEST,
  canonical,
  digest,
  integer,
  ServiceError,
  string,
  type Controller,
} from '../core/index.js';
import type { Job, JobOccurrence } from '../core/index.js';

export interface JobAcceptance {
  occurrence_id: string;
  job_id: string;
  task_id: string;
  session_id: string;
  occurrence_key: string;
  binding_digest: string;
}
/** First job gate: one immutable, operator-bound task and exactly one logical occurrence. */
export class JobWork {
  private timer?: NodeJS.Timeout;
  controlError: string | null = null;
  requiredControl?: () => void;
  assertControl(): void {
    this.assertHealthy();
  }
  reviewBinding(task: string): Record<string, unknown> {
    return this.binding(task);
  }
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly driver: TaskDriver,
    readonly verification: TaskVerification,
    readonly managed: ManagedWork,
  ) {
    store.jobGrantCheck = (session) => {
      const job = this.forSession(session);
      if (!job || !this.occurrenceFor(job.id)) return;
      this.assertHealthy();
      if (job.state === 'cancelled') throw new ServiceError('job_stopped', 'Job was cancelled');
      const reason = this.scopeReason(job);
      if (reason) throw new ServiceError('job_binding_stale', reason);
    };
  }
  private assertHealthy(): void {
    this.requiredControl?.();
    if (this.controlError)
      throw new ServiceError('job_control_unavailable', this.controlError, 503);
  }
  private scopeReason(job: Job): string | null {
    const task = this.tasks.get(job.task_id),
      bound = job.binding.workspace as Record<string, unknown>,
      executor = this.verification.coding.executor;
    if (
      task.plan_revision !== job.binding.plan_revision ||
      canonical(this.driver.supervisor.route) !== canonical(job.binding.provider_route) ||
      POLICY_DIGEST !== job.binding.policy_digest ||
      (this.managed.options.connector?.id ?? null) !== job.binding.effect_connector ||
      executor?.profileDigest !== bound.profile_digest ||
      executor?.engineId !== bound.engine_id ||
      this.verification.workspaces.get(task.session_id).id !== bound.workspace_id
    )
      return 'Plan or execution scope changed after job admission; inspect the original binding';
    return null;
  }
  get(id: string): Job {
    const row = this.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as
      (Omit<Job, 'binding' | 'compact'> & { binding: string; compact: number }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Job not found', 404);
    const binding = JSON.parse(row.binding);
    if (
      digest(binding) !== row.binding_digest ||
      binding.task_id !== row.task_id ||
      binding.session_id !== row.session_id ||
      binding.max_steps !== row.max_steps ||
      binding.compact !== !!row.compact
    )
      throw new ServiceError('job_binding_corrupt', 'Job binding digest mismatch', 500);
    return { ...row, binding, compact: !!row.compact };
  }
  forSession(session: string): Job | null {
    const row = this.store.db.prepare('SELECT id FROM jobs WHERE session_id=?').get(session);
    return row ? this.get(String(row.id)) : null;
  }
  list(offset = 0): { jobs: Job[]; next_offset: number | null } {
    integer(offset, 'offset');
    const rows = this.store.db
      .prepare('SELECT id FROM jobs ORDER BY rowid DESC LIMIT 33 OFFSET ?')
      .all(offset);
    return {
      jobs: rows.slice(0, 32).map((r) => this.get(String(r.id))),
      next_offset: rows.length > 32 ? offset + 32 : null,
    };
  }
  occurrence(id: string): JobOccurrence {
    const row = this.store.db
      .prepare('SELECT * FROM job_occurrences WHERE id=?')
      .get(id) as unknown as JobOccurrence | undefined;
    if (!row) throw new ServiceError('not_found', 'Job occurrence not found', 404);
    return row;
  }
  private occurrenceFor(job: string): JobOccurrence | null {
    const row = this.store.db.prepare('SELECT id FROM job_occurrences WHERE job_id=?').get(job);
    return row ? this.occurrence(String(row.id)) : null;
  }
  view(
    id: string,
  ): Job & { occurrence: JobOccurrence | null; task_state: string; task_reason: string } {
    const job = this.get(id),
      task = this.driver.view(job.task_id);
    return {
      ...job,
      occurrence: this.occurrenceFor(id),
      task_state: task.state,
      task_reason: task.reason,
    };
  }
  private binding(task: string): Record<string, unknown> {
    const value = this.tasks.get(task);
    this.verification.assertIdle(value);
    const runtime = this.driver.budget.state(task);
    if (
      runtime.started_at !== null ||
      runtime.auto_enabled ||
      value.steps.some((s) => s.state !== 'pending')
    )
      throw new ServiceError(
        'job_task_started',
        'A one-shot job requires a task whose steps have not started',
      );
    if (['cancelled', 'succeeded', 'succeeded_with_exception'].includes(value.state))
      throw new ServiceError('task_settled', 'Create a fresh task for this one-shot job');
    return {
      task_id: value.id,
      session_id: value.session_id,
      task_revision: value.revision,
      plan_revision: value.plan_revision,
      plan_digest: digest({
        objective: value.objective,
        constraints: value.constraints,
        steps: value.steps,
        acceptance: value.acceptance,
        deliverables: value.deliverables,
        limits: value.limits,
      }),
      workspace: this.verification.binding(value),
      provider_route: this.driver.supervisor.route,
      policy_digest: POLICY_DIGEST,
      effect_connector: this.managed.options.connector?.id ?? null,
    };
  }
  create(
    taskId: string,
    request: string,
    expected: number,
    name: string,
    steps: number,
    compact: boolean,
    controller: Controller,
  ): Job {
    const result = this.store.request(
      'local-operator',
      request,
      { kind: 'job-create', task_id: taskId, expected, name, max_steps: steps, compact },
      () => {
        return this.createInTransaction(taskId, request, expected, name, steps, compact, () =>
          this.store.authorizeControl(this.tasks.get(taskId).session_id, controller),
        );
      },
    );
    return this.get(result.id);
  }
  createInTransaction(
    taskId: string,
    request: string,
    expected: number,
    name: string,
    steps: number,
    compact: boolean,
    authorize: () => void,
  ): { id: string } {
    if (!this.store.db.isTransaction) throw new Error('Job admission requires a transaction');
    this.assertHealthy();
    const task = this.tasks.get(taskId);
    authorize();
    if (task.revision !== expected)
      throw new ServiceError('task_revision_conflict', 'Task revision changed');
    string(name, 'job name', 256);
    if (!Number.isSafeInteger(steps) || steps < 1 || steps > 32)
      throw new ServiceError('invalid_limit', 'Bound the job to 1–32 new steps', 400);
    if (typeof compact !== 'boolean')
      throw new ServiceError('invalid_field', 'compact must be boolean', 400);
    if (
      task.steps.some((s) => !s.checks?.length) ||
      !task.acceptance.length ||
      !task.deliverables.length
    )
      throw new ServiceError(
        'verification_required',
        'Jobs require checked steps, acceptance checks and deliverable evidence',
      );
    if (this.forSession(task.session_id))
      throw new ServiceError('job_exists', 'This task already belongs to a one-shot job');
    const bound = { ...this.binding(taskId), max_steps: steps, compact };
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO jobs VALUES (?,?,?,?,1,?,?,?,?, 'ready','Waiting for an explicit one-shot trigger',?)",
      )
      .run(
        id,
        taskId,
        task.session_id,
        name,
        canonical(bound),
        digest(bound),
        steps,
        compact ? 1 : 0,
        Date.now(),
      );
    this.store.event(
      task.session_id,
      'job.created',
      { job_id: id, task_id: taskId, binding_digest: digest(bound) },
      request,
    );
    return { id };
  }
  trigger(
    id: string,
    request: string,
    expected: number,
    key: string,
    controller: Controller,
  ): JobAcceptance {
    const accepted = this.store.request(
      'local-operator',
      request,
      { kind: 'job-trigger', id, expected, occurrence_key: key },
      () => {
        return this.triggerInTransaction(id, request, expected, key, () =>
          this.store.authorizeControl(this.get(id).session_id, controller),
        );
      },
    );
    this.driver.kick();
    return accepted;
  }
  triggerInTransaction(
    id: string,
    request: string,
    expected: number,
    key: string,
    authorize: () => void,
  ): JobAcceptance {
    if (!this.store.db.isTransaction) throw new Error('Job trigger requires a transaction');
    const job = this.get(id);
    string(key, 'occurrence key', 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(key))
      throw new ServiceError('invalid_key', 'Use a stable occurrence identifier', 400);
    // Logical deduplication precedes renewed leases/revisions, even with a new transport request ID.
    const prior = this.occurrenceFor(id);
    if (prior) {
      if (prior.occurrence_key !== key)
        throw new ServiceError(
          'job_already_triggered',
          'A one-shot job has one occurrence; inspect or continue its existing task',
        );
      return this.acceptance(job, prior);
    }
    this.assertHealthy();
    authorize();
    if (job.revision !== expected)
      throw new ServiceError('job_revision_conflict', 'Job revision changed');
    if (job.state !== 'ready')
      throw new ServiceError('job_stopped', 'This job cannot admit new work');
    const current = {
      ...this.binding(job.task_id),
      max_steps: job.max_steps,
      compact: job.compact,
    };
    if (digest(current) !== job.binding_digest)
      throw new ServiceError(
        'job_binding_stale',
        'Task, workspace or execution configuration changed; create a freshly reviewed task/job',
      );
    const occurrence: JobOccurrence = {
      id: randomUUID(),
      job_id: id,
      occurrence_key: key,
      binding_digest: job.binding_digest,
      state: 'accepted',
      reason: 'Bounded task progression accepted',
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    // This uses the same transaction as occurrence acceptance. A crash cannot leave an unbound grant.
    this.driver.configureInTransaction(
      job.task_id,
      Number(job.binding.task_revision),
      job.max_steps,
      job.compact,
      () => {},
    );
    this.store.db
      .prepare('INSERT INTO job_occurrences VALUES (?,?,?,?,?,?,?,?)')
      .run(
        occurrence.id,
        id,
        key,
        job.binding_digest,
        occurrence.state,
        occurrence.reason,
        occurrence.created_at,
        occurrence.updated_at,
      );
    this.store.db
      .prepare("UPDATE jobs SET state='accepted',reason=?,revision=revision+1 WHERE id=?")
      .run(occurrence.reason, id);
    this.store.event(job.session_id, 'job.triggered', this.acceptance(job, occurrence), request);
    return this.acceptance(job, occurrence);
  }
  private acceptance(job: Job, occurrence: JobOccurrence): JobAcceptance {
    return {
      occurrence_id: occurrence.id,
      job_id: job.id,
      task_id: job.task_id,
      session_id: job.session_id,
      occurrence_key: occurrence.occurrence_key,
      binding_digest: occurrence.binding_digest,
    };
  }
  async cancel(
    id: string,
    request: string,
    expected: number,
    controller: Controller,
  ): Promise<Job> {
    this.store.request('local-operator', request, { kind: 'job-cancel', id, expected }, () => {
      return this.cancelInTransaction(id, request, expected, () =>
        this.store.authorizeControl(this.get(id).session_id, controller),
      );
    });
    if (this.tasks.get(this.get(id).task_id).state === 'cancelled')
      await this.driver.stopCancelled(this.get(id).task_id);
    return this.get(id);
  }
  cancelInTransaction(
    id: string,
    request: string,
    expected: number,
    authorize: () => void,
  ): { id: string } {
    if (!this.store.db.isTransaction) throw new Error('Job cancellation requires transaction');
    const job = this.get(id);
    authorize();
    if (job.revision !== expected)
      throw new ServiceError('job_revision_conflict', 'Job revision changed');
    if (['succeeded', 'succeeded_with_exception', 'cancelled'].includes(job.state))
      throw new ServiceError('job_settled', 'Job already settled');
    if (this.occurrenceFor(id)) {
      const task = this.tasks.get(job.task_id);
      if (!['succeeded', 'succeeded_with_exception', 'cancelled'].includes(task.state))
        this.driver.cancelInTransaction(task.id, task.revision, () => {});
      else if (task.state !== 'cancelled')
        throw new ServiceError('job_settled', 'Task already settled');
      this.store.db
        .prepare(
          "UPDATE job_occurrences SET state='cancelled',reason='Operator cancelled the job',updated_at=? WHERE job_id=?",
        )
        .run(Date.now(), id);
    }
    this.store.db
      .prepare(
        "UPDATE jobs SET state='cancelled',reason='Operator cancelled the job',revision=revision+1 WHERE id=?",
      )
      .run(id);
    this.store.event(job.session_id, 'job.cancelled', { job_id: id }, request);
    return { id };
  }
  reconcile(): void {
    for (const row of this.store.db
      .prepare('SELECT id FROM jobs WHERE id IN (SELECT job_id FROM job_occurrences)')
      .all()) {
      const job = this.get(String(row.id)),
        occurrence = this.occurrenceFor(job.id)!;
      if (job.state === 'cancelled') continue;
      const task = this.driver.view(job.task_id);
      const mismatch = this.scopeReason(job);
      const state = mismatch ? 'blocked' : task.state;
      const reason = mismatch ?? task.reason;
      if (occurrence.state === state && occurrence.reason === reason) continue;
      this.store.transaction(() => {
        this.store.db
          .prepare('UPDATE job_occurrences SET state=?,reason=?,updated_at=? WHERE id=?')
          .run(state, reason, Date.now(), occurrence.id);
        this.store.db
          .prepare('UPDATE jobs SET state=?,reason=?,revision=revision+1 WHERE id=?')
          .run(state, reason, job.id);
        this.store.event(job.session_id, 'job.state', {
          job_id: job.id,
          occurrence_id: occurrence.id,
          task_id: job.task_id,
          state,
          reason,
        });
      });
    }
  }
  async recover(): Promise<void> {
    for (const row of this.store.db
      .prepare("SELECT task_id FROM jobs WHERE state='cancelled'")
      .all()) {
      const task = this.tasks.get(String(row.task_id));
      if (task.state === 'cancelled') await this.driver.stopCancelled(task.id);
    }
    this.reconcile();
  }
  start(): void {
    this.timer = setInterval(() => {
      try {
        this.reconcile();
      } catch (error) {
        this.controlError = 'Required job control failed: ' + (error as Error).message;
        // A required job projection failure cannot leave its workers granting new work.
        for (const row of this.store.db.prepare('SELECT session_id FROM jobs').all())
          this.driver.supervisor.failControl(String(row.session_id), error as Error);
      }
    }, 200);
    this.timer.unref();
  }
  close(): void {
    clearInterval(this.timer);
  }
}
