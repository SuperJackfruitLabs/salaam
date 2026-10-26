import type { Store } from './store.js';
import type { WorkTask } from './task-work.js';
import { digest, ServiceError } from './protocol.js';

/**
 * Checkpoints of a station task, derived from its own recorded writes (item 11). Each completed
 * step ends at a checkpoint: the tree after that step's last returned station patch. A file's
 * content at a checkpoint is known only from the run's own patches; a file that existed before
 * the run and was first written after the checkpoint has no recorded earlier bytes, so it is
 * "unknown" there and cannot be restored. Read-only: nothing here changes the workspace.
 */
export interface StationCheckpoint {
  id: string;
  step_id: string;
  step_key: string;
  tree_digest: string;
  at: number; // the last patch call rowid at the checkpoint (0: before any write)
  files_changed: string[];
}
type Patch = {
  rowid: number;
  path: string;
  content: string | null;
  expected_hash: string | null;
  before_tree: string;
  tree: string;
};
export type FileAtCheckpoint =
  { state: 'content'; content: string } | { state: 'absent' } | { state: 'unknown' };

export class StationCheckpoints {
  constructor(private readonly store: Store) {}
  private patches(session: string): Patch[] {
    return this.store.db
      .prepare(
        "SELECT rowid,args_json,result_json,attempt_id FROM station_calls WHERE session_id=? AND kind='patch' AND state='returned' ORDER BY rowid",
      )
      .all(session)
      .map((r) => {
        const args = JSON.parse(String(r.args_json)),
          result = JSON.parse(String(r.result_json));
        return {
          rowid: Number(r.rowid),
          path: String(args.path),
          content: typeof args.content === 'string' ? args.content : null,
          expected_hash: typeof args.expected_hash === 'string' ? args.expected_hash : null,
          before_tree: String(result.before_tree_digest),
          tree: String(result.tree_digest),
          attempt: String(r.attempt_id),
        } as Patch & { attempt: string };
      });
  }
  list(task: WorkTask): StationCheckpoint[] {
    const patches = this.patches(task.session_id) as (Patch & { attempt: string })[];
    const attemptsOf = (step: string) =>
      new Set(
        this.store.db
          .prepare('SELECT attempt_id FROM task_step_attempts WHERE step_id=?')
          .all(step)
          .map((r) => String(r.attempt_id)),
      );
    const out: StationCheckpoint[] = [];
    let at = 0,
      tree = patches[0]?.before_tree ?? '';
    for (const step of task.steps.filter((s) => s.state === 'completed')) {
      const mine = patches.filter((p) => attemptsOf(step.id).has(p.attempt));
      if (mine.length) {
        at = Math.max(at, ...mine.map((p) => p.rowid));
        tree = patches.find((p) => p.rowid === at)!.tree;
      }
      out.push({
        id: digest({ task: task.id, plan_revision: task.plan_revision, step: step.id, at, tree }),
        step_id: step.id,
        step_key: step.key,
        tree_digest: tree,
        at,
        files_changed: [...new Set(mine.map((p) => p.path))].sort(),
      });
    }
    return out;
  }
  get(task: WorkTask, id: string): StationCheckpoint {
    const found = this.list(task).find((c) => c.id === id);
    if (!found) throw new ServiceError('not_found', 'No such checkpoint for this task', 404);
    return found;
  }
  /** A path's content at a checkpoint, from the run's own patches only. */
  fileAt(task: WorkTask, at: number, path: string): FileAtCheckpoint {
    const patches = this.patches(task.session_id).filter((p) => p.path === path);
    const before = patches.filter((p) => p.rowid <= at).at(-1);
    if (before)
      return before.content === null
        ? { state: 'absent' }
        : { state: 'content', content: before.content };
    const first = patches.find((p) => p.rowid > at);
    return first && first.expected_hash === null ? { state: 'absent' } : { state: 'unknown' };
  }
  /** What restoring this checkpoint would do to each path written after it. */
  diff(task: WorkTask, id: string) {
    const checkpoint = this.get(task, id);
    const patches = this.patches(task.session_id);
    const later = [
      ...new Set(patches.filter((p) => p.rowid > checkpoint.at).map((p) => p.path)),
    ].sort();
    const current = patches.at(-1)?.tree ?? checkpoint.tree_digest;
    return {
      checkpoint,
      current_tree: current,
      files: later.map((path) => {
        const now = patches.filter((p) => p.path === path).at(-1)!;
        const then = this.fileAt(task, checkpoint.at, path);
        return {
          path,
          current: now.content === null ? null : now.content,
          at_checkpoint: then,
          change:
            then.state === 'unknown'
              ? ('not_restorable' as const)
              : then.state === 'absent'
                ? now.content === null
                  ? ('unchanged' as const)
                  : ('delete' as const)
                : now.content === null
                  ? ('bring_back' as const)
                  : ('revert' as const),
        };
      }),
    };
  }
}
