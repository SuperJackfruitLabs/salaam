import { ServiceError, digest, type Controller, type Session } from './protocol.js';
import type { Store } from './store.js';
import {
  ShadowCheckpoints,
  type CheckpointChange,
  type CheckpointHunk,
} from './turn-checkpoints.js';

export type RewindMode = 'files' | 'conversation' | 'both';
export interface TurnCheckpoint {
  turn: number;
  attempt_id: string;
  /** The instruction that started the turn; the files are as they were before it ran. */
  text: string;
  tree: string;
  /** The conversation leaf before the turn's instruction. */
  leaf: string | null;
  at: string;
}
export interface RewindReview {
  turn: number;
  attempt_id: string;
  mode: RewindMode;
  current: string;
  target: string;
  /** What restoring does to the folder, file by file. */
  changes: CheckpointChange[];
  digest: string;
  /** Background commands still running in the session; they may write while you decide. */
  background_running?: number;
}
export interface ChangeReview {
  base: string;
  current: string;
  files: CheckpointChange[];
  /** Background commands still running in the session; they may write while you decide. */
  background_running?: number;
}

/** Local coding sessions only: a checkpoint of the folder at the start of every turn, rewind to
 * any of them, and the per-file review of what changed since the review base. */
export class TurnCheckpoints {
  constructor(
    readonly store: Store,
    readonly stateDir: string,
    /** Files written as another OS user cannot be restored by this process. */
    readonly restorable = true,
  ) {}
  shadow(id: string): ShadowCheckpoints {
    if (!this.store.localCoding(id))
      throw new ServiceError('local_denied', 'Checkpoints require a local coding session');
    return new ShadowCheckpoints(this.stateDir, this.store.session(id).cwd);
  }
  /** Called before each turn's prompt. A failure is recorded and never blocks the turn. */
  capture(id: string, attempt: string): void {
    if (!this.store.localCoding(id)) return;
    try {
      const shadow = this.shadow(id),
        tree = shadow.capture();
      shadow.keep(`${id}/${attempt}`, tree);
      const row = this.store.db
        .prepare(
          'SELECT s.text FROM attempts a JOIN submissions s ON s.id=a.submission_id WHERE a.id=?',
        )
        .get(attempt) as { text: string } | undefined;
      const event = {
        attempt_id: attempt,
        tree,
        leaf: this.store.session(id).pi_leaf,
        text: (row?.text ?? '').slice(0, 4096),
        at: new Date().toISOString(),
      };
      this.store.transaction(() => this.store.event(id, 'checkpoint.captured', event));
    } catch (error) {
      const reason = String((error as Error).message ?? error).slice(0, 500);
      this.store.transaction(() =>
        this.store.event(id, 'checkpoint.skipped', { attempt_id: attempt, reason }),
      );
    }
  }
  list(id: string): TurnCheckpoint[] {
    this.store.session(id);
    return (
      this.store.db
        .prepare(
          "SELECT payload FROM events WHERE session_id=? AND kind='checkpoint.captured' ORDER BY seq",
        )
        .all(id) as { payload: string }[]
    ).map((row, i) => {
      const p = JSON.parse(row.payload);
      return {
        turn: i + 1,
        attempt_id: p.attempt_id,
        text: p.text,
        tree: p.tree,
        leaf: p.leaf,
        at: p.at,
      };
    });
  }
  private checkpoint(id: string, attempt: string): TurnCheckpoint {
    const found = this.list(id).find((c) => c.attempt_id === attempt);
    if (!found) throw new ServiceError('not_found', 'No checkpoint for that turn', 404);
    return found;
  }
  reviewRewind(id: string, attempt: string, mode: RewindMode): RewindReview {
    if (!['files', 'conversation', 'both'].includes(mode))
      throw new ServiceError('invalid_field', 'Choose files, conversation or both');
    const point = this.checkpoint(id, attempt),
      shadow = this.shadow(id),
      current = shadow.capture(),
      changes = mode === 'conversation' ? [] : shadow.changes(current, point.tree);
    const root = this.store.session(id).cwd;
    return {
      turn: point.turn,
      attempt_id: attempt,
      mode,
      current,
      target: point.tree,
      changes,
      digest: digest({ kind: 'rewind', root, id, attempt, mode, current, target: point.tree }),
    };
  }
  /** One reviewed rewind. The folder is restored only if it is still the tree the person
   * reviewed; the conversation is never cut, it is forked from the turn's starting point. */
  rewind(
    id: string,
    request: string,
    attempt: string,
    mode: RewindMode,
    reviewed: string,
    controller: Controller,
    idle: () => void,
    fork: (leaf: string | null, label: string) => Session,
  ): { state: string; session_id: string; text: string } {
    const input = { kind: 'local-rewind', id, attempt, mode, reviewed };
    const saved = this.store.cachedRequest<{ state: string; session_id: string; text: string }>(
      'local-operator',
      request,
      input,
    );
    if (saved) return saved;
    const work = this.store.request('local-operator', request, input, () => {
      this.store.authorizeControl(id, controller);
      this.store.execution.assert(id);
      idle();
      if (mode !== 'conversation' && !this.restorable)
        throw new ServiceError(
          'rewind_unavailable',
          'Files written as the tools user cannot be restored by this service; rewind the conversation only',
        );
      if (
        this.store.hasUnknown(id) ||
        this.store.db
          .prepare(
            "SELECT 1 FROM local_calls WHERE root=? AND state IN ('running','outcome_unknown')",
          )
          .get(this.store.session(id).cwd)
      )
        throw new ServiceError(
          'local_busy',
          'Resolve active or uncertain effects before rewinding',
        );
      const review = this.reviewRewind(id, attempt, mode);
      if (review.digest !== reviewed)
        throw new ServiceError(
          'review_changed',
          'Files changed since you reviewed them; review again',
        );
      this.store.event(id, 'local.rewind.started', review, request);
      return { state: 'outcome_unknown', ...review };
    });
    // Intent is durable before any file changes.
    const point = this.checkpoint(id, attempt);
    if (mode !== 'conversation') this.shadow(id).restore(work.current, work.target);
    let session = id;
    if (mode !== 'files') session = fork(point.leaf, `Rewound to before turn ${point.turn}`).id;
    return this.store.transaction(() => {
      const result = { state: 'completed', session_id: session, text: point.text };
      this.store.event(
        id,
        'local.rewind.completed',
        { ...result, attempt_id: attempt, mode },
        request,
      );
      this.store.db
        .prepare('UPDATE requests SET response=? WHERE actor=? AND id=?')
        .run(JSON.stringify(result), 'local-operator', request);
      return result;
    });
  }
  /** The tree changes are reviewed against: the first checkpoint, moved forward by accepts. */
  base(id: string): string | null {
    const tree = (sql: string) =>
      (this.store.db.prepare(sql).get(id) as { tree: string } | undefined)?.tree;
    return (
      tree(
        "SELECT json_extract(payload,'$.tree') AS tree FROM events WHERE session_id=? AND kind='review.base' ORDER BY seq DESC LIMIT 1",
      ) ??
      tree(
        "SELECT json_extract(payload,'$.tree') AS tree FROM events WHERE session_id=? AND kind='checkpoint.captured' ORDER BY seq LIMIT 1",
      ) ??
      null
    );
  }
  review(id: string): ChangeReview | null {
    const base = this.base(id);
    if (!base) return null;
    const shadow = this.shadow(id),
      current = shadow.capture();
    return { base, current, files: shadow.changes(base, current) };
  }
  hunks(id: string, path: string, base: string, current: string): CheckpointHunk[] {
    return this.shadow(id).hunks(base, current, path);
  }
  /** Accept moves the review base; revert writes the base's content back into the folder. Both
   * are bound to the base and folder tree the person reviewed. */
  act(
    id: string,
    input: {
      action: 'accept' | 'revert';
      path: string;
      hunk?: CheckpointHunk;
      base: string;
      current: string;
    },
    controller: Controller,
    idle: () => void,
  ): ChangeReview | null {
    this.store.authorizeControl(id, controller);
    if (this.base(id) !== input.base)
      throw new ServiceError('review_changed', 'The review moved on; review again');
    const shadow = this.shadow(id);
    if (input.action === 'accept') {
      const tree = input.hunk
        ? shadow.acceptHunk(input.base, input.current, input.path, input.hunk)
        : shadow.acceptFile(input.base, input.current, input.path);
      shadow.keep(`${id}/review-${this.store.session(id).seq}`, tree);
      this.store.transaction(() =>
        this.store.event(id, 'review.base', { tree, accepted: input.path }),
      );
    } else if (input.action === 'revert') {
      this.store.execution.assert(id);
      idle();
      if (!this.restorable)
        throw new ServiceError(
          'rewind_unavailable',
          'Files written as the tools user cannot be reverted here',
        );
      if (input.hunk) shadow.revertHunk(input.current, input.base, input.path, input.hunk);
      else shadow.revertFile(input.current, input.base, input.path);
      this.store.transaction(() =>
        this.store.event(id, 'review.reverted', { path: input.path, hunk: !!input.hunk }),
      );
    } else throw new ServiceError('invalid_field', 'Choose accept or revert');
    return this.review(id);
  }
}
