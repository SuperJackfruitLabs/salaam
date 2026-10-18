import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { TaskContext } from './task-context.js';
import {
  canonical,
  object,
  ServiceError,
  string,
  type Attempt,
  type Controller,
} from './protocol.js';

export interface StepPlan {
  key: string;
  title: string;
  instruction: string;
  depends_on: string[];
}
export interface TaskPlan {
  objective: string;
  constraints: string[];
  steps: StepPlan[];
}
export interface WorkStep extends StepPlan {
  id: string;
  state:
    | 'pending'
    | 'queued'
    | 'running'
    | 'awaiting_review'
    | 'interrupted'
    | 'failed'
    | 'cancelled'
    | 'completed';
  attempt_id: string | null;
  review: string | null;
}
export interface WorkTask {
  id: string;
  session_id: string;
  revision: number;
  plan_revision: number;
  state: 'accepted' | 'running' | 'blocked' | 'verifying';
  objective: string;
  constraints: string[];
  reason: string;
  steps: WorkStep[];
}

/** Operator-driven task ledger. An attempt outcome never constitutes task success. */
export class TaskWork {
  constructor(
    readonly store: Store,
    readonly context: TaskContext,
  ) {
    context.work = this;
    store.projectTaskAttempt = (attempt) => this.project(attempt);
    store.guardTaskSubmission = (session, step) => {
      const task = this.forSession(session);
      if (task && !task.steps.some((s) => s.id === step))
        throw new ServiceError(
          'task_step_required',
          'Use an explicit task step run or continuation for this session',
        );
      if (!task && step)
        throw new ServiceError('invalid_step', 'Step does not belong to this session');
    };
  }
  private parse(input: unknown): TaskPlan {
    const value = object(input);
    const objective = string(value.objective, 'objective', 4096);
    if (!Array.isArray(value.constraints) || value.constraints.length > 16)
      throw new ServiceError('invalid_plan', 'Supply at most 16 constraints', 400);
    const constraints = value.constraints.map((v) => string(v, 'constraint', 2048));
    if (!Array.isArray(value.steps) || !value.steps.length || value.steps.length > 32)
      throw new ServiceError('invalid_plan', 'Supply 1–32 steps', 400);
    const keys = new Set<string>();
    const steps = value.steps.map((raw) => {
      const s = object(raw),
        key = string(s.key, 'step key', 64);
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || keys.has(key))
        throw new ServiceError('invalid_plan', 'Step keys must be unique identifiers', 400);
      if (s.depends_on !== undefined && !Array.isArray(s.depends_on))
        throw new ServiceError('invalid_plan', 'Dependencies must be step keys', 400);
      const depends_on = ((s.depends_on as unknown[] | undefined) ?? []).map((v) =>
        string(v, 'dependency', 64),
      );
      if (new Set(depends_on).size !== depends_on.length || depends_on.some((k) => !keys.has(k)))
        throw new ServiceError(
          'invalid_plan',
          'Dependencies must name distinct earlier steps',
          400,
        );
      keys.add(key);
      return {
        key,
        title: string(s.title, 'title', 256),
        instruction: string(s.instruction, 'instruction', 4096),
        depends_on,
      };
    });
    return { objective, constraints, steps };
  }
  forSession(session: string): WorkTask | null {
    const row = this.store.db
      .prepare('SELECT id FROM durable_tasks WHERE session_id=?')
      .get(session) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }
  get(id: string): WorkTask {
    const row = this.store.db.prepare('SELECT * FROM durable_tasks WHERE id=?').get(id) as
      (Omit<WorkTask, 'constraints' | 'steps'> & { constraints_json: string }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Task not found', 404);
    const { constraints_json, ...task } = row;
    const rows = this.store.db
      .prepare('SELECT * FROM task_steps WHERE task_id=? ORDER BY ordinal')
      .all(id) as unknown as (Omit<WorkStep, 'key' | 'depends_on'> & {
      step_key: string;
      dependencies: string;
      task_id: string;
      ordinal: number;
    })[];
    return {
      ...task,
      constraints: JSON.parse(constraints_json),
      steps: rows.map(({ step_key, dependencies, task_id: _, ordinal: __, ...s }) => ({
        ...s,
        key: step_key,
        depends_on: JSON.parse(dependencies),
      })),
    };
  }
  history(id: string, offset = 0): unknown {
    this.get(id);
    const plans = this.store.db
      .prepare(
        'SELECT revision,document,request_id FROM task_plans WHERE task_id=? ORDER BY revision LIMIT 33 OFFSET ?',
      )
      .all(id, offset);
    const attempts = this.store.db
      .prepare(
        'SELECT b.*,a.state,a.worker_epoch,a.continues_attempt_id,a.resolved_by FROM task_step_attempts b JOIN attempts a ON a.id=b.attempt_id JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=? ORDER BY b.rowid LIMIT 33 OFFSET ?',
      )
      .all(id, offset);
    return {
      plans: plans.slice(0, 32).map((r) => ({
        revision: r.revision,
        plan: JSON.parse(r.document as string),
        request_id: r.request_id,
      })),
      attempts: attempts.slice(0, 32),
      next_offset: plans.length > 32 || attempts.length > 32 ? offset + 32 : null,
    };
  }
  private idle(session: string): void {
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM attempts WHERE session_id=? AND (state IN ('accepted','dispatching','running') OR (state='interrupted' AND resolved_by IS NULL))",
        )
        .get(session)
    )
      throw new ServiceError('task_busy', 'Session has pending work or an unresolved interruption');
  }
  private changed(id: string, kind: string, payload: unknown, cause: string | null = null): void {
    this.store.db.prepare('UPDATE durable_tasks SET revision=revision+1 WHERE id=?').run(id);
    const task = this.get(id);
    this.store.event(
      task.session_id,
      'work_task.' + kind,
      { task_id: id, revision: task.revision, detail: payload },
      cause,
    );
  }
  private expect(task: WorkTask, revision: number): void {
    if (task.revision !== revision)
      throw new ServiceError('task_revision_conflict', 'Task revision changed');
  }
  create(
    session: string,
    request: string,
    expected: number,
    input: unknown,
    controller: Controller,
  ): WorkTask {
    const plan = this.parse(input);
    return this.store.request(
      'local-operator',
      request,
      { kind: 'work-task-create', session, expected, plan },
      () => {
        this.store.authorizeControl(session, controller);
        if (expected !== 0)
          throw new ServiceError('task_revision_conflict', 'New tasks require revision zero');
        this.idle(session);
        if (this.store.db.prepare('SELECT 1 FROM child_tasks WHERE child_session=?').get(session))
          throw new ServiceError(
            'invalid_task_session',
            'Child sessions cannot own operator tasks',
          );
        if (this.forSession(session))
          throw new ServiceError('task_exists', 'This session already has a durable task');
        const id = randomUUID();
        this.store.db
          .prepare(
            "INSERT INTO durable_tasks VALUES (?,?,0,1,'accepted',?,?,'Waiting for an explicit step run')",
          )
          .run(id, session, plan.objective, canonical(plan.constraints));
        this.savePlan(id, request, plan);
        this.context.frame(session, 'x'.repeat(32));
        this.changed(id, 'created', { plan_revision: 1 }, request);
        return this.get(id);
      },
    );
  }
  private savePlan(id: string, request: string, plan: TaskPlan): void {
    const task = this.get(id);
    const prior = task.steps;
    plan.steps.forEach((s, ordinal) => {
      const old = prior.find((p) => p.key === s.key);
      if (!old)
        this.store.db
          .prepare("INSERT INTO task_steps VALUES (?,?,?,?,?,?,?,'pending',NULL,NULL)")
          .run(randomUUID(), id, s.key, ordinal, s.title, s.instruction, canonical(s.depends_on));
      else
        this.store.db
          .prepare('UPDATE task_steps SET title=?,instruction=?,dependencies=? WHERE id=?')
          .run(s.title, s.instruction, canonical(s.depends_on), old.id);
    });
    this.store.db
      .prepare('INSERT INTO task_plans VALUES (?,?,?,?)')
      .run(id, task.plan_revision, canonical(plan), request);
  }
  revise(
    id: string,
    request: string,
    expected: number,
    input: unknown,
    controller: Controller,
  ): WorkTask {
    const plan = this.parse(input);
    return this.store.request(
      'local-operator',
      request,
      { kind: 'work-task-revise', id, expected, plan },
      () => {
        const task = this.get(id);
        this.store.authorizeControl(task.session_id, controller);
        this.expect(task, expected);
        this.idle(task.session_id);
        for (const [index, step] of task.steps.entries()) {
          const next = plan.steps[index];
          if (!next || next.key !== step.key)
            throw new ServiceError('invalid_plan', 'Existing steps cannot be removed or reordered');
          if (
            step.attempt_id &&
            canonical(next) !==
              canonical({
                key: step.key,
                title: step.title,
                instruction: step.instruction,
                depends_on: step.depends_on,
              })
          )
            throw new ServiceError(
              'invalid_plan',
              'An attempted step is immutable; append a correction step',
            );
        }
        this.store.db
          .prepare(
            'UPDATE durable_tasks SET objective=?,constraints_json=?,plan_revision=plan_revision+1 WHERE id=?',
          )
          .run(plan.objective, canonical(plan.constraints), id);
        this.savePlan(id, request, plan);
        this.context.frame(task.session_id, 'x'.repeat(32));
        if (plan.steps.length > task.steps.length)
          this.store.db
            .prepare(
              "UPDATE durable_tasks SET state='blocked',reason='Plan revised; waiting for an explicit step run' WHERE id=?",
            )
            .run(id);
        this.changed(id, 'plan_revised', { plan_revision: task.plan_revision + 1 }, request);
        return this.get(id);
      },
    );
  }
  run(
    id: string,
    stepId: string,
    request: string,
    expected: number,
    instruction: string | null,
    continuation: string | null,
    controller: Controller,
  ): { task_id: string; step_id: string; attempt_id: string; id: string; state: 'accepted' } {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'work-step-run', id, stepId, expected, instruction, continuation },
      () => {
        const task = this.get(id);
        this.store.authorizeControl(task.session_id, controller);
        this.expect(task, expected);
        const step = task.steps.find((s) => s.id === stepId);
        if (!step) throw new ServiceError('invalid_step', 'Step does not belong to this task');
        if (!['pending', 'failed', 'interrupted', 'cancelled'].includes(step.state))
          throw new ServiceError('invalid_step_state', 'Step cannot be run in its current state');
        if (
          step.depends_on.some(
            (key) => task.steps.find((s) => s.key === key)?.state !== 'completed',
          )
        )
          throw new ServiceError(
            'dependency_pending',
            'Review and complete the required steps first',
          );
        const unresolved = step.state === 'interrupted' ? step.attempt_id : null;
        if (continuation !== unresolved || (unresolved && !instruction))
          throw new ServiceError(
            'invalid_continuation',
            'An interrupted step requires its exact attempt and a new instruction',
          );
        // An explicit continuation resolves only its own interruption; no other queue is admitted.
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM attempts WHERE session_id=? AND (state IN ('accepted','dispatching','running') OR (state='interrupted' AND resolved_by IS NULL AND id<>?))",
            )
            .get(task.session_id, continuation ?? '')
        )
          throw new ServiceError('task_busy', 'Session has other pending work');
        const text = instruction ?? step.instruction;
        const accepted = this.store.enqueue(
          task.session_id,
          request,
          text,
          controller,
          continuation,
          step.id,
        );
        this.store.db
          .prepare('INSERT INTO task_step_attempts VALUES (?,?,?,?)')
          .run(accepted.attempt_id, step.id, task.plan_revision, text);
        this.store.db
          .prepare("UPDATE task_steps SET attempt_id=?,state='queued',review=NULL WHERE id=?")
          .run(accepted.attempt_id, step.id);
        this.store.db
          .prepare(
            "UPDATE durable_tasks SET state='running',reason='Explicit step request accepted' WHERE id=?",
          )
          .run(id);
        this.context.frame(task.session_id, 'x'.repeat(32));
        this.changed(
          id,
          'step_accepted',
          { step_id: step.id, attempt_id: accepted.attempt_id, continues_attempt_id: continuation },
          request,
        );
        return { ...accepted, task_id: id, step_id: step.id };
      },
    );
  }
  complete(
    id: string,
    stepId: string,
    request: string,
    expected: number,
    review: string,
    controller: Controller,
  ): WorkTask {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'work-step-complete', id, stepId, expected, review },
      () => {
        const task = this.get(id);
        this.store.authorizeControl(task.session_id, controller);
        this.expect(task, expected);
        this.idle(task.session_id);
        const step = task.steps.find((s) => s.id === stepId);
        if (
          step?.state !== 'awaiting_review' ||
          !step.attempt_id ||
          this.store.attempt(step.attempt_id).state !== 'completed'
        )
          throw new ServiceError(
            'invalid_step_state',
            'Only a settled step awaiting operator review can be completed',
          );
        this.store.db
          .prepare("UPDATE task_steps SET state='completed',review=? WHERE id=?")
          .run(review, step.id);
        const all = this.get(id).steps.every((s) => s.state === 'completed');
        this.store.db
          .prepare('UPDATE durable_tasks SET state=?,reason=? WHERE id=?')
          .run(
            all ? 'verifying' : 'blocked',
            all
              ? 'All steps reviewed by operator; task verification is not implemented'
              : 'Step reviewed by operator; waiting for an explicit step run',
            id,
          );
        this.context.frame(task.session_id, 'x'.repeat(32));
        this.changed(
          id,
          'step_reviewed',
          {
            step_id: step.id,
            attempt_id: step.attempt_id,
            review,
            source: 'operator',
            verified: false,
          },
          request,
        );
        return this.get(id);
      },
    );
  }
  /** Invoked in the same transaction as the attempt state mutation. */
  private project(attempt: Attempt): void {
    const row = this.store.db
      .prepare('SELECT task_id,id,state FROM task_steps WHERE attempt_id=?')
      .get(attempt.id) as { task_id: string; id: string; state: WorkStep['state'] } | undefined;
    if (!row || row.state === 'completed') return;
    const state: WorkStep['state'] = (
      {
        accepted: 'queued',
        dispatching: 'running',
        running: 'running',
        completed: 'awaiting_review',
        failed: 'failed',
        interrupted: 'interrupted',
        cancelled: 'cancelled',
      } as const
    )[attempt.state];
    if (row.state === state) return;
    const active = state === 'queued' || state === 'running';
    this.store.db.prepare('UPDATE task_steps SET state=? WHERE id=?').run(state, row.id);
    this.store.db
      .prepare('UPDATE durable_tasks SET state=?,reason=? WHERE id=?')
      .run(
        active ? 'running' : 'blocked',
        active
          ? 'Explicit step attempt in progress'
          : state === 'awaiting_review'
            ? 'Attempt settled; operator review required'
            : 'Attempt ' + state + '; explicit operator instruction required',
        row.task_id,
      );
    this.changed(row.task_id, 'step_state', { step_id: row.id, attempt_id: attempt.id, state });
  }
  recover(): void {
    this.store.transaction(() => {
      for (const row of this.store.db
        .prepare('SELECT attempt_id FROM task_steps WHERE attempt_id IS NOT NULL')
        .all() as { attempt_id: string }[])
        this.project(this.store.attempt(row.attempt_id));
    });
  }
  frame(session: string): unknown {
    const task = this.forSession(session);
    return task
      ? {
          ...task,
          steps: task.steps.map(({ review: _, ...step }) => step),
          instructions:
            'Only the operator starts or continues steps. Attempt completion requires operator review; task success requires verification. Completed steps must not be repeated.',
        }
      : null;
  }
}
