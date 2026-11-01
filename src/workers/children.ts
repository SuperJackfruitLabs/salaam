import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { Artifacts } from '../store/artifacts.js';
import { digest, ServiceError, type Attempt, type ChildTask } from '../core/protocol.js';
import type { RepositorySnapshots } from './repository-snapshots.js';
import type { WorkerWorkspaces } from './worker-workspaces.js';
import type { ExternalRuntime, AgentGrant } from '../core/worker-binding.js';
import type { ExternalWork } from './external-work.js';
import type { WorkspaceTree } from '../core/records.js';
import type { CodingWork } from '../coding/coding.js';

/** The supervisor members child dispatch uses. The supervisor implements it. */
export interface ChildSupervisor {
  coding?: Pick<CodingWork, 'list' | 'cancel'>;
  assertActive(id: string, epoch: number, attempt: string): void;
  assertSessionProviderSupported(id: string, outputCap?: boolean): void;
  start(id: string): Promise<void>;
  failControl(id: string, error: Error): void;
  cancelAttempt(attempt: string): Promise<void>;
}

export class ChildWork {
  external?: ExternalWork;
  workspaces?: WorkerWorkspaces;
  private paused = false;
  private starts = new Set<Promise<void>>();
  constructor(
    readonly store: Store,
    private artifacts: Artifacts,
    private supervisor: ChildSupervisor,
    private repositories?: RepositorySnapshots,
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
    profileId?: string,
    admission?: {
      authorize: () => void;
      defer: true;
      assignment: { id: string; generation: number };
      runtime?: ExternalRuntime;
    },
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
    const input = digest({
      prompt,
      budget,
      requested: [...new Set(requested)].sort(),
      ...(profileId ? { profile: profileId } : {}),
      ...(admission ? { assignment: admission.assignment } : {}),
      ...(admission?.runtime ? { runtime: admission.runtime } : {}),
    });
    let fresh = false;
    if (this.store.db.isTransaction && !admission?.defer)
      throw new Error('Nested child dispatch requires an owned deferred admission');
    const prepare = () => {
      const old = this.store.db
        .prepare('SELECT * FROM child_tasks WHERE parent_session=? AND step_key=?')
        .get(parent, step) as unknown as ChildTask | undefined;
      if (old) {
        if (old.input_digest !== input)
          throw new ServiceError('spawn_conflict', 'Step key already binds a different child');
        return old;
      }
      if (this.paused) throw new ServiceError('stopping', 'Child dispatch is stopping');
      this.store.execution.assert(parent);
      if (admission) admission.authorize();
      else this.supervisor.assertActive(parent, epoch, attempt);
      const agent = profileId
        ? this.store.workerBoundary.profiles?.resolve(parent, profileId)
        : undefined;
      if (profileId && !agent)
        throw new ServiceError('authority_denied', 'Agent profile is unavailable');
      if (!admission?.runtime)
        this.supervisor.assertSessionProviderSupported(parent, agent?.output_cap);
      if (!admission?.runtime && agent && budget > (agent.profile.max_requests ?? 8))
        throw new ServiceError('invalid_budget', 'Budget exceeds the admitted profile limit');
      const available = [
        ...(agent?.profile.tools ?? ['salaam_probe']),
        ...(admission && !admission.runtime ? ['salaam_team'] : []),
      ];
      const authority = [
        ...new Set(
          agent && !requested.length ? available : requested.filter((x) => available.includes(x)),
        ),
      ].sort();
      const effectivePrompt = agent
        ? `${agent.profile.prompt ?? 'Run the diagnostic probe.'}${admission?.runtime ? '\n\nRuntime binding: use the admitted external harness tools for the corresponding file and command actions. Its private draft is /workspace. Return evidence for explicit root integration; this invocation cannot verify the root task.' : ''}\n\nGoal:\n${prompt}\n\nExplicitly selected facts:\n${JSON.stringify(agent.facts)}`
        : prompt;
      if (Buffer.byteLength(effectivePrompt) > 65536)
        throw new ServiceError('invalid_child', 'Specialist context exceeds 64 KiB');
      if (this.owned(parent))
        throw new ServiceError('depth_exceeded', 'Child depth is limited to one');
      if (!authority.length)
        throw new ServiceError('authority_denied', 'No requested read-only authority is available');
      if (this.activeCount(parent) >= 2)
        throw new ServiceError('child_limit', 'At most two children may be active');
      if (this.activeCount() >= 8)
        throw new ServiceError('child_limit', 'Daemon worker admission limit reached');
      if (!admission?.runtime) {
        this.store.usage.budget(attempt);
        const changed = this.store.db
          .prepare(
            'UPDATE attempt_budgets SET reserved_requests=reserved_requests+? WHERE attempt_id=? AND spent_requests+reserved_requests+?<=limit_requests',
          )
          .run(budget, attempt, budget);
        if (!changed.changes)
          throw new ServiceError('budget_exhausted', 'Parent cannot reserve this child budget');
      }
      const id = randomUUID(),
        session = randomUUID(),
        submission = randomUUID(),
        childAttempt = randomUUID();
      this.store.db
        .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
        .run(session, this.store.session(parent).cwd, session);
      this.store.db
        .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
        .run(submission, session, effectivePrompt, childAttempt);
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
      if (!admission?.runtime) {
        this.store.taskChildReserve?.(parent, childAttempt, budget);
        this.store.usage.budget(childAttempt, budget);
      }
      const artifact = this.artifacts.prepare(session, effectivePrompt);
      artifact.commit();
      const repository = agent?.profile.role
        ? this.repositories?.capture(parent, session)
        : undefined;
      if (agent?.profile.role && !repository)
        throw new ServiceError('workspace_unavailable', 'No specialist snapshot boundary');
      const writing = authority.some((tool) => ['salaam_files', 'salaam_command'].includes(tool));
      const isolation =
        (writing || admission?.runtime) && repository
          ? this.workspaces?.prepare(session, repository)
          : undefined;
      if (writing && !isolation)
        throw new ServiceError('authority_denied', 'No isolated coding boundary');
      this.store.workerBoundary.freeze(
        this.owned(session)!,
        artifact.id,
        false,
        agent,
        repository,
        admission?.assignment,
        isolation,
        admission?.runtime,
      );
      if (admission?.runtime) {
        if (!this.external)
          throw new ServiceError('runtime_unavailable', 'External runtime is unavailable');
        this.external.prepare(this.owned(session)!);
      }
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
    };
    const child = this.store.db.isTransaction ? prepare() : this.store.transaction(prepare);
    // Repeated calls only return the durable binding. They never restart a child.
    if (
      fresh &&
      !admission?.defer &&
      this.store.session(child.child_session).epoch === 0 &&
      this.store.attempt(child.child_attempt).state === 'accepted'
    )
      this.start(child);
    return child;
  }
  /**
   * The task critic (item 8): a reviewer child over an immutable snapshot of the verified
   * deliverables. No parent attempt is active at completion, so it is linked to the task's last
   * step attempt and charged to its own bounded budget, never to an attempt's reservation. The
   * grant must be the built-in reviewer; the child can read the snapshot and report findings only.
   */
  spawnCritic(
    parent: string,
    parentAttempt: string,
    step: string,
    prompt: string,
    budget: number,
    grant: AgentGrant,
    snapshot: WorkspaceTree,
  ): ChildTask {
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8)
      throw new ServiceError('invalid_budget', 'Critic request budget must be 1–8');
    if (grant.profile.id !== 'salaam/reviewer' || grant.owner_session !== parent)
      throw new ServiceError('authority_denied', 'The critic must be the built-in reviewer');
    if (!Object.keys(snapshot).length)
      throw new ServiceError(
        'invalid_child',
        'A critic needs a snapshot of the verified deliverables',
      );
    if (!prompt.trim() || prompt.length > 32768)
      throw new ServiceError('invalid_child', 'Invalid critic prompt');
    const authority = [...grant.profile.tools].sort();
    const input = digest({
      prompt,
      budget,
      critic: grant.profile_digest,
      snapshot: digest(snapshot),
    });
    const prepare = () => {
      const old = this.store.db
        .prepare('SELECT * FROM child_tasks WHERE parent_session=? AND step_key=?')
        .get(parent, step) as unknown as ChildTask | undefined;
      if (old) {
        if (old.input_digest !== input)
          throw new ServiceError('spawn_conflict', 'Critic step already binds a different review');
        return { child: old, fresh: false };
      }
      if (this.paused) throw new ServiceError('stopping', 'Child dispatch is stopping');
      this.store.execution.assert(parent);
      if (this.activeCount() >= 8)
        throw new ServiceError('child_limit', 'Daemon worker admission limit reached');
      const effectivePrompt = `${grant.profile.prompt}\n\nGoal:\n${prompt}`;
      const id = randomUUID(),
        session = randomUUID(),
        submission = randomUUID(),
        childAttempt = randomUUID();
      this.store.db
        .prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)')
        .run(session, this.store.session(parent).cwd, session);
      this.store.db
        .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
        .run(submission, session, effectivePrompt, childAttempt);
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
          parentAttempt,
          step,
          input,
          session,
          childAttempt,
          JSON.stringify(authority),
          budget,
        );
      this.store.taskChildReserve?.(parent, childAttempt, budget);
      this.store.usage.budget(childAttempt, budget);
      const artifact = this.artifacts.prepare(session, effectivePrompt);
      artifact.commit();
      // The reviewed snapshot is the verified bytes; its base is empty, so its diff is all of it.
      const current = this.artifacts.prepare(session, JSON.stringify(snapshot)),
        base = this.artifacts.prepare(session, JSON.stringify({}));
      current.commit();
      base.commit();
      this.store.workerBoundary.freeze(this.owned(session)!, artifact.id, false, grant, {
        artifact_id: current.id,
        base_artifact: base.id,
        digest: digest(snapshot),
      });
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
        critic: true,
      });
      return { child: this.inspect(parent, id), fresh: true };
    };
    const { child, fresh } = this.store.transaction(prepare);
    if (fresh) this.start(child);
    return child;
  }
  activeCount(parent?: string): number {
    return Number(
      this.store.db
        .prepare(
          `SELECT count(*) AS n FROM child_tasks c WHERE (? IS NULL OR c.parent_session=?) AND (c.state='accepted' OR EXISTS(SELECT 1 FROM workers w WHERE w.session_id=c.child_session AND w.state!='exited') OR EXISTS(SELECT 1 FROM external_runs e WHERE e.child_id=c.id AND e.stopped=0))`,
        )
        .get(parent ?? null, parent ?? null)!.n,
    );
  }
  launchPrepared(child: ChildTask): void {
    if (this.store.db.isTransaction) throw new Error('Commit child intent before launch');
    if (this.store.workerBoundary.view(child.id).dispatch_state === 'intent') this.start(child);
  }
  cancelSessionInTransaction(parent: string): void {
    const child = this.list(parent)[0];
    if (child) this.cancelIntents(child.parent_attempt);
  }
  private start(child: ChildTask): void {
    const external = this.store.workerBoundary.view(child.id).binding.external;
    const task = (
      external ? this.external!.start(child) : this.supervisor.start(child.child_session)
    )
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
          this.store.projectTaskAttempt?.(this.store.attempt(attempt.id));
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
      this.store.projectTaskAttempt?.(this.store.attempt(attempt.id));
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
        ...(this.store.workerBoundary.view(child.id).binding.agent
          ? {
              worker_id: this.store.workerBoundary.view(child.id).binding.worker_id,
              report:
                this.store.db
                  .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
                  .get(this.store.workerBoundary.view(child.id).binding.worker_id)?.artifact_id ??
                null,
            }
          : {}),
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
          this.store.projectTaskAttempt?.(this.store.attempt(attempt.id));
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
        this.store.projectTaskAttempt?.(this.store.attempt(work.id));
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
    for (const child of children.filter((child) => this.store.cancelled(child.child_attempt)))
      for (const run of this.supervisor.coding?.list(child.child_session) ?? [])
        if (
          ![
            'succeeded',
            'failed',
            'cancelled',
            'timed_out',
            'output_limited',
            'interrupted',
          ].includes(run.state)
        )
          this.supervisor.coding!.cancel(
            child.child_session,
            run.id,
            'child-stop:' + run.id,
            () => {},
          );
    await Promise.all(
      children
        .filter((child) => this.store.cancelled(child.child_attempt))
        .map((child) =>
          this.store.workerBoundary.view(child.id).binding.external
            ? this.external!.cancel(child)
            : this.supervisor.cancelAttempt(child.child_attempt),
        ),
    );
  }
  pause(): void {
    this.paused = true;
  }
  async close(): Promise<void> {
    await Promise.all(this.starts);
  }
}
