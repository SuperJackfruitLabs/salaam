import { dirname } from 'node:path';
import { rmSync, openSync, closeSync, fsyncSync, constants } from 'node:fs';
import { assertPermissionBinding } from './autonomy.js';
import type { Store } from './store.js';
import { digest, ServiceError, type Controller } from './protocol.js';
import { applyLocalEdits, localPath, verifyLocalEdits, type LocalEdit } from './local-edits.js';

export interface UndoReview {
  call_id: string;
  digest: string;
  edits: LocalEdit[];
}
/** Unfinished inverse edits fence every local session sharing the root, including after a crash. */
export function assertUndoSettled(store: Store, root: string): void {
  if (
    store.db
      .prepare(
        `SELECT 1 FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.cwd=? AND e.kind='local.undo.started' AND NOT EXISTS (SELECT 1 FROM events done WHERE done.session_id=e.session_id AND done.kind='local.undo.completed' AND done.causation_id=e.causation_id) LIMIT 1`,
      )
      .get(root)
  )
    throw new ServiceError(
      'undo_outcome_unknown',
      'An undo has an unconfirmed outcome. Inspect the recorded inverse edits before further local execution.',
    );
}
export function reviewUndo(store: Store, id: string): UndoReview {
  const session = store.session(id);
  if (!store.localCoding(id))
    throw new ServiceError('local_denied', 'Undo requires a local coding session');
  assertUndoSettled(store, session.cwd);
  const row = store.db
    .prepare(
      `SELECT c.id,c.args FROM local_calls c WHERE c.session_id=? AND c.state='succeeded' AND json_extract(c.args,'$.action')='edit' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id=c.session_id AND e.kind='local.undo.completed' AND json_extract(e.payload,'$.call_id')=c.id) ORDER BY c.rowid DESC LIMIT 1`,
    )
    .get(id) as { id: string; args: string } | undefined;
  if (!row)
    throw new ServiceError(
      'nothing_to_undo',
      'No completed local edit remains to undo. Commands and external effects cannot be undone.',
    );
  const edits = (JSON.parse(row.args) as { edits: LocalEdit[] }).edits;
  verifyLocalEdits(
    session.cwd,
    edits.map((e) => ({ ...e, before: e.after })),
  );
  return { call_id: row.id, digest: digest({ root: session.cwd, call: row.id, edits }), edits };
}
export function applyUndo(
  store: Store,
  id: string,
  request: string,
  reviewed: string,
  controller: Controller,
  idle: () => void,
) {
  const input = { kind: 'local-undo', id, reviewed };
  const saved = store.cachedRequest<{ state: string }>('local-operator', request, input);
  if (saved) return saved;
  const root = store.session(id).cwd;
  const work = store.request('local-operator', request, input, () => {
    store.authorizeControl(id, controller);
    store.execution.assert(id);
    assertPermissionBinding(store, id, '', root);
    idle();
    if (
      store.hasUnknown(id) ||
      store.db
        .prepare(
          "SELECT 1 FROM local_calls WHERE root=? AND state IN ('running','outcome_unknown')",
        )
        .get(root)
    )
      throw new ServiceError('local_busy', 'Resolve active or uncertain effects before undo');
    const review = reviewUndo(store, id);
    if (review.digest !== reviewed)
      throw new ServiceError('review_changed', 'Undo target changed; review again');
    store.event(id, 'local.undo.started', review, request);
    return { state: 'outcome_unknown', ...review };
  });
  // Intent is durable before touching files. A lost process never repeats this mutation.
  for (const edit of work.edits) {
    const inverse = { ...edit, before: edit.after, after: edit.before ?? '' };
    if (edit.before === null) {
      verifyLocalEdits(root, [inverse]);
      const path = localPath(root, edit.path);
      rmSync(path);
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } else applyLocalEdits(root, [inverse], () => {});
  }
  verifyLocalEdits(root, work.edits);
  return store.transaction(() => {
    const result = { state: 'completed', call_id: work.call_id };
    store.event(id, 'local.undo.completed', result, request);
    store.db
      .prepare('UPDATE requests SET response=? WHERE actor=? AND id=?')
      .run(JSON.stringify(result), 'local-operator', request);
    return result;
  });
}

/** Reconcile a lost completion only after every original file is observed restored; never replay writes. */
export function reconcileUndo(store: Store, id: string, controller: Controller, idle: () => void) {
  return store.transaction(() => {
    store.authorizeControl(id, controller);
    store.execution.assert(id);
    idle();
    const pending = store.db
      .prepare(
        `SELECT e.causation_id,e.payload FROM events e WHERE e.session_id=? AND e.kind='local.undo.started' AND NOT EXISTS (SELECT 1 FROM events done WHERE done.session_id=e.session_id AND done.kind='local.undo.completed' AND done.causation_id=e.causation_id) ORDER BY e.seq LIMIT 1`,
      )
      .get(id) as { causation_id: string; payload: string } | undefined;
    if (!pending) return { state: 'nothing_pending' };
    const review = JSON.parse(pending.payload) as UndoReview;
    verifyLocalEdits(store.session(id).cwd, review.edits);
    const result = { state: 'completed', call_id: review.call_id, reconciled: true };
    store.event(id, 'local.undo.completed', result, pending.causation_id);
    store.db
      .prepare('UPDATE requests SET response=? WHERE actor=? AND id=?')
      .run(JSON.stringify(result), 'local-operator', pending.causation_id);
    return result;
  });
}
