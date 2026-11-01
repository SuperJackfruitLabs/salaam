import { randomUUID } from 'node:crypto';
import type { Store, Artifacts } from '../store/index.js';
import { readTree, type Workspaces } from '../coding/index.js';
import type { WorkspaceTree, WorkerBinding } from '../core/index.js';
import { repositoryPath, type RepositorySnapshots } from './repository-snapshots.js';
import { canonical, digest, ServiceError, type ChildTask } from '../core/index.js';
import type { CodingWork } from '../coding/index.js';
import { workspaceDiff } from './workspace-diff.js';

/** The child ledger members a draft workspace checks. Child dispatch implements it. */
export interface DraftChildren {
  inspect(parent: string, id: string): ChildTask;
  external?: { stopped(child: string): boolean };
}
/** Drafts are private owned copies. Integration reuses the hash-bound workspace journal. */
export class WorkerWorkspaces {
  constructor(
    readonly store: Store,
    readonly workspaces: Workspaces,
    readonly repositories: RepositorySnapshots,
    readonly artifacts: Artifacts,
    readonly coding: CodingWork,
    readonly children: DraftChildren,
  ) {}
  execution(): { profile_digest: string; engine_id: string; evidence: 'proven' | 'fixture' } {
    const executor = this.coding.executor;
    if (
      !executor?.profileDigest ||
      !executor.engineId ||
      (executor.evidence.probe !== 'passed' && executor.evidence.fixture !== true)
    )
      throw new ServiceError(
        'executor_unavailable',
        'Writing specialists require a configured execution boundary',
      );
    return {
      profile_digest: executor.profileDigest,
      engine_id: executor.engineId,
      evidence: executor.evidence.fixture === true ? 'fixture' : 'proven',
    };
  }
  prepare(
    session: string,
    repository: NonNullable<WorkerBinding['repository']>,
  ): {
    workspace_id: string;
    baseline_artifact: string;
    digest: string;
    execution: ReturnType<WorkerWorkspaces['execution']>;
  } {
    const execution = this.execution();
    const tree = JSON.parse(this.artifacts.read(repository.artifact_id)) as WorkspaceTree;
    if (digest(tree) !== repository.digest)
      throw new ServiceError('artifact_corrupt', 'Worker baseline digest changed');
    const workspace = this.workspaces.cloneSnapshot(session, tree);
    return {
      workspace_id: workspace.id,
      baseline_artifact: repository.artifact_id,
      digest: repository.digest,
      execution,
    };
  }
  assert(binding: WorkerBinding): void {
    const scope = binding.isolation;
    if (!scope || canonical(scope.execution) !== canonical(this.execution()))
      throw new ServiceError('worker_binding_changed', 'Worker execution environment changed');
    const workspace = this.workspaces.get(binding.session_id);
    if (
      workspace.id !== scope.workspace_id ||
      scope.digest !== binding.repository?.digest ||
      scope.baseline_artifact !== binding.repository?.artifact_id
    )
      throw new ServiceError('worker_binding_changed', 'Worker workspace ownership changed');
    this.coding.assertSafe(binding.session_id);
  }
  private settled(parent: string, id: string, complete = true) {
    const child = this.children.inspect(parent, id),
      binding = child.worker!.binding;
    if (
      !binding.isolation ||
      (binding.external && !this.children.external?.stopped(child.id)) ||
      (complete ? child.state !== 'completed' : child.state === 'accepted') ||
      this.store.db
        .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
        .get(child.child_session) ||
      this.store.db
        .prepare(
          "SELECT 1 FROM command_runs WHERE session_id=? AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
        )
        .get(child.child_session)
    )
      throw new ServiceError(
        'worker_not_settled',
        'Wait for the owned worker and commands to stop before inspecting its proposal',
      );
    this.assert(binding);
    return { child, binding };
  }
  proposal(parent: string, id: string, offset?: number): unknown {
    const { child, binding } = this.settled(parent, id, false);
    const workspace = this.workspaces.verify(child.child_session),
      baseline = this.repositories.tree(binding),
      current = readTree(workspace.root);
    if (digest(current) !== workspace.digest)
      throw new ServiceError('workspace_changed', 'Worker draft changed during inspection');
    const changes = [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
      .sort()
      .filter((path) => digest(baseline[path] ?? null) !== digest(current[path] ?? null))
      .map((path) => {
        repositoryPath(path);
        return { path, before: baseline[path] ?? null, after: current[path] ?? null };
      });
    const patch = {
      schema_version: 1,
      worker_id: binding.worker_id,
      child_id: id,
      worker_state: child.state,
      baseline_digest: binding.repository!.digest,
      draft_digest: workspace.digest,
      changes,
    };
    return {
      ...patch,
      changes: offset === undefined ? changes : changes.slice(offset, offset + 1),
      diff: (offset === undefined ? changes : changes.slice(offset, offset + 1)).map(workspaceDiff),
      next_offset: offset !== undefined && offset + 1 < changes.length ? offset + 1 : null,
      patch_digest: digest(patch),
      verified_success: false,
    };
  }
  integrate(
    parent: string,
    childId: string,
    request: string,
    revision: number,
    rootDigest: string,
    patchDigest: string,
    authorize: () => void,
  ): unknown {
    let fresh = false;
    const receipt = this.store.request(
      'local-operator',
      request,
      { kind: 'worker-integrate', parent, childId, revision, rootDigest, patchDigest },
      () => {
        authorize();
        const task = this.store.db
          .prepare('SELECT state FROM durable_tasks WHERE session_id=?')
          .get(parent);
        if (task?.state === 'cancelled')
          throw new ServiceError('task_settled', 'Task cancellation revoked integration authority');
        const { child, binding } = this.settled(parent, childId);
        this.assertRootIdle(parent);
        if (
          this.store.db.prepare('SELECT 1 FROM worker_integrations WHERE child_id=?').get(childId)
        )
          throw new ServiceError(
            'integration_exists',
            'This draft already has an integration intent; inspect its receipt',
          );
        const proposal = this.proposal(parent, childId) as {
          patch_digest: string;
          changes: {
            path: string;
            before: WorkspaceTree[string] | null;
            after: WorkspaceTree[string] | null;
          }[];
        };
        if (proposal.patch_digest !== patchDigest)
          throw new ServiceError('proposal_changed', 'Review the exact current worker proposal');
        if (
          this.store.db
            .prepare(
              "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
            )
            .get(parent)
        )
          throw new ServiceError('task_busy', 'Pause root work before integration');
        const workspace = this.workspaces.verify(parent);
        if (workspace.revision !== revision || workspace.digest !== rootDigest)
          throw new ServiceError('workspace_changed', 'Root workspace changed since review');
        const before = readTree(workspace.root),
          after: WorkspaceTree = { ...before };
        for (const change of proposal.changes) {
          if (digest(before[change.path] ?? null) !== digest(change.before))
            throw new ServiceError(
              'integration_conflict',
              'Root and worker both changed ' + change.path,
            );
          if (change.after) after[change.path] = change.after;
          else delete after[change.path];
        }
        const artifact = this.artifacts.prepare(parent, JSON.stringify(after));
        artifact.commit();
        const id = randomUUID();
        this.store.db
          .prepare("INSERT INTO worker_integrations VALUES (?,?,?,?,?,?,?,?,'prepared',NULL,?,1)")
          .run(
            id,
            parent,
            child.id,
            binding.worker_id,
            patchDigest,
            workspace.revision,
            workspace.digest,
            artifact.id,
            'worker-integration:' + id,
          );
        this.store.event(parent, 'worker.integration_prepared', {
          integration_id: id,
          child_id: childId,
          patch_digest: patchDigest,
          before_digest: workspace.digest,
          after_digest: digest(after),
        });
        fresh = true;
        return { id };
      },
    );
    if (fresh) this.apply(receipt.id, authorize);
    return this.inspect(receipt.id);
  }
  private apply(id: string, authorize: () => void): void {
    const row = this.row(id),
      parent = String(row.parent_session),
      workspace = this.workspaces.verify(parent),
      before = readTree(workspace.root),
      after = JSON.parse(this.artifacts.read(String(row.after_artifact))) as WorkspaceTree;
    authorize();
    this.assertRootIdle(parent);
    if (workspace.revision !== row.before_revision || digest(before) !== row.before_digest)
      throw new ServiceError(
        'workspace_changed',
        'Root changed after integration intent; no overwrite was performed',
      );
    this.workspaces.replace(
      parent,
      String(row.mutation_key),
      String(row.patch_digest),
      Number(row.before_revision),
      before,
      after,
    );
    this.reconcile(id);
  }
  resolve(
    id: string,
    request: string,
    revision: number,
    rootDigest: string,
    authorize: () => void,
  ): unknown {
    let fresh = false;
    this.store.request(
      'local-operator',
      request,
      { kind: 'integration-resolve', id, revision, rootDigest },
      () => {
        authorize();
        const row = this.row(id),
          parent = String(row.parent_session),
          workspace = this.workspaces.verify(parent);
        this.assertRootIdle(parent);
        const task = this.store.db
          .prepare('SELECT state FROM durable_tasks WHERE session_id=?')
          .get(parent);
        if (task?.state === 'cancelled')
          throw new ServiceError('task_settled', 'Task cancellation revoked integration authority');
        if (
          !['prepared', 'needs_resolution'].includes(String(row.state)) ||
          Number(row.generation) >= 8
        )
          throw new ServiceError(
            'integration_settled',
            'Integration is applied or its resolution limit was reached',
          );
        if (
          workspace.revision !== revision ||
          workspace.digest !== rootDigest ||
          revision !== row.before_revision ||
          rootDigest !== row.before_digest
        )
          throw new ServiceError(
            'workspace_changed',
            'Resolution requires the exact unchanged pre-integration root',
          );
        const mutation = this.store.db
          .prepare('SELECT state FROM workspace_mutations WHERE workspace_id=? AND request_key=?')
          .get(workspace.id, String(row.mutation_key));
        if (mutation && mutation.state !== 'failed_definite')
          throw new ServiceError(
            'integration_uncertain',
            'Reconcile the existing workspace mutation before a new apply',
          );
        const generation = Number(row.generation) + 1,
          key = 'worker-integration:' + id + ':' + generation;
        this.store.db
          .prepare(
            "UPDATE worker_integrations SET state='prepared',mutation_id=NULL,mutation_key=?,generation=? WHERE id=?",
          )
          .run(key, generation, id);
        this.store.event(parent, 'worker.integration_resolution_admitted', {
          integration_id: id,
          generation,
          mutation_key: key,
          request_id: request,
        });
        fresh = true;
        return { id };
      },
    );
    if (fresh) this.apply(id, authorize);
    return this.inspect(id);
  }
  owner(id: string): string {
    return String(this.row(id).parent_session);
  }
  private assertRootIdle(parent: string): void {
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
        )
        .get(parent) ||
      this.store.db
        .prepare("SELECT 1 FROM compactions WHERE session_id=? AND state='running'")
        .get(parent)
    )
      throw new ServiceError('task_busy', 'Pause root work before integration');
  }
  private row(id: string) {
    const row = this.store.db.prepare('SELECT * FROM worker_integrations WHERE id=?').get(id);
    if (!row) throw new ServiceError('not_found', 'Integration receipt not found', 404);
    return row;
  }
  inspect(id: string): unknown {
    const row = this.row(id),
      workspace = this.workspaces.get(String(row.parent_session)),
      after = JSON.parse(this.artifacts.read(String(row.after_artifact))) as WorkspaceTree;
    let current = false;
    try {
      current =
        row.state === 'applied' &&
        this.workspaces.verify(String(row.parent_session)).digest === digest(after);
    } catch {}
    return { ...row, after_digest: digest(after), current, verified_success: false };
  }
  reconcile(id: string): void {
    const row = this.row(id);
    if (row.state === 'applied') return;
    const workspace = this.workspaces.get(String(row.parent_session)),
      after = JSON.parse(this.artifacts.read(String(row.after_artifact))) as WorkspaceTree;
    const mutation = this.store.db
      .prepare('SELECT * FROM workspace_mutations WHERE workspace_id=? AND request_key=?')
      .get(workspace.id, String(row.mutation_key));
    const applied = mutation?.state === 'applied' && mutation.after_digest === digest(after);
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE worker_integrations SET state=?,mutation_id=? WHERE id=?')
        .run(applied ? 'applied' : 'needs_resolution', mutation ? String(mutation.id) : null, id);
      this.store.event(String(row.parent_session), 'worker.integration_reconciled', {
        integration_id: id,
        state: applied ? 'applied' : 'needs_resolution',
        mutation_id: mutation?.id ?? null,
      });
    });
  }
  recover(): void {
    for (const row of this.store.db
      .prepare("SELECT id FROM worker_integrations WHERE state='prepared'")
      .all())
      this.reconcile(String(row.id));
  }
  assertStepReview(task: string, step: string): void {
    const row = this.store.db
      .prepare(
        'SELECT c.id,b.binding FROM task_steps s JOIN child_tasks c ON c.child_attempt=s.attempt_id JOIN child_workers b ON b.child_id=c.id WHERE s.task_id=? AND s.id=?',
      )
      .get(task, step);
    if (!row) return;
    const binding = JSON.parse(String(row.binding)) as WorkerBinding;
    if (!binding.tools.includes('salaam_files')) return;
    if (
      !this.store.db
        .prepare("SELECT 1 FROM worker_integrations WHERE child_id=? AND state='applied'")
        .get(String(row.id))
    )
      throw new ServiceError(
        'integration_required',
        'Integrate the exact writing-worker proposal before step verification or completion',
      );
  }
}
