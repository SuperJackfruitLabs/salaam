// Item 11b, restores: the journal of restore writes, the live workspace read through the
// helper's closed verbs, and the restore itself, each write sent through the protected helper in
// order with a receipt per file.
import { randomUUID } from 'node:crypto';
import { canonical, digest, ServiceError } from '../core/index.js';
import type { Artifacts, Store } from '../store/index.js';
import type { FileNow, LiveTree } from './station-checkpoints.js';
import { StationFilesDefiniteFailure } from './station-helper.js';

/** How long the helper has to apply one restore write. */
const RESTORE_WRITE_DEADLINE_MS = 5000;

/** What a restore needs from the station: the journal, the artifact store, its configuration
 * digest and the helper. */
export interface StationRestoreDeps {
  readonly store: Store;
  readonly artifacts: Artifacts;
  readonly configurationDigest: string;
  helper(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Item 11b: the restore journal. Each write is recorded before it is sent, so a daemon stop
 * mid-restore leaves an honest unknown, never a silent effect. */
export function restoreTables(deps: StationRestoreDeps): void {
  deps.store.db.exec(`CREATE TABLE IF NOT EXISTS station_restores(
    id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
    restore_digest TEXT NOT NULL, approved_by TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);
  CREATE TABLE IF NOT EXISTS station_restore_writes(
    restore_id TEXT NOT NULL REFERENCES station_restores(id), n INTEGER NOT NULL, path TEXT NOT NULL,
    args_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, artifact_id TEXT,
    PRIMARY KEY(restore_id, n));`);
}
/** Item 11b: the live workspace through the helper's closed verbs (inspect, search, read). A
 * path is absent only when an exact search finds no entry for it; a file the helper refuses to
 * read (too large, not text) is unreadable, never guessed. */
export async function liveTree(deps: StationRestoreDeps): Promise<LiveTree> {
  const inspected = await deps.helper({ action: 'inspect' });
  return {
    tree: String(inspected.tree_digest),
    file: async (path: string): Promise<FileNow> => {
      let offset: number | null = 0,
        found = false;
      while (offset !== null && !found) {
        const page: Record<string, any> = await deps.helper({
          action: 'search',
          query: path,
          offset,
        });
        found = (page.entries as { path: string }[]).some((e) => e.path === path);
        offset = page.next_offset ?? null;
      }
      if (!found) return { state: 'absent' };
      try {
        const read = await deps.helper({ action: 'read', path });
        return { state: 'content', content: String(read.content), sha256: String(read.sha256) };
      } catch {
        return { state: 'unreadable' };
      }
    },
  };
}
/** Item 11b: the journal's answer for a restore request already seen, or null for a new one.
 * A replay returns the saved receipt exactly; the same request for another restore is a
 * conflict; an unfinished one says so. Checked before any plan is recomputed. */
export function replayedRestore(
  deps: StationRestoreDeps,
  session: string,
  request: string,
  restoreDigest: string,
): unknown {
  restoreTables(deps);
  const saved = deps.store.db
    .prepare('SELECT * FROM station_restores WHERE request_id=?')
    .get(request);
  if (!saved) return null;
  if (saved.restore_digest !== restoreDigest || saved.session_id !== session)
    throw new ServiceError('request_conflict', 'This restore request was used for another restore');
  if (saved.receipt) return JSON.parse(String(saved.receipt));
  throw new ServiceError('restore_unconfirmed', 'This restore did not finish; review it again');
}
/** At start: a restore write that was in flight has an unknown outcome; its restore is partial. */
export function recoverRestores(deps: StationRestoreDeps): void {
  restoreTables(deps);
  deps.store.transaction(() => {
    for (const w of deps.store.db
      .prepare("SELECT restore_id,n FROM station_restore_writes WHERE state='dispatching'")
      .all()) {
      deps.store.db
        .prepare(
          "UPDATE station_restore_writes SET state='outcome_unknown' WHERE restore_id=? AND n=?",
        )
        .run(String(w.restore_id), Number(w.n));
      deps.store.db
        .prepare("UPDATE station_restores SET state='partial' WHERE id=?")
        .run(String(w.restore_id));
    }
  });
}
/** A restore plan: the reviewed tree and the writes that take it back to the checkpoint. */
export interface RestorePlan {
  restore_digest: string;
  current_tree: string;
  writes: { path: string; content: string | null; expected_hash: string | null }[];
}

/** One restore in progress: its journal id and what was approved. */
interface RestoreRun {
  id: string;
  session: string;
  rootDigest: string;
  plan: RestorePlan;
  request: string;
  approvedBy: string;
}

/**
 * Item 11b: restore files exactly as planned and approved, after the run has ended. The caller
 * checks the ended run and the approval; this writes. It refuses a workspace whose live tree is
 * not the reviewed one, then sends each write through the protected helper in order, chaining
 * the expected tree and each file's current hash, with a receipt per file. The same request
 * replays its receipt. A failure stops the restore; nothing is retried.
 */
export async function restoreFiles(
  deps: StationRestoreDeps,
  session: string,
  rootDigest: string,
  plan: RestorePlan,
  request: string,
  approvedBy: string,
): Promise<unknown> {
  restoreTables(deps);
  const saved = deps.store.db
    .prepare('SELECT * FROM station_restores WHERE request_id=?')
    .get(request);
  if (saved) {
    if (saved.restore_digest !== plan.restore_digest || saved.session_id !== session)
      throw new ServiceError(
        'request_conflict',
        'This restore request was used for another restore',
      );
    if (saved.receipt) return JSON.parse(String(saved.receipt));
    throw new ServiceError('restore_unconfirmed', 'This restore did not finish; review it again');
  }
  const live = (await deps.helper({ action: 'inspect' })) as { tree_digest?: unknown };
  if (live.tree_digest !== plan.current_tree)
    throw new ServiceError(
      'restore_changed',
      'The workspace changed since this restore was reviewed',
    );
  const id = randomUUID();
  deps.store.transaction(() =>
    deps.store.db
      .prepare("INSERT INTO station_restores VALUES (?,?,?,?,?,'running',NULL)")
      .run(id, session, request, plan.restore_digest, approvedBy),
  );
  const run: RestoreRun = { id, session, rootDigest, plan, request, approvedBy };
  let tree = plan.current_tree;
  const done: { path: string; artifact_id: string }[] = [];
  let stopped: string | null = null;
  for (const [n, w] of plan.writes.entries()) {
    const written = await restoreWrite(deps, run, n, w, tree);
    if (!written) {
      stopped = w.path;
      break;
    }
    done.push({ path: w.path, artifact_id: written.artifact_id });
    tree = String(written.result.tree_digest);
  }
  const receipt = {
    version: 1 as const,
    state: stopped ? ('partial' as const) : ('restored' as const),
    restore_id: id,
    restore_digest: plan.restore_digest,
    tree_digest: tree,
    writes: done,
    ...(stopped ? { stopped_at: stopped } : {}),
  };
  deps.store.transaction(() => {
    deps.store.db
      .prepare('UPDATE station_restores SET state=?,receipt=? WHERE id=?')
      .run(receipt.state, canonical(receipt), id);
    deps.store.event(session, 'station.restored', {
      restore_id: id,
      restore_digest: plan.restore_digest,
      approved_by: approvedBy,
      state: receipt.state,
    });
  });
  return receipt;
}

/** One write, journaled before it is sent: its result and receipt artifact, or null when the
 * helper refused it or its outcome is unknown (recorded, and the restore stops there). */
async function restoreWrite(
  deps: StationRestoreDeps,
  run: RestoreRun,
  n: number,
  w: RestorePlan['writes'][number],
  tree: string,
): Promise<{ result: Record<string, unknown>; artifact_id: string } | null> {
  const { id, session, rootDigest, plan, request, approvedBy } = run;
  const args = {
    action: 'patch',
    path: w.path,
    expected_tree: tree,
    expected_hash: w.expected_hash,
    content: w.content,
    // The helper accepts only a 64-hex request id: one per restore write, stable on replay.
    request_id: digest({ restore: id, write: n }),
    deadline_ms: Date.now() + RESTORE_WRITE_DEADLINE_MS,
  };
  deps.store.transaction(() =>
    deps.store.db
      .prepare("INSERT INTO station_restore_writes VALUES (?,?,?,?,'dispatching',NULL,NULL)")
      .run(id, n, w.path, canonical(args)),
  );
  let result: Record<string, unknown>;
  try {
    result = await deps.helper(args);
  } catch (error) {
    const definite = error instanceof StationFilesDefiniteFailure;
    deps.store.transaction(() =>
      deps.store.db
        .prepare(
          'UPDATE station_restore_writes SET state=?,result_json=? WHERE restore_id=? AND n=?',
        )
        .run(
          definite ? 'failed' : 'outcome_unknown',
          canonical({
            code: definite ? error.code : 'station_execution_unconfirmed',
          }),
          id,
          n,
        ),
    );
    return null;
  }
  const artifact = deps.artifacts.prepare(
    session,
    canonical({
      version: 1,
      kind: 'station-restore-receipt',
      restore_id: id,
      request_id: request,
      restore_digest: plan.restore_digest,
      approved_by: approvedBy,
      session_id: session,
      root_digest: rootDigest,
      configuration_digest: deps.configurationDigest,
      path: w.path,
      patch: {
        content: w.content,
        expected_tree: args.expected_tree,
        expected_hash: w.expected_hash,
      },
      result,
    }),
  );
  deps.store.transaction(() => {
    artifact.commit();
    deps.store.db
      .prepare(
        "UPDATE station_restore_writes SET state='returned',result_json=?,artifact_id=? WHERE restore_id=? AND n=?",
      )
      .run(canonical(result), artifact.id, id, n);
  });
  return { result, artifact_id: artifact.id };
}
