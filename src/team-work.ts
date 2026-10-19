import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { TaskWork } from './task-work.js';
import type { TaskBudget } from './task-budget.js';
import type { ChildWork } from './children.js';
import type { AgentProfiles } from './agent-profiles.js';
import type { WorkerBinding } from './worker-boundary.js';
import { digest, ServiceError, type Controller, type ChildTask } from './protocol.js';

export interface TeamAssignment {
  id: string;
  task_id: string;
  step_id: string;
  plan_revision: number;
  profile_id: string;
  grant_id: string;
  budget: number;
  generation: number;
  child_id: string | null;
  superseded: number;
}

/** Assignment claims extend the task ledger. They are never an independent scheduler. */
export class TeamWork {
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly budget: TaskBudget,
    readonly children: ChildWork,
    readonly profiles: AgentProfiles,
  ) {
    store.workerBoundary.assertAssignment = (binding) => this.assert(binding);
    store.teamSnapshot = (session) => {
      const task = tasks.forSession(session);
      return task ? this.view(task.id) : null;
    };
    tasks.delegatedStep = (task, step) => !!this.forStep(task, step);
    tasks.advanceDelegate = (id) => {
      const grant = store.db.prepare('SELECT * FROM task_grants WHERE id=?').get(id)!;
      const assignment = this.forStep(String(grant.task_id), String(grant.step_id));
      if (!assignment)
        throw new ServiceError('team_assignment_missing', 'Step assignment disappeared');
      return this.run(
        assignment.id,
        'task-grant:' + id,
        Number(grant.expected_revision),
        assignment.generation,
        null,
        null,
        null,
        id,
      );
    };
  }
  forStep(task: string, step: string): TeamAssignment | undefined {
    return this.store.db
      .prepare('SELECT * FROM team_assignments WHERE task_id=? AND step_id=? AND superseded=0')
      .get(task, step) as unknown as TeamAssignment | undefined;
  }
  get(id: string): TeamAssignment {
    const row = this.store.db
      .prepare('SELECT * FROM team_assignments WHERE id=?')
      .get(id) as unknown as TeamAssignment | undefined;
    if (!row) throw new ServiceError('not_found', 'Team assignment not found', 404);
    return row;
  }
  private expect(task: string, revision: number): void {
    if (this.tasks.get(task).revision !== revision)
      throw new ServiceError('task_revision_conflict', 'Task revision changed');
  }
  assign(
    taskId: string,
    stepId: string,
    profile: string,
    requests: number,
    request: string,
    expected: number,
    controller: Controller,
    runtime?: string,
  ): TeamAssignment {
    return this.store.request(
      'local-operator',
      request,
      {
        kind: 'team-assign',
        taskId,
        stepId,
        profile,
        requests,
        expected,
        ...(runtime ? { runtime } : {}),
      },
      () => {
        const task = this.tasks.get(taskId);
        this.store.authorizeControl(task.session_id, controller);
        this.expect(taskId, expected);
        if (['cancelled', 'succeeded', 'succeeded_with_exception'].includes(task.state))
          throw new ServiceError('task_settled', 'Revise the task before assigning workers');
        const step = task.steps.find((s) => s.id === stepId);
        if (!step || step.attempt_id || step.state !== 'pending')
          throw new ServiceError('invalid_step_state', 'Assign an unattempted pending step');
        const old = this.forStep(taskId, stepId);
        if (old) {
          if (old.plan_revision === task.plan_revision || old.generation !== 0)
            throw new ServiceError(
              'team_assignment_exists',
              'An immutable assignment already owns this step',
            );
          this.store.db.prepare('UPDATE team_assignments SET superseded=1 WHERE id=?').run(old.id);
        }
        const grant = this.profiles.resolve(task.session_id, profile);
        if (
          !Number.isSafeInteger(requests) ||
          requests < 1 ||
          requests > (grant.profile.max_requests ?? 8)
        )
          throw new ServiceError('invalid_budget', 'Assignment exceeds profile request bounds');
        const id = randomUUID();
        this.store.db
          .prepare('INSERT INTO team_assignments VALUES (?,?,?,?,?,?,?,0,NULL,0)')
          .run(id, taskId, stepId, task.plan_revision, profile, grant.id, requests);
        if (runtime) {
          if (!this.children.external || requests !== 1)
            throw new ServiceError(
              'runtime_unavailable',
              'External assignments require one invocation and a configured runtime',
            );
          this.children.external.assign(id, task, runtime, grant.profile.tools);
        }
        this.changed(taskId, 'assigned', {
          assignment_id: id,
          step_id: stepId,
          profile_id: profile,
        });
        return this.get(id);
      },
    );
  }
  run(
    id: string,
    request: string,
    expected: number,
    generation: number,
    instruction: string | null,
    continuation: string | null,
    controller: Controller | null,
    grantId?: string,
    peerAdmission?: {
      scope: string;
      digest: string;
      authorize: () => void;
      committed: (child: ChildTask) => void;
    },
  ): TeamAssignment {
    let launch: ChildTask | undefined;
    const result = this.store.request(
      peerAdmission?.scope ?? 'local-operator',
      request,
      {
        kind: 'team-run',
        id,
        expected,
        ...(!grantId ? { generation } : {}),
        instruction,
        continuation,
        ...(grantId ? { grantId } : {}),
        ...(peerAdmission ? { peer_admission: peerAdmission.digest } : {}),
      },
      () => {
        const row = this.get(id),
          task = this.tasks.get(row.task_id);
        if (peerAdmission) peerAdmission.authorize();
        else if (controller) this.store.authorizeControl(task.session_id, controller);
        else this.tasks.authorizeGrant(task, row.step_id, grantId);
        this.expect(task.id, expected);
        if (
          row.superseded ||
          row.plan_revision !== task.plan_revision ||
          row.generation !== generation
        )
          throw new ServiceError('team_claim_stale', 'Assignment plan or generation changed');
        if (generation >= 8)
          throw new ServiceError(
            'team_claim_limit',
            'At most eight explicitly admitted generations per assignment',
          );
        if (['cancelled', 'succeeded', 'succeeded_with_exception'].includes(task.state))
          throw new ServiceError('task_settled', 'Task no longer admits work');
        const step = task.steps.find((s) => s.id === row.step_id)!;
        if (!['pending', 'interrupted', 'failed', 'cancelled'].includes(step.state))
          throw new ServiceError(
            'invalid_step_state',
            'Assignment is active or already awaiting review',
          );
        if (
          step.depends_on.some(
            (key) => task.steps.find((s) => s.key === key)?.state !== 'completed',
          )
        )
          throw new ServiceError('dependency_pending', 'Complete predecessor steps first');
        const interrupted =
          step.attempt_id && this.store.attempt(step.attempt_id).state === 'interrupted'
            ? step.attempt_id
            : null;
        if (continuation !== interrupted || (row.child_id && !instruction))
          throw new ServiceError(
            'invalid_continuation',
            'Follow-up requires a new instruction and the exact interrupted attempt, if any',
          );
        if (instruction !== null && (!instruction.trim() || instruction.length > 4096))
          throw new ServiceError('invalid_field', 'Supply a bounded follow-up instruction', 400);
        if (row.child_id) {
          const prior = this.children.inspect(task.session_id, row.child_id);
          if (
            prior.state === 'accepted' ||
            (prior.worker?.binding.external && !this.children.external?.stopped(prior.id)) ||
            this.store.db
              .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
              .get(prior.child_session)
          )
            throw new ServiceError(
              'team_worker_uncertain',
              'Confirm the previous process stopped before claiming a new generation',
            );
        }
        const agent = this.profiles.resolve(task.session_id, row.profile_id);
        if (agent.id !== row.grant_id)
          throw new ServiceError(
            'team_claim_stale',
            'Assignment requires its original profile admission',
          );
        this.budget.check(task.session_id);
        this.children.external?.validateAssignment(id, task);
        if (this.budget.active(task) >= task.limits.concurrency)
          throw new ServiceError('task_busy', 'Root task concurrency is full');
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running','interrupted') AND resolved_by IS NULL",
            )
            .get(task.session_id)
        )
          throw new ServiceError('task_busy', 'Root session has pending work');
        const envelope = randomUUID(),
          submission = randomUUID();
        // A delegated envelope has never been dispatched to a model. Dispatcher excludes this state.
        this.store.db
          .prepare(
            "INSERT INTO submissions(id,session_id,text,state,attempt_id) VALUES (?,?,?,'delegated',?)",
          )
          .run(submission, task.session_id, step.instruction, envelope);
        this.store.db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,?,'delegated')",
          )
          .run(envelope, task.session_id, submission);
        const next = generation + 1;
        const child = this.children.spawn(
          task.session_id,
          0,
          envelope,
          `team:${id}:${next}`,
          instruction ?? step.instruction,
          row.budget,
          [],
          row.profile_id,
          {
            authorize: () => {},
            defer: true,
            assignment: { id, generation: next },
            runtime: this.children.external?.assignment(id),
          },
        );
        this.store.db
          .prepare('UPDATE team_assignments SET generation=?,child_id=? WHERE id=?')
          .run(next, child.id, id);
        this.store.db
          .prepare('INSERT INTO task_step_attempts VALUES (?,?,?,?)')
          .run(child.child_attempt, step.id, task.plan_revision, instruction ?? step.instruction);
        this.store.db
          .prepare("UPDATE task_steps SET attempt_id=?,state='queued',review=NULL WHERE id=?")
          .run(child.child_attempt, step.id);
        if (interrupted)
          this.store.db
            .prepare('UPDATE attempts SET resolved_by=? WHERE id=?')
            .run(child.child_attempt, interrupted);
        this.store.db
          .prepare('UPDATE task_runtime SET started_at=coalesce(started_at,?) WHERE task_id=?')
          .run(Date.now(), task.id);
        this.store.db
          .prepare(
            "UPDATE durable_tasks SET state='running',reason='Team assignment claimed' WHERE id=?",
          )
          .run(task.id);
        if (grantId)
          this.store.db.prepare("UPDATE task_grants SET state='accepted' WHERE id=?").run(grantId);
        this.changed(task.id, 'claimed', {
          assignment_id: id,
          generation: next,
          child_id: child.id,
          attempt_id: child.child_attempt,
        });
        peerAdmission?.committed(child);
        launch = child;
        return this.get(id);
      },
    );
    if (launch) this.children.launchPrepared(launch);
    return result;
  }
  reject(
    id: string,
    request: string,
    expected: number,
    generation: number,
    reason: string,
    controller: Controller,
  ): TeamAssignment {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'team-reject', id, expected, generation, reason },
      () => {
        const assignment = this.get(id),
          task = this.tasks.get(assignment.task_id),
          step = task.steps.find((s) => s.id === assignment.step_id)!;
        this.store.authorizeControl(task.session_id, controller);
        this.expect(task.id, expected);
        if (
          task.state === 'cancelled' ||
          assignment.generation !== generation ||
          !step.attempt_id ||
          !['awaiting_review', 'failed', 'interrupted'].includes(step.state)
        )
          throw new ServiceError('team_claim_stale', 'Reject the current settled claim only');
        if (!reason.trim() || reason.length > 4096)
          throw new ServiceError('invalid_field', 'Record a bounded rejection reason', 400);
        this.store.db
          .prepare('INSERT INTO team_rejections VALUES (?,?,?,?)')
          .run(step.id, step.attempt_id, request, reason);
        this.store.db
          .prepare("UPDATE task_steps SET state='failed',review=? WHERE id=?")
          .run(reason, step.id);
        this.store.db
          .prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?')
          .run(task.id);
        this.store.db
          .prepare(
            "UPDATE durable_tasks SET state='blocked',reason='Operator rejected worker proposal; explicit follow-up required' WHERE id=?",
          )
          .run(task.id);
        this.changed(task.id, 'proposal_rejected', {
          assignment_id: id,
          generation,
          attempt_id: step.attempt_id,
          reason,
        });
        return this.get(id);
      },
    );
  }
  assert(binding: WorkerBinding): TeamAssignment {
    const row = this.get(binding.assignment!.id),
      task = this.tasks.get(row.task_id),
      step = task.steps.find((s) => s.id === row.step_id);
    if (
      task.state === 'cancelled' ||
      row.plan_revision !== task.plan_revision ||
      row.generation !== binding.assignment!.generation ||
      row.child_id === null ||
      this.children.inspect(task.session_id, row.child_id).child_attempt !== binding.attempt_id ||
      step?.attempt_id !== binding.attempt_id ||
      binding.owner_task !== task.id ||
      binding.owner_session !== task.session_id ||
      binding.agent?.id !== row.grant_id
    )
      throw new ServiceError(
        'team_claim_stale',
        'Worker no longer owns the current task-step claim',
      );
    return row;
  }
  private changed(task: string, kind: string, detail: unknown): void {
    this.store.db.prepare('UPDATE durable_tasks SET revision=revision+1 WHERE id=?').run(task);
    this.store.event(this.tasks.get(task).session_id, 'team.' + kind, {
      task_id: task,
      ...(detail as object),
    });
  }
  view(task: string): unknown {
    const current = this.tasks.get(task);
    const assignments = (
      this.store.db
        .prepare('SELECT * FROM team_assignments WHERE task_id=? ORDER BY rowid')
        .all(task) as unknown as TeamAssignment[]
    ).map((a) => ({
      ...a,
      stale: a.plan_revision !== current.plan_revision,
      step_state: current.steps.find((s) => s.id === a.step_id)?.state,
      worker: a.child_id ? this.children.inspect(current.session_id, a.child_id).worker : null,
      runtime: this.children.external?.assignment(a.id) ?? null,
      execution:
        a.child_id && this.children.inspect(current.session_id, a.child_id).worker?.binding.external
          ? {
              state: this.children.external!.row(a.child_id).state,
              stopped: this.children.external!.stopped(a.child_id),
              stop_scope:
                this.children.external!.assignment(a.id)?.kind === 'a2a'
                  ? (() => {
                      const receipt = this.children.external!.row(a.child_id).receipt;
                      return receipt
                        ? (JSON.parse(receipt).scope ?? 'remote-terminal-receipt')
                        : 'remote-terminal-receipt';
                    })()
                  : 'owned-processes',
              peer: (() => {
                const row = this.children.external!.row(a.child_id);
                const cp = row.checkpoint ? JSON.parse(row.checkpoint) : null;
                return cp?.dialect === 'a2a'
                  ? {
                      peer_id: cp.peer_id,
                      task_id: cp.task_id,
                      context_id: cp.context_id,
                      cancel_state: cp.cancel_state ?? null,
                      remote_state: cp.result?.status?.state ?? null,
                    }
                  : null;
              })(),
            }
          : null,
    }));
    const messages = this.store.db
      .prepare(
        'SELECT id,sender,recipient,created_at,delivered_at,acknowledged_at FROM team_messages WHERE task_id=? ORDER BY rowid DESC LIMIT 128',
      )
      .all(task);
    return {
      task_id: task,
      assignments,
      messages,
      bounds: {
        root_concurrency: current.limits.concurrency,
        session_workers: 2,
        daemon_workers: 8,
        wake_on_message: false,
      },
    };
  }
  send(
    taskId: string,
    sender: string,
    recipient: string,
    text: string,
    messageId: string,
    authorize: () => void,
  ): unknown {
    return this.store.request(
      `team-message:${taskId}:${sender}`,
      messageId,
      { recipient, text },
      () => {
        authorize();
        const task = this.tasks.get(taskId);
        if (task.state === 'cancelled') throw new ServiceError('task_settled', 'Task is cancelled');
        if (
          this.get(recipient).task_id !== taskId ||
          (sender !== 'operator' && this.get(sender).task_id !== taskId)
        )
          throw new ServiceError('team_message_scope', 'Messages stay within their owning task');
        if (!text.trim() || Buffer.byteLength(text) > 4096 || !messageId || messageId.length > 128)
          throw new ServiceError(
            'invalid_field',
            'Bound messages to 4 KiB and IDs to 128 characters',
            400,
          );
        const n = Number(
          this.store.db
            .prepare('SELECT count(*) AS n FROM team_messages WHERE task_id=?')
            .get(taskId)!.n,
        );
        if (
          n >= 256 ||
          Number(
            this.store.db
              .prepare(
                'SELECT count(*) AS n FROM team_messages WHERE recipient=? AND acknowledged_at IS NULL',
              )
              .get(recipient)!.n,
          ) >= 32
        )
          throw new ServiceError('team_backpressure', 'Team message quota reached');
        const id = randomUUID();
        this.store.db
          .prepare('INSERT INTO team_messages VALUES (?,?,?,?,?,?,?,NULL,NULL)')
          .run(
            id,
            taskId,
            sender,
            recipient,
            text,
            digest({ sender, recipient, text }),
            Date.now(),
          );
        this.store.event(task.session_id, 'team.message_saved', {
          message_id: id,
          sender,
          recipient,
          wakes_worker: false,
        });
        return { id, stored: true, delivered: false, acknowledged: false, wakes_worker: false };
      },
    );
  }
  receive(recipient: string, request: string, authorize: () => void): unknown {
    return this.store.request('team-receive:' + recipient, request, {}, () => {
      authorize();
      const row = this.get(recipient),
        now = Date.now();
      const messages = this.store.db
        .prepare(
          'SELECT * FROM team_messages WHERE recipient=? AND acknowledged_at IS NULL ORDER BY rowid LIMIT 32',
        )
        .all(recipient);
      for (const m of messages)
        this.store.db
          .prepare('UPDATE team_messages SET delivered_at=coalesce(delivered_at,?) WHERE id=?')
          .run(now, String(m.id));
      this.store.event(this.tasks.get(row.task_id).session_id, 'team.messages_delivered', {
        recipient,
        message_ids: messages.map((m) => m.id),
      });
      return messages.map((m) => ({ ...m, delivered_at: m.delivered_at ?? now }));
    });
  }
  acknowledge(recipient: string, id: string, request: string, authorize: () => void): unknown {
    return this.store.request('team-ack:' + recipient, request, { id }, () => {
      authorize();
      const row = this.get(recipient),
        message = this.store.db
          .prepare('SELECT * FROM team_messages WHERE id=? AND recipient=?')
          .get(id, recipient);
      if (!message?.delivered_at)
        throw new ServiceError('message_not_delivered', 'Receive the message before acknowledging');
      this.store.db
        .prepare('UPDATE team_messages SET acknowledged_at=coalesce(acknowledged_at,?) WHERE id=?')
        .run(Date.now(), id);
      this.store.event(this.tasks.get(row.task_id).session_id, 'team.message_acknowledged', {
        recipient,
        message_id: id,
      });
      return { id, acknowledged: true };
    });
  }
}
