import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { Artifacts } from '../store/artifacts.js';
import type { TaskBudget } from '../tasks/budget.js';
import type { WorkTask, WorkspaceTree } from '../core/records.js';
import type { ManagedWork } from '../execution/managed.js';
import type { ExternalBackend, ExternalCheckpoint } from './external-runtime.js';
import {
  externalCapabilities,
  type WorkerBinding,
  type ExternalRuntime,
} from '../core/worker-binding.js';
import { readTree, validateTree, type Workspaces } from './workspaces.js';
import { canonical, digest, ServiceError, type ChildTask } from '../core/protocol.js';
import { POLICY_DIGEST } from '../core/config.js';

/** The child ledger members external work reads. Child dispatch implements it. */
export interface ExternalChildren {
  owned(session: string): ChildTask | undefined;
  list(parent: string): ChildTask[];
}
/** External invocations extend existing child attempts and task-step claims, never a second scheduler. */
export class ExternalWork {
  private paused = false;
  private active = new Map<string, Promise<void>>();
  private failed = new Set<string>();
  private owned = new Map<string, { child: ChildTask; run: string; runtime: ExternalRuntime }>();
  constructor(
    readonly store: Store,
    readonly artifacts: Artifacts,
    readonly children: ExternalChildren,
    readonly budget: TaskBudget,
    readonly managed: ManagedWork,
    readonly workspaces: Workspaces,
    readonly backend?: ExternalBackend,
    readonly admitModelRequest?: (
      session: string,
      attempt: string,
      input: number,
      output: number,
    ) => void,
  ) {}
  private policy(task: WorkTask): void {
    if (this.paused)
      throw new ServiceError('host_control_unavailable', 'External worker control is unavailable');
    if (!task.limits.invocations || task.limits.token_units !== null)
      throw new ServiceError(
        'worker_budget_scope',
        'Opaque workers require explicit limits.invocations and token_units:null; internal model usage remains unknown',
      );
  }
  runtimes(): ExternalRuntime[] {
    return this.backend?.runtimes() ?? [];
  }
  status() {
    return {
      available: !this.paused,
      active_runs: this.active.size,
      failed_workers: this.failed.size,
    };
  }
  assign(id: string, task: WorkTask, runtimeId: string, tools: readonly string[]): void {
    this.policy(task);
    const runtime = this.runtimes().find((r) => r.id === runtimeId);
    if (!runtime)
      throw new ServiceError(
        'runtime_unavailable',
        'No operator-configured runtime with this identity',
      );
    this.backend!.validate(runtime);
    this.backend!.assertAuthority?.(runtime, tools);
    this.store.db
      .prepare('INSERT INTO external_assignments VALUES (?,?,?)')
      .run(id, canonical(runtime), digest(runtime));
  }
  assignment(id: string): ExternalRuntime | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM external_assignments WHERE assignment_id=?')
      .get(id);
    if (!row) return;
    const runtime = JSON.parse(String(row.runtime)) as ExternalRuntime;
    if (digest(runtime) !== row.digest)
      throw new ServiceError('worker_binding_changed', 'External assignment changed');
    return runtime;
  }
  validateAssignment(id: string, task: WorkTask): void {
    const runtime = this.assignment(id);
    if (!runtime) return;
    this.policy(task);
    if (!this.backend)
      throw new ServiceError('runtime_unavailable', 'Runtime configuration is unavailable');
    this.backend.validate(runtime);
  }
  row(child: string): Record<string, any> {
    const row = this.store.db.prepare('SELECT * FROM external_runs WHERE child_id=?').get(child);
    if (!row) throw new ServiceError('not_found', 'External worker not found', 404);
    return row;
  }
  stopped(child: string): boolean {
    return this.row(child).stopped === 1;
  }
  owns(session: string): boolean {
    if ([...this.owned.values()].some((r) => r.child.child_session === session)) return true;
    const child = this.children.owned(session);
    return !!child && !!this.store.workerBoundary.view(child.id).binding.external;
  }
  failControl(session: string, error: Error): void {
    const child =
      [...this.owned.values()].find((r) => r.child.child_session === session)?.child ??
      this.children.owned(session);
    if (!child) return;
    this.failed.add(child.id);
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE external_runs SET state='unknown',error=? WHERE child_id=?")
          .run(error.message, child.id);
        this.store.db
          .prepare("UPDATE sessions SET state='unhealthy',capabilities='[]',error=? WHERE id=?")
          .run(error.message, session);
        this.store.event(child.parent_session, 'external.control_failed', {
          child_id: child.id,
          error: error.message,
        });
      });
    } finally {
      void this.cancel(child).catch(() => {});
    }
  }
  failAll(error: Error): void {
    this.paused = true;
    for (const { child } of this.owned.values()) {
      this.failed.add(child.id);
      try {
        this.failControl(child.child_session, error);
      } catch {}
    }
  }
  private binding(child: ChildTask): WorkerBinding {
    const v = this.store.workerBoundary.view(child.id),
      b = v.binding;
    if (
      !b.external ||
      !b.assignment ||
      !b.agent ||
      !b.isolation ||
      !b.repository ||
      b.schema_version !== 1 ||
      child.budget !== 1 ||
      b.agent.owner_session !== child.parent_session ||
      !b.input_artifact ||
      b.runtime !== b.external.kind ||
      digest(b) !== v.binding_digest ||
      b.capability_digest !== digest(b.capabilities) ||
      b.capability_digest !== digest(externalCapabilities(b.external, b.tools)) ||
      b.bounds.scope !== 'invocations' ||
      b.bounds.invocations !== 1 ||
      b.owner_session !== child.parent_session ||
      b.session_id !== child.child_session ||
      b.attempt_id !== child.child_attempt ||
      b.input_digest !== child.input_digest ||
      b.parent_attempt !== child.parent_attempt ||
      b.step_key !== child.step_key ||
      canonical(b.tools) !== child.authority ||
      digest(this.assignment(b.assignment.id)) !== digest(b.external) ||
      b.policy_digest !== POLICY_DIGEST ||
      b.profile_digest !== digest(b.profile) ||
      b.agent.profile_digest !== b.profile_digest ||
      b.route !== null
    )
      throw new ServiceError(
        'worker_binding_changed',
        'External worker ownership or admission changed',
      );
    const task = this.budget.task(child.parent_session);
    const input = this.store.db
      .prepare('SELECT text FROM submissions WHERE attempt_id=?')
      .get(child.child_attempt);
    if (!input || this.artifacts.read(b.input_artifact!) !== input.text)
      throw new ServiceError('worker_binding_changed', 'External prompt artifact changed');
    if (
      !task ||
      task.id !== b.owner_task ||
      ['cancelled', 'succeeded', 'succeeded_with_exception'].includes(task.state)
    )
      throw new ServiceError('task_settled', 'External task no longer admits work');
    this.policy(task);
    this.store.workerBoundary.profiles!.validate(b.agent);
    this.store.workerBoundary.assertAssignment!(b);
    this.store.workerBoundary.assertIsolation!(b);
    this.backend?.validate(b.external);
    if (!this.backend)
      throw new ServiceError('runtime_unavailable', 'Runtime configuration is unavailable');
    this.budget.check(child.parent_session);
    return b;
  }
  prepare(child: ChildTask): void {
    // Called inside the same transaction as child ownership and the task-step claim.
    const b = this.store.workerBoundary.view(child.id).binding,
      task = this.budget.task(child.parent_session)!;
    this.policy(task);
    const spent = Number(
      this.store.db
        .prepare('SELECT count(*) AS n FROM task_invocations WHERE task_id=?')
        .get(task.id)!.n,
    );
    if (spent >= task.limits.invocations!)
      throw new ServiceError('invocation_budget_exhausted', 'Task invocation allowance exhausted');
    this.store.db
      .prepare('INSERT INTO task_invocations VALUES (?,?,?,?,?)')
      .run(child.child_attempt, task.id, b.external!.id, child.input_digest, Date.now());
    this.store.db
      .prepare("INSERT INTO external_runs(child_id,run_id,state,epoch) VALUES (?,?,'prepared',1)")
      .run(child.id, randomUUID());
    this.store.event(child.parent_session, 'external.invocation_admitted', {
      child_id: child.id,
      runtime: b.external,
      usage: 'unknown',
      invocations_spent: spent + 1,
    });
  }
  assertActive(session: string, epoch: number, attempt: string): void {
    this.store.execution.assert(session);
    const child = this.children.owned(session);
    if (!child || child.child_attempt !== attempt || this.paused || this.failed.has(child.id))
      throw new ServiceError('invocation_inactive', 'External invocation is inactive');
    const row = this.row(child.id);
    const worker = this.store.workerBoundary.view(child.id);
    const cp = row.checkpoint ? (JSON.parse(row.checkpoint) as ExternalCheckpoint) : null;
    if (
      row.epoch !== epoch ||
      this.store.session(session).epoch !== epoch ||
      worker.worker_epoch !== epoch ||
      worker.generation !== 1 ||
      row.stopped ||
      !['starting', 'running'].includes(row.state) ||
      child.state !== 'accepted' ||
      this.store.cancelled(attempt) ||
      (cp && ['terminal', 'unknown'].includes(cp.state))
    )
      throw new ServiceError('invocation_inactive', 'External invocation lost authority');
    this.binding(child);
  }
  async start(child: ChildTask): Promise<void> {
    this.store.execution.assert(child.child_session);
    const row = this.row(child.id);
    if (row.state !== 'prepared' || this.paused) return;
    const b = this.binding(child),
      before = readTree(this.workspaces.get(child.child_session).root);
    this.store.transaction(() => {
      if (this.row(child.id).state !== 'prepared')
        throw new ServiceError('harness_replay', 'Invocation has already crossed dispatch intent');
      this.store.db
        .prepare("UPDATE external_runs SET state='starting' WHERE child_id=?")
        .run(child.id);
      this.store.db
        .prepare(
          "UPDATE child_workers SET generation=1,worker_epoch=1,dispatch_state='dispatching' WHERE child_id=?",
        )
        .run(child.id);
      this.store.db
        .prepare("UPDATE sessions SET epoch=1,state='ready',capabilities='[]' WHERE id=?")
        .run(child.child_session);
      this.store.db
        .prepare("UPDATE attempts SET state='dispatching',worker_epoch=1 WHERE id=?")
        .run(child.child_attempt);
      this.store.projectTaskAttempt?.(this.store.attempt(child.child_attempt));
      this.store.event(child.parent_session, 'external.dispatch_intent', {
        child_id: child.id,
        run_id: row.run_id,
      });
    });
    this.owned.set(child.id, { child, run: String(row.run_id), runtime: b.external! });
    const operations = new Map<string, string>();
    let result: unknown, failure: unknown;
    const running = (async () => {
      try {
        const prompt = String(
          this.store.db
            .prepare('SELECT text FROM submissions WHERE attempt_id=?')
            .get(child.child_attempt)!.text,
        );
        result = (
          await this.backend!.execute(b, String(row.run_id), prompt, before, {
            failed: (error) => this.failControl(child.child_session, error),
            modelRequest: (id, bytes, output) => {
              this.assertActive(child.child_session, 1, child.child_attempt);
              const current = this.row(child.id);
              const checkpoint = current.checkpoint
                ? (JSON.parse(current.checkpoint) as ExternalCheckpoint)
                : null;
              if (!checkpoint || !['dispatching', 'running'].includes(checkpoint.state))
                throw new ServiceError(
                  'invocation_inactive',
                  'No durable prompt dispatch admits a model request',
                );
              if (
                !Number.isSafeInteger(bytes) ||
                bytes < 0 ||
                bytes > 2 * 1024 * 1024 ||
                !Number.isSafeInteger(output) ||
                output < 1
              )
                throw new ServiceError('invalid_budget', 'Invalid external gateway bounds');
              this.store.transaction(() => {
                const n = Number(
                  this.store.db
                    .prepare('SELECT count(*) AS n FROM external_model_requests WHERE child_id=?')
                    .get(child.id)!.n,
                );
                if (
                  !b.external!.max_model_requests ||
                  n >= b.external!.max_model_requests ||
                  !b.external!.output_cap ||
                  output > b.external!.output_cap
                )
                  throw Error('Frozen harness model gateway allowance exhausted');
                this.admitModelRequest?.(child.child_session, child.child_attempt, bytes, output);
                this.store.db
                  .prepare('INSERT INTO external_model_requests VALUES (?,?,?,?)')
                  .run(id, child.id, bytes, output);
                this.store.event(child.parent_session, 'external.model_request_admitted', {
                  child_id: child.id,
                  id,
                  bytes,
                  output,
                });
              });
            },
            assertActive: () => this.assertActive(child.child_session, 1, child.child_attempt),
            receipt: (value) => {
              this.save(child, 'receipt', value);
              return undefined;
            },
            checkpoint: (cp) => {
              if (cp.worker_id !== b.worker_id || cp.attempt_id !== b.attempt_id)
                throw new ServiceError('harness_identity', 'Checkpoint belongs to another worker');
              if (cp.dialect === 'a2a' && cp.run_id !== row.run_id)
                throw Error('Peer checkpoint belongs to another run');
              this.save(child, 'checkpoint', cp);
              return undefined;
            },
            permission: async (method, params) => {
              this.assertActive(child.child_session, 1, child.child_attempt);
              const current = this.row(child.id);
              if (
                !current.checkpoint ||
                !['dispatching', 'running'].includes(JSON.parse(current.checkpoint).state)
              )
                return 'deny';
              const scope = params.scope as
                { id?: unknown; kind?: unknown; arguments?: unknown } | undefined;
              if (
                !scope ||
                typeof scope.id !== 'string' ||
                !['write', 'command'].includes(String(scope.kind)) ||
                !b.tools.includes(scope.kind === 'write' ? 'salaam_files' : 'salaam_command') ||
                canonical(params).length > 16384
              )
                return 'deny';
              const prepared = await this.managed.prepare(
                child.child_session,
                1,
                child.child_attempt,
                scope.id,
                'harness',
                canonical({ runtime: b.external!.id, method, scope }),
                canonical(params),
              );
              operations.set(scope.id, prepared.operation.id);
              for (;;) {
                try {
                  this.assertActive(child.child_session, 1, child.child_attempt);
                } catch {
                  return 'deny';
                }
                const approval = this.managed.approval(prepared.approval.id);
                if (approval.state !== 'pending')
                  return this.managed.takePermission(prepared.operation.id) ? 'approve' : 'deny';
                await new Promise((r) => setTimeout(r, 25));
              }
            },
            toolResult: (id, success, receipt) => {
              const op = operations.get(id);
              if (op) this.managed.permissionResult(op, success, receipt);
            },
          })
        ).result;
      } catch (error) {
        failure = error;
      }
      try {
        let receipt: unknown = null;
        try {
          receipt = this.cleanupReceipt(child, b.external!);
        } catch (error) {
          failure ??= error;
        }
        const stopped = await this.backend!.stop(String(row.run_id), b.external!, receipt);
        this.recordStop(child, String(row.run_id), b.external!, stopped);
      } catch (error) {
        failure = error;
      }
      try {
        if (this.failed.has(child.id)) failure ??= Error('Required external worker control failed');
        if (!failure && !this.store.cancelled(child.child_attempt)) {
          const cp = JSON.parse(String(this.row(child.id).checkpoint)) as ExternalCheckpoint;
          if (!this.stopped(child.id) || cp.state !== 'terminal')
            throw Error('No confirmed terminal invocation');
          const after = this.backend!.collect(String(row.run_id), b.external!);
          validateTree(after);
          if (!b.tools.includes('salaam_files') && digest(after) !== digest(before))
            throw Error('Read-only worker changed its draft');
          const artifact = this.artifacts.prepare(child.child_session, canonical(after));
          this.store.transaction(() => {
            artifact.commit();
            this.store.db
              .prepare('UPDATE external_runs SET result=?,import_artifact=? WHERE child_id=?')
              .run(canonical(result), artifact.id, child.id);
            this.store.event(child.parent_session, 'external.import_prepared', {
              child_id: child.id,
              artifact_id: artifact.id,
              digest: digest(after),
            });
          });
          const w = this.workspaces.verify(child.child_session);
          this.workspaces.replace(
            child.child_session,
            'external-import:' + row.run_id,
            digest(after),
            w.revision,
            before,
            after,
          );
        }
      } catch (error) {
        failure = error;
      }
      this.managed.invalidateWorker(child.child_session, 1);
      this.store.transaction(() => {
        const state =
          this.store.cancelled(child.child_attempt) && this.stopped(child.id)
            ? 'cancelled'
            : failure
              ? 'interrupted'
              : 'completed';
        this.store.db
          .prepare('UPDATE external_runs SET state=?,error=? WHERE child_id=?')
          .run(
            state === 'completed' ? 'terminal' : 'unknown',
            failure ? String(failure).slice(0, 4096) : null,
            child.id,
          );
        this.store.db
          .prepare('UPDATE sessions SET state=?,error=? WHERE id=?')
          .run(
            this.stopped(child.id) ? 'exited' : 'unhealthy',
            failure ? String(failure).slice(0, 4096) : null,
            child.child_session,
          );
        this.store.event(child.parent_session, 'external.settled', {
          child_id: child.id,
          state,
          stopped: this.stopped(child.id),
          verified_success: false,
        });
      });
      this.store.finish(
        child.child_attempt,
        this.store.cancelled(child.child_attempt) && this.stopped(child.id)
          ? 'cancelled'
          : failure
            ? 'interrupted'
            : 'completed',
        failure ? null : canonical({ runtime: b.external!.id, result, verified_success: false }),
        failure ? String(failure).slice(0, 4096) : null,
      );
    })();
    this.active.set(child.id, running);
    try {
      await running;
    } finally {
      this.active.delete(child.id);
      this.owned.delete(child.id);
    }
  }
  private save(child: ChildTask, field: 'checkpoint' | 'receipt', value: unknown): void {
    const bytes = canonical(value);
    if (bytes.length > 1048576) throw Error('External checkpoint exceeds bound');
    this.store.transaction(() => {
      if (
        field === 'checkpoint' &&
        ['dispatching', 'running'].includes((value as ExternalCheckpoint).state)
      ) {
        this.store.db
          .prepare("UPDATE external_runs SET state='running' WHERE child_id=?")
          .run(child.id);
        this.store.db
          .prepare("UPDATE child_workers SET dispatch_state='accepted' WHERE child_id=?")
          .run(child.id);
        this.store.db
          .prepare("UPDATE attempts SET state='running' WHERE id=?")
          .run(child.child_attempt);
      }
      this.store.db
        .prepare(`UPDATE external_runs SET ${field}=? WHERE child_id=?`)
        .run(bytes, child.id);
      this.store.event(child.parent_session, 'external.' + field, {
        child_id: child.id,
        digest: digest(value),
      });
    });
  }
  async cancel(child: ChildTask): Promise<void> {
    const cached = this.owned.get(child.id);
    const runtime = cached?.runtime ?? this.store.workerBoundary.view(child.id).binding.external;
    const run = cached?.run ?? String(this.row(child.id).run_id);
    let failure: unknown;
    try {
      this.managed.invalidateWorker(child.child_session, 1);
    } catch (error) {
      failure = error;
    }
    if (this.backend && runtime) {
      let receipt: unknown = null;
      try {
        receipt = this.cleanupReceipt(child, runtime);
      } catch (error) {
        failure ??= error;
      }
      const stopped = await this.backend.stop(run, runtime, receipt);
      this.recordStop(child, run, runtime, stopped);
    }
    if (failure) throw failure;
  }
  private cleanupReceipt(child: ChildTask, runtime: ExternalRuntime): unknown {
    const row = this.row(child.id);
    if (runtime.kind === 'a2a' && row.checkpoint) {
      const cp = JSON.parse(row.checkpoint),
        b = this.store.workerBoundary.view(child.id).binding;
      if (
        cp.dialect !== 'a2a' ||
        cp.worker_id !== b.worker_id ||
        cp.attempt_id !== child.child_attempt ||
        cp.run_id !== row.run_id
      )
        throw Error('Peer cleanup identity changed');
      return cp;
    }
    return row.receipt ? JSON.parse(row.receipt) : null;
  }
  private recordStop(
    child: ChildTask,
    run: string,
    runtime: ExternalRuntime,
    evidence: unknown,
  ): void {
    const bytes = evidence === undefined ? null : canonical(evidence);
    if (bytes && bytes.length > 1048576) throw Error('Stop receipt exceeds bound');
    const cp =
      runtime.kind === 'a2a'
        ? (evidence as { checkpoint?: import('../a2a/protocol.js').A2ACheckpoint } | undefined)
            ?.checkpoint
        : undefined;
    if (cp) {
      const b = this.store.workerBoundary.view(child.id).binding;
      if (
        cp.worker_id !== b.worker_id ||
        cp.attempt_id !== child.child_attempt ||
        cp.run_id !== run
      )
        throw Error('Stop receipt belongs to another worker');
    }
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'UPDATE external_runs SET stopped=1,receipt=coalesce(?,receipt),checkpoint=coalesce(?,checkpoint) WHERE child_id=? AND run_id=?',
        )
        .run(bytes, cp ? canonical(cp) : null, child.id, run);
      this.store.event(child.parent_session, 'external.stop_confirmed', {
        child_id: child.id,
        run_id: run,
        scope:
          runtime.kind === 'a2a'
            ? ((evidence as { scope?: string } | undefined)?.scope ?? 'remote-terminal-receipt')
            : 'owned-processes',
        evidence_digest: bytes ? digest(evidence) : null,
      });
    });
  }
  async recover(): Promise<void> {
    for (const r of this.store.db.prepare('SELECT * FROM external_runs WHERE stopped=0').all()) {
      const child = this.store.db
        .prepare('SELECT * FROM child_tasks WHERE id=?')
        .get(r.child_id!) as unknown as ChildTask;
      let error = 'Daemon restart interrupted external work; prompt will not be replayed';
      try {
        await this.cancel(child);
      } catch (e) {
        error = String(e);
      }
      this.store.transaction(() => {
        this.store.db
          .prepare("UPDATE external_runs SET state='unknown',error=? WHERE child_id=?")
          .run(error, child.id);
        this.store.event(child.parent_session, 'external.recovered_unknown', {
          child_id: child.id,
          stopped: this.stopped(child.id),
          error,
        });
      });
    }
  }
  async cancelRoot(session: string): Promise<void> {
    for (const child of this.children.list(session))
      if (child.worker?.binding.external && !this.stopped(child.id)) await this.cancel(child);
  }
  async reconcile(
    child: ChildTask,
    request: string,
    runId: string,
    authorize: () => void,
  ): Promise<unknown> {
    let fresh = false;
    this.store.request(
      'local-operator',
      request,
      { kind: 'external-reconcile', child: child.id, runId },
      () => {
        authorize();
        const row = this.row(child.id);
        if (row.run_id !== runId || row.state !== 'unknown' || this.active.has(child.id))
          throw new ServiceError(
            'external_reconcile_stale',
            'Reconcile an inactive uncertain run with its exact identity',
          );
        this.store.event(child.parent_session, 'external.reconcile_intent', {
          child_id: child.id,
          run_id: runId,
        });
        fresh = true;
        return { child_id: child.id, run_id: runId };
      },
    );
    if (fresh) await this.cancel(child);
    return this.view(child.id);
  }
  view(child: string): unknown {
    const r = this.row(child);
    return {
      ...r,
      checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
      receipt: r.receipt ? JSON.parse(r.receipt) : null,
      result: r.result ? JSON.parse(r.result) : null,
      verified_success: false,
    };
  }
  async close(): Promise<void> {
    this.paused = true;
    for (const id of this.active.keys()) {
      const child =
        this.owned.get(id)?.child ??
        (this.store.db
          .prepare('SELECT * FROM child_tasks WHERE id=?')
          .get(id) as unknown as ChildTask);
      try {
        await this.cancel(child);
      } catch {}
    }
    await Promise.allSettled(this.active.values());
    await this.backend?.close?.();
  }
}
