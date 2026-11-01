import type { Store } from '../store/store.js';
import type { WorkTask } from '../core/records.js';
import { digest, ServiceError } from '../core/protocol.js';

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
  sha256: string | null;
};
export type FileAtCheckpoint =
  { state: 'content'; content: string } | { state: 'absent' } | { state: 'unknown' };
/** A file as the workspace holds it now, read through the protected helper's closed verbs. */
export type FileNow =
  | { state: 'content'; content: string; sha256: string }
  | { state: 'absent' }
  | { state: 'unreadable' };
/** The live workspace: its tree digest now, and each file's bytes now. */
export interface LiveTree {
  tree: string;
  file(path: string): Promise<FileNow>;
}

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
          sha256: typeof result.sha256 === 'string' ? result.sha256 : null,
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
  /**
   * What restoring this checkpoint would do, against the LIVE workspace (never the run's own
   * receipts alone): every path this run wrote is read as it is now, so a change made outside the
   * run since (an edit, a deletion, a file put back) shows as what the restore would undo. The
   * restore digest binds the live tree, so a restore refuses a workspace that moved after review.
   * Files this run never wrote are left as they are; `drift` says when the tree moved outside it.
   */
  async diff(task: WorkTask, id: string, live: LiveTree) {
    const checkpoint = this.get(task, id);
    const patches = this.patches(task.session_id);
    const recorded = patches.at(-1)?.tree ?? checkpoint.tree_digest;
    const paths = [...new Set(patches.map((p) => p.path))].sort();
    const files = [];
    for (const path of paths) {
      const now = await live.file(path);
      const then = this.fileAt(task, checkpoint.at, path);
      const change =
        now.state === 'unreadable' || then.state === 'unknown'
          ? ('not_restorable' as const)
          : then.state === 'absent'
            ? now.state === 'absent'
              ? ('unchanged' as const)
              : ('delete' as const)
            : now.state === 'absent'
              ? ('bring_back' as const)
              : now.content === then.content
                ? ('unchanged' as const)
                : ('revert' as const);
      files.push({
        path,
        current: now.state === 'content' ? now.content : null,
        current_state: now.state,
        at_checkpoint: then,
        change,
        expected_hash: now.state === 'content' ? now.sha256 : null,
      });
    }
    const shown = files.filter((f) => f.change !== 'unchanged');
    const restore_digest = digest({
      task: task.id,
      plan_revision: task.plan_revision,
      checkpoint: checkpoint.id,
      checkpoint_tree: checkpoint.tree_digest,
      recorded_tree: recorded,
      current_tree: live.tree,
      files: shown.map((f) => ({
        path: f.path,
        change: f.change,
        target: f.at_checkpoint,
        expected: f.expected_hash,
      })),
    });
    return {
      checkpoint,
      current_tree: live.tree,
      recorded_tree: recorded,
      drift: live.tree !== recorded,
      restore_digest,
      files: shown.map(({ expected_hash: _, ...f }) => f),
      writes: shown
        .filter((f) => ['revert', 'delete', 'bring_back'].includes(f.change))
        .map((f) => ({
          path: f.path,
          content: f.at_checkpoint.state === 'content' ? f.at_checkpoint.content : null,
          expected_hash: f.expected_hash,
        })),
    };
  }
  /** Item 11b: exactly what a restore of this checkpoint writes, and the digest that binds it. */
  async restorePlan(task: WorkTask, id: string, live: LiveTree) {
    const { restore_digest, current_tree, writes, checkpoint } = await this.diff(task, id, live);
    return { restore_digest, current_tree, writes, checkpoint };
  }
}
