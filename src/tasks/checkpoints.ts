import { randomUUID } from 'node:crypto';
import type { Store, Artifacts } from '../store/index.js';
import type { TaskWork } from './work.js';
import type { TaskVerification } from './verification.js';
import { readTree, type Workspaces } from '../coding/index.js';
import type { WorkspaceTree } from '../core/index.js';
import { canonical, digest, ServiceError } from '../core/index.js';

interface Checkpoint {
  id: string;
  task_id: string;
  workspace_id: string;
  revision: number;
  digest: string;
  tree_artifact: string;
  mutation_cursor: number;
}
interface Restore {
  id: string;
  task_id: string;
  checkpoint_id: string;
  before_artifact: string;
  after_artifact: string;
  expected_revision: number;
  expected_digest: string;
  mutation_id: string | null;
  state: string;
  conflicts: string;
}
interface Change {
  path: string;
  before: WorkspaceTree[string] | null;
  after: WorkspaceTree[string] | null;
}
export class TaskCheckpoints {
  constructor(
    readonly store: Store,
    readonly tasks: TaskWork,
    readonly verification: TaskVerification,
    readonly workspaces: Workspaces,
    readonly artifacts: Artifacts,
  ) {
    store.recordTaskMutation = (session, mutation, before, after) =>
      this.record(session, mutation, before, after);
  }
  private record(
    session: string,
    mutation: string,
    before: WorkspaceTree,
    after: WorkspaceTree,
  ): void {
    const task = this.tasks.forSession(session);
    if (!task) return;
    if (
      !this.store.db
        .prepare(
          "SELECT 1 FROM task_step_attempts b JOIN attempts a ON a.id=b.attempt_id JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=? AND a.state IN ('dispatching','running')",
        )
        .get(task.id)
    )
      return;
    const changes: Change[] = Object.keys({ ...before, ...after })
      .sort()
      .filter((path) => digest(before[path] ?? null) !== digest(after[path] ?? null))
      .map((path) => ({ path, before: before[path] ?? null, after: after[path] ?? null }));
    const artifact = this.artifacts.prepare(session, canonical(changes));
    artifact.commit();
    this.store.db
      .prepare('INSERT INTO task_mutations VALUES (?,?,?)')
      .run(mutation, task.id, artifact.id);
  }
  list(task: string): Checkpoint[] {
    return this.store.db
      .prepare('SELECT * FROM task_checkpoints WHERE task_id=? ORDER BY rowid DESC LIMIT 32')
      .all(task) as unknown as Checkpoint[];
  }
  restores(task: string): unknown[] {
    return this.store.db
      .prepare('SELECT * FROM task_restores WHERE task_id=? ORDER BY rowid DESC LIMIT 32')
      .all(task)
      .map((r) => ({ ...r, conflicts: JSON.parse(String(r.conflicts)) }));
  }
  capture(id: string, request: string, expected: number, authorize: () => void): Checkpoint {
    const saved = this.store.request(
      'local-operator',
      request,
      { kind: 'task-checkpoint', id, expected },
      () => {
        authorize();
        const task = this.tasks.get(id);
        if (task.revision !== expected)
          throw new ServiceError('task_revision_conflict', 'Task revision changed');
        this.verification.assertIdle(task);
        const w = this.workspaces.verify(task.session_id),
          tree = readTree(w.root);
        if (digest(tree) !== w.digest)
          throw new ServiceError('workspace_changed', 'Workspace changed during checkpoint');
        const artifact = this.artifacts.prepare(task.session_id, canonical(tree)),
          checkpoint = randomUUID();
        artifact.commit();
        const cursor = Number(
          this.store.db
            .prepare('SELECT coalesce(max(rowid),0) n FROM task_mutations WHERE task_id=?')
            .get(id)!.n,
        );
        this.store.db
          .prepare('INSERT INTO task_checkpoints VALUES (?,?,?,?,?,?,?)')
          .run(checkpoint, id, w.id, w.revision, w.digest, artifact.id, cursor);
        this.store.event(task.session_id, 'work_task.checkpoint_created', {
          task_id: id,
          checkpoint_id: checkpoint,
          workspace_revision: w.revision,
          workspace_digest: w.digest,
        });
        return { id: checkpoint };
      },
    );
    return this.get(saved.id);
  }
  get(id: string): Checkpoint {
    const row = this.store.db
      .prepare('SELECT * FROM task_checkpoints WHERE id=?')
      .get(id) as unknown as Checkpoint | undefined;
    if (!row) throw new ServiceError('not_found', 'Task checkpoint not found', 404);
    return row;
  }
  restore(
    id: string,
    checkpointId: string,
    request: string,
    expected: number,
    revision: number,
    reviewed: string,
    authorize: () => void,
  ): unknown {
    const saved = this.store.request(
      'local-operator',
      request,
      { kind: 'task-restore', id, checkpointId, expected, revision, reviewed },
      () => {
        authorize();
        const task = this.tasks.get(id);
        if (task.revision !== expected)
          throw new ServiceError('task_revision_conflict', 'Task revision changed');
        this.verification.assertIdle(task);
        const checkpoint = this.get(checkpointId),
          w = this.workspaces.get(task.session_id);
        if (checkpoint.task_id !== id || checkpoint.workspace_id !== w.id)
          throw new ServiceError(
            'invalid_checkpoint',
            'Checkpoint does not belong to this task workspace',
          );
        if (w.revision !== revision || w.state !== 'ready')
          throw new ServiceError('workspace_changed', 'Reviewed workspace revision changed');
        const before = readTree(w.root);
        if (digest(before) !== reviewed)
          throw new ServiceError('workspace_changed', 'Reviewed workspace content changed');
        const baseline: WorkspaceTree = JSON.parse(this.artifacts.read(checkpoint.tree_artifact));
        const after: WorkspaceTree = Object.assign(Object.create(null), before),
          owned = new Map<string, WorkspaceTree[string] | null>(),
          conflicts = new Set<string>();
        const rows = this.store.db
          .prepare(
            "SELECT t.change_artifact FROM task_mutations t JOIN workspace_mutations m ON m.id=t.mutation_id WHERE t.task_id=? AND t.rowid>? AND m.state='applied' ORDER BY t.rowid",
          )
          .all(id, checkpoint.mutation_cursor);
        for (const row of rows)
          for (const change of JSON.parse(
            this.artifacts.read(String(row.change_artifact)),
          ) as Change[]) {
            const prior = owned.has(change.path)
              ? owned.get(change.path)
              : (baseline[change.path] ?? null);
            if (digest(prior) !== digest(change.before)) conflicts.add(change.path);
            owned.set(change.path, change.after);
          }
        for (const [path, last] of owned) {
          if (digest(before[path] ?? null) !== digest(last)) conflicts.add(path);
          if (conflicts.has(path)) continue;
          if (baseline[path]) after[path] = baseline[path]!;
          else delete after[path];
        }
        const beforeArtifact = this.artifacts.prepare(task.session_id, canonical(before)),
          afterArtifact = this.artifacts.prepare(task.session_id, canonical(after)),
          restore = randomUUID();
        beforeArtifact.commit();
        afterArtifact.commit();
        this.store.db
          .prepare("INSERT INTO task_restores VALUES (?,?,?,?,?,?,?,NULL,'prepared',?)")
          .run(
            restore,
            id,
            checkpointId,
            beforeArtifact.id,
            afterArtifact.id,
            revision,
            reviewed,
            canonical([...conflicts].sort()),
          );
        this.store.db.prepare('UPDATE task_runtime SET auto_enabled=0 WHERE task_id=?').run(id);
        this.store.db
          .prepare(
            "UPDATE durable_tasks SET state='blocked',reason='Checkpoint restoration requested; verification must be refreshed',revision=revision+1 WHERE id=?",
          )
          .run(id);
        this.store.event(task.session_id, 'work_task.restore_accepted', {
          task_id: id,
          restore_id: restore,
          checkpoint_id: checkpointId,
          conflicts: [...conflicts],
        });
        return { id: restore };
      },
    );
    this.apply(saved.id);
    const row = this.getRestore(saved.id);
    return { ...row, conflicts: JSON.parse(row.conflicts) };
  }
  private getRestore(id: string): Restore {
    return this.store.db
      .prepare('SELECT * FROM task_restores WHERE id=?')
      .get(id) as unknown as Restore;
  }
  private apply(id: string): void {
    const r = this.getRestore(id);
    if (r.state !== 'prepared') return;
    const task = this.tasks.get(r.task_id),
      key = 'task-restore:' + id;
    let mutation = this.store.db
      .prepare('SELECT id,state FROM workspace_mutations WHERE workspace_id=? AND request_key=?')
      .get(this.workspaces.get(task.session_id).id, key) as
      { id: string; state: string } | undefined;
    let error: string | null = null;
    if (!mutation) {
      try {
        this.verification.assertIdle(task);
        const before: WorkspaceTree = JSON.parse(this.artifacts.read(r.before_artifact)),
          after: WorkspaceTree = JSON.parse(this.artifacts.read(r.after_artifact));
        let w = this.workspaces.get(task.session_id);
        if (digest(readTree(w.root)) !== r.expected_digest)
          throw new ServiceError('restore_conflict', 'Workspace changed after restore acceptance');
        if (w.digest !== r.expected_digest || w.revision !== r.expected_revision) {
          this.workspaces.refresh(
            task.session_id,
            key + ':ack',
            r.expected_revision,
            r.expected_digest,
            () => {},
          );
          w = this.workspaces.get(task.session_id);
          if (w.revision !== r.expected_revision + 1 || w.digest !== r.expected_digest)
            throw new ServiceError('restore_conflict', 'Workspace revision changed during restore');
        }
        if (digest(before) !== digest(after))
          mutation = this.workspaces.replace(
            task.session_id,
            key,
            digest({ id, before: r.expected_digest, after: digest(after) }),
            w.revision,
            before,
            after,
          );
      } catch (cause) {
        // If a journaled filesystem mutation exists, its recovery decides the outcome.
        mutation = this.store.db
          .prepare(
            'SELECT id,state FROM workspace_mutations WHERE workspace_id=? AND request_key=?',
          )
          .get(this.workspaces.get(task.session_id).id, key) as
          { id: string; state: string } | undefined;
        if (mutation?.state === 'prepared') throw cause;
        error = (cause as Error).message;
      }
    }
    if (mutation?.state === 'prepared') return;
    const failed = !!error || (mutation && mutation.state !== 'applied');
    const state = failed ? 'conflict' : JSON.parse(r.conflicts).length ? 'partial' : 'restored';
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE task_restores SET state=?,mutation_id=? WHERE id=?')
        .run(state, mutation?.id ?? null, id);
      this.store.event(task.session_id, 'work_task.restore_' + state, {
        task_id: task.id,
        restore_id: id,
        mutation_id: mutation?.id ?? null,
        conflicts: JSON.parse(r.conflicts),
        error,
        external_effects_rolled_back: false,
      });
    });
  }
  recover(): void {
    for (const r of this.store.db
      .prepare("SELECT id FROM task_restores WHERE state='prepared'")
      .all() as { id: string }[])
      this.apply(r.id);
  }
}
