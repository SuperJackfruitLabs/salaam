import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readTree } from './workspaces.js';
import type { WorkspaceTree, RecurringOccurrence } from './records.js';
import {
  canonical,
  digest,
  integer,
  object,
  ServiceError,
  string,
  type Controller,
} from './protocol.js';
import { POLICY_DIGEST } from './config.js';
import { adjacent, dueSlots, schedule, type Schedule } from './schedules.js';
import type { JobWork } from './job-work.js';

export interface RecurringJob {
  id: string;
  session_id: string;
  name: string;
  revision: number;
  template: Record<string, unknown>;
  template_digest: string;
  state: string;
  next_due: number | null;
  created_at: number;
}
/** A reservation is durable before filesystem provisioning. Only its final transaction grants work. */
export class RecurringWork {
  private timer?: NodeJS.Timeout;
  controlError: string | null = null;
  constructor(
    readonly jobs: JobWork,
    readonly now = () => Date.now(),
  ) {
    jobs.requiredControl = () => {
      if (this.controlError)
        throw new ServiceError('schedule_control_unavailable', this.controlError, 503);
    };
  }
  get store() {
    return this.jobs.store;
  }
  get(id: string): RecurringJob {
    const row = this.store.db
      .prepare('SELECT * FROM recurring_jobs WHERE id=?')
      .get(id) as unknown as (Omit<RecurringJob, 'template'> & { template: string }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Recurring job not found', 404);
    const template = JSON.parse(row.template);
    if (digest(template) !== row.template_digest)
      throw new ServiceError('template_corrupt', 'Recurring template digest mismatch', 500);
    return { ...row, template };
  }
  list(offset = 0) {
    integer(offset, 'offset');
    const rows = this.store.db
      .prepare('SELECT id FROM recurring_jobs ORDER BY rowid DESC LIMIT 33 OFFSET ?')
      .all(offset);
    return {
      jobs: rows.slice(0, 32).map((r) => this.view(String(r.id))),
      next_offset: rows.length > 32 ? offset + 32 : null,
    };
  }
  occurrences(
    id: string,
    offset = 0,
  ): { occurrences: RecurringOccurrence[]; next_offset: number | null } {
    this.get(id);
    integer(offset, 'offset');
    const rows = this.store.db
      .prepare(
        'SELECT * FROM recurring_occurrences WHERE job_id=? ORDER BY rowid DESC LIMIT 33 OFFSET ?',
      )
      .all(id, offset) as unknown as RecurringOccurrence[];
    return { occurrences: rows.slice(0, 32), next_offset: rows.length > 32 ? offset + 32 : null };
  }
  definition(id: string): Schedule | null {
    const row = this.store.db
      .prepare(
        'SELECT definition FROM schedule_revisions WHERE job_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(id);
    return row ? JSON.parse(String(row.definition)) : null;
  }
  view(id: string) {
    return { ...this.get(id), schedule: this.definition(id), ...this.occurrences(id) };
  }
  private scope() {
    return {
      provider: this.jobs.driver.supervisor.route,
      policy: POLICY_DIGEST,
      profile: this.jobs.verification.coding.executor?.profileDigest,
      engine: this.jobs.verification.coding.executor?.engineId,
      connector: this.jobs.managed.options.connector?.id ?? null,
    };
  }
  create(
    taskId: string,
    request: string,
    expected: number,
    name: string,
    maxSteps: number,
    compact: boolean,
    input: unknown,
    actor: Controller,
  ): RecurringJob {
    const inputKey = {
      kind: 'recurring-create',
      taskId,
      expected,
      name,
      maxSteps,
      compact,
      schedule: input,
    };
    const accepted = this.store.request('local-operator', request, inputKey, () => {
      this.jobs.assertControl();
      const task = this.jobs.tasks.get(taskId);
      this.store.authorizeControl(task.session_id, actor);
      if (task.revision !== expected)
        throw new ServiceError('task_revision_conflict', 'Task revision changed');
      string(name, 'name', 256);
      if (
        !Number.isSafeInteger(maxSteps) ||
        maxSteps < 1 ||
        maxSteps > 32 ||
        typeof compact !== 'boolean'
      )
        throw new ServiceError('invalid_limit', 'Bound template progression to 1–32 steps', 400);
      if (
        !task.acceptance.length ||
        !task.deliverables.length ||
        task.steps.some((s) => !s.checks?.length)
      )
        throw new ServiceError(
          'verification_required',
          'Recurring jobs require checked steps and deliverables',
        );
      this.jobs.reviewBinding(taskId);
      const w = this.jobs.verification.workspaces.verify(task.session_id),
        tree = readTree(w.root);
      if (digest(tree) !== w.digest)
        throw new ServiceError('workspace_changed', 'Workspace changed during template capture');
      const artifact = this.jobs.verification.artifacts.prepare(task.session_id, canonical(tree));
      const plan = {
        objective: task.objective,
        constraints: task.constraints,
        steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
          key,
          title,
          instruction,
          depends_on,
          checks,
        })),
        acceptance: task.acceptance,
        ...(task.completion_gate ? { completion_gate: task.completion_gate } : {}),
        deliverables: task.deliverables,
        limits: task.limits,
      };
      const template = {
        plan,
        snapshot_artifact: artifact.id,
        workspace_digest: w.digest,
        scope: this.scope(),
        max_steps: maxSteps,
        compact,
      };
      const def = input === null ? null : schedule(input),
        id = randomUUID(),
        now = this.now();
      artifact.commit();
      this.store.db
        .prepare("INSERT INTO recurring_jobs VALUES (?,?,?,1,?,?,'active',?,?)")
        .run(
          id,
          task.session_id,
          name,
          canonical(template),
          digest(template),
          def ? adjacent(def, now) : null,
          now,
        );
      this.store.db
        .prepare('INSERT INTO schedule_revisions VALUES (?,1,?,?)')
        .run(id, canonical(def), now);
      this.store.event(
        task.session_id,
        'schedule.created',
        { job_id: id, template_digest: digest(template), schedule: def },
        request,
      );
      return { id };
    });
    return this.get(accepted.id);
  }
  update(
    id: string,
    request: string,
    expected: number,
    input: unknown,
    state: unknown,
    actor: Controller,
  ): RecurringJob {
    const result = this.store.request(
      'local-operator',
      request,
      { kind: 'schedule-update', id, expected, input, state },
      () => {
        const job = this.get(id);
        this.store.authorizeControl(job.session_id, actor);
        if (job.revision !== expected)
          throw new ServiceError('schedule_revision_conflict', 'Schedule revision changed');
        if (job.state === 'cancelled')
          throw new ServiceError('schedule_stopped', 'Cancelled templates cannot be re-enabled');
        if (!['active', 'paused', 'cancelled'].includes(String(state)))
          throw new ServiceError('invalid_field', 'Use active, paused or cancelled', 400);
        const def = input === null ? null : schedule(input),
          now = this.now();
        this.store.db
          .prepare('INSERT INTO schedule_revisions VALUES (?,?,?,?)')
          .run(id, expected + 1, canonical(def), now);
        this.store.db
          .prepare('UPDATE recurring_jobs SET revision=revision+1,state=?,next_due=? WHERE id=?')
          .run(String(state), state === 'active' && def ? adjacent(def, now) : null, id);
        if (state === 'cancelled') {
          for (const r of this.store.db
            .prepare(
              'SELECT job_run_id FROM recurring_occurrences WHERE job_id=? AND job_run_id IS NOT NULL',
            )
            .all(id)) {
            const run = this.jobs.get(String(r.job_run_id));
            if (!['succeeded', 'succeeded_with_exception', 'cancelled'].includes(run.state))
              this.jobs.cancelInTransaction(run.id, request, run.revision, () => {});
          }
        }
        this.store.event(
          job.session_id,
          'schedule.revised',
          { job_id: id, revision: expected + 1, state, schedule: def },
          request,
        );
        return { id };
      },
    );
    return this.get(result.id);
  }
  private active(id: string): boolean {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM recurring_occurrences r LEFT JOIN jobs j ON j.id=r.job_run_id WHERE r.job_id=? AND (r.job_run_id IS NULL OR j.state NOT IN ('succeeded','succeeded_with_exception','cancelled'))",
      )
      .get(id);
  }
  private reserve(job: RecurringJob, key: string, due: number | null): RecurringOccurrence {
    const prior = this.store.db
      .prepare('SELECT * FROM recurring_occurrences WHERE job_id=? AND occurrence_key=?')
      .get(job.id, key) as unknown as RecurringOccurrence | undefined;
    if (prior) return prior;
    if (!this.store.db.isTransaction) throw new Error('Reservation requires transaction');
    this.jobs.assertControl();
    if (job.state !== 'active')
      throw new ServiceError('schedule_stopped', 'Recurring job is not active');
    if (this.active(job.id))
      throw new ServiceError(
        'job_overlap',
        'Prior occurrence requires settlement before another run',
      );
    if (canonical(job.template.scope) !== canonical(this.scope()))
      throw new ServiceError('template_scope_stale', 'Reviewed execution scope changed');
    const id = randomUUID(),
      session = randomUUID(),
      cwd = join(this.jobs.verification.workspaces.root!, session);
    this.store.db
      .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
      .run(session, cwd, session);
    this.store.event(session, 'session.created', { cwd, recurring_job_id: job.id });
    this.store.db
      .prepare("INSERT INTO recurring_occurrences VALUES (?,?,?,?,NULL,?,?,'provisioning',NULL,?)")
      .run(id, job.id, key, session, job.revision, due, this.now());
    this.store.event(job.session_id, 'schedule.reserved', {
      job_id: job.id,
      occurrence_id: id,
      occurrence_key: key,
      session_id: session,
    });
    return this.store.db
      .prepare('SELECT * FROM recurring_occurrences WHERE id=?')
      .get(id) as unknown as RecurringOccurrence;
  }
  trigger(
    id: string,
    request: string,
    expected: number,
    key: string,
    actor: Controller,
  ): RecurringOccurrence {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'recurring-trigger', id, expected, key },
      () => {
        string(key, 'key', 128);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(key))
          throw new ServiceError('invalid_key', 'Use a stable logical key', 400);
        const job = this.get(id),
          prior = this.store.db
            .prepare('SELECT * FROM recurring_occurrences WHERE job_id=? AND occurrence_key=?')
            .get(id, key) as unknown as RecurringOccurrence | undefined;
        if (prior) return prior;
        this.store.authorizeControl(job.session_id, actor);
        if (job.revision !== expected)
          throw new ServiceError('schedule_revision_conflict', 'Schedule revision changed');
        return this.reserve(job, key, null);
      },
    );
  }
  provision(id: string): void {
    const occurrence = this.store.db
      .prepare('SELECT * FROM recurring_occurrences WHERE id=?')
      .get(id) as unknown as RecurringOccurrence;
    if (occurrence.job_run_id || occurrence.state === 'cancelled') return;
    const job = this.get(occurrence.job_id);
    if (job.state === 'cancelled') {
      this.store.transaction(() => {
        this.store.db
          .prepare(
            "UPDATE recurring_occurrences SET state='cancelled',error='Template cancelled' WHERE id=?",
          )
          .run(id);
        this.store.event(job.session_id, 'schedule.occurrence_cancelled', { occurrence_id: id });
      });
      return;
    }
    this.jobs.assertControl();
    if (canonical(job.template.scope) !== canonical(this.scope()))
      throw new ServiceError('template_scope_stale', 'Reviewed execution scope changed');
    const tree = object(
      JSON.parse(this.jobs.verification.artifacts.read(String(job.template.snapshot_artifact))),
    ) as unknown as WorkspaceTree;
    if (digest(tree) !== job.template.workspace_digest)
      throw new ServiceError('template_corrupt', 'Snapshot digest mismatch');
    this.jobs.verification.workspaces.cloneSnapshot(occurrence.session_id, tree);
    this.store.transaction(() => {
      const task = this.jobs.tasks.createInTransaction(
        occurrence.session_id,
        'occurrence:' + id,
        0,
        job.template.plan,
        () => {},
      );
      const run = this.jobs.createInTransaction(
        task.id,
        'occurrence:' + id,
        task.revision,
        job.name,
        Number(job.template.max_steps),
        Boolean(job.template.compact),
        () => {},
      );
      const accepted = this.jobs.triggerInTransaction(
        run.id,
        'occurrence:' + id,
        1,
        occurrence.occurrence_key,
        () => {},
      );
      this.store.db
        .prepare(
          "UPDATE recurring_occurrences SET job_run_id=?,state='accepted',error=NULL WHERE id=?",
        )
        .run(run.id, id);
      this.store.event(job.session_id, 'schedule.admitted', {
        ...accepted,
        recurring_job_id: job.id,
        recurring_occurrence_id: id,
      });
    });
    this.jobs.driver.kick();
  }
  tick(): void {
    for (const row of this.store.db
      .prepare(
        'SELECT r.id,r.job_id,j.state FROM recurring_occurrences r JOIN jobs j ON j.id=r.job_run_id WHERE r.state!=j.state',
      )
      .all())
      this.store.transaction(() => {
        this.store.db
          .prepare('UPDATE recurring_occurrences SET state=? WHERE id=?')
          .run(String(row.state), String(row.id));
        this.store.event(this.get(String(row.job_id)).session_id, 'schedule.occurrence_state', {
          occurrence_id: row.id,
          state: row.state,
        });
      });
    const now = this.now();
    for (const row of this.store.db
      .prepare("SELECT id FROM recurring_jobs WHERE state='active' AND next_due<=?")
      .all(now)) {
      const job = this.get(String(row.id)),
        def = this.definition(job.id)!;
      const due = dueSlots(def, job.next_due!, now);
      this.store.transaction(() => {
        for (const slot of due.slots) {
          if (this.active(job.id)) {
            this.store.event(job.session_id, 'schedule.skipped', {
              job_id: job.id,
              due_at: slot,
              reason: 'overlap',
              revision: job.revision,
            });
            continue;
          }
          this.reserve(job, `schedule:${job.revision}:${slot}`, slot);
        }
        if (due.skipped)
          this.store.event(job.session_id, 'schedule.skipped', {
            job_id: job.id,
            from: job.next_due,
            through: now,
            reason: 'missed-policy',
            revision: job.revision,
          });
        this.store.db
          .prepare('UPDATE recurring_jobs SET next_due=? WHERE id=?')
          .run(due.next, job.id);
      });
    }
    for (const row of this.store.db
      .prepare(
        "SELECT id FROM recurring_occurrences WHERE job_run_id IS NULL AND state!='cancelled'",
      )
      .all()) {
      try {
        this.provision(String(row.id));
      } catch (error) {
        const r = this.store.db
          .prepare('SELECT job_id,error FROM recurring_occurrences WHERE id=?')
          .get(String(row.id))!;
        const message = (error as Error).message;
        if (r.error !== message)
          this.store.transaction(() => {
            this.store.db
              .prepare(
                "UPDATE recurring_occurrences SET state='waiting_for_infrastructure',error=? WHERE id=?",
              )
              .run(message, String(row.id));
            this.store.event(this.get(String(r.job_id)).session_id, 'schedule.provision_blocked', {
              occurrence_id: row.id,
              error: message,
            });
          });
      }
    }
  }
  async recover(): Promise<void> {
    for (const row of this.store.db
      .prepare(
        "SELECT j.task_id FROM jobs j JOIN recurring_occurrences r ON r.job_run_id=j.id WHERE j.state='cancelled'",
      )
      .all()) {
      if (this.jobs.tasks.get(String(row.task_id)).state === 'cancelled')
        await this.jobs.driver.stopCancelled(String(row.task_id));
    }
  }
  start() {
    this.timer = setInterval(() => {
      try {
        this.tick();
        void this.recover().catch((error) => {
          this.controlError = (error as Error).message;
        });
      } catch (error) {
        this.controlError = 'Required schedule control failed: ' + (error as Error).message;
        for (const row of this.store.db
          .prepare('SELECT session_id FROM recurring_occurrences')
          .all())
          this.jobs.driver.supervisor.failControl(String(row.session_id), error as Error);
      }
    }, 250);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
  }
}
