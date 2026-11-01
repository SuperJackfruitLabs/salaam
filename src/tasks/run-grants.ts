import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';

/**
 * "Approve for this run" (approval scopes, item B). A person answering one workspace-write approval
 * may cover the rest of the run's writes inside the run's own directory. Each later write is still
 * prepared, digest-bound and journaled as its own operation; the grant only answers its approval.
 *
 * A grant covers a station patch only when it is a write (never a delete: every delete asks), its
 * path lies under `runs/<runId>/`, and no segment is empty, `.`, `..` or hidden (a leading dot).
 * It is bound to the session, task, plan revision and binding digest it was given under, and ends
 * when any of them changes or the task settles. Anything outside it asks as before.
 */
export interface RunGrant {
  id: string;
  session_id: string;
  task_id: string;
  plan_revision: number;
  binding_digest: string;
  path_prefix: string;
  approval_id: string;
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

export const runGrantPrefix = (runId: string): string | null =>
  /^run_[A-Za-z0-9]{6,}$/.test(runId) ? `runs/${runId}/` : null;

/** Whether a station patch's arguments are a write a grant for this prefix may answer. */
export function runGrantCovers(prefix: string, args: Record<string, unknown>): boolean {
  if (args.action !== 'patch' || typeof args.content !== 'string') return false;
  const path = args.path;
  if (typeof path !== 'string' || !path.startsWith(prefix) || path.length === prefix.length)
    return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !s.startsWith('.'));
}

export class RunGrants {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS run_grants(
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      plan_revision INTEGER NOT NULL,
      binding_digest TEXT NOT NULL,
      path_prefix TEXT NOT NULL,
      approval_id TEXT NOT NULL UNIQUE,
      granted_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT)`);
  }
  /** Within the caller's transaction, next to the decision that granted it. Idempotent per approval. */
  createInTransaction(input: Omit<RunGrant, 'id' | 'created_at' | 'revoked_at'>): RunGrant {
    if (!this.store.db.isTransaction) throw Error('A run grant is created with its decision');
    const saved = this.store.db
      .prepare('SELECT * FROM run_grants WHERE approval_id=?')
      .get(input.approval_id) as RunGrant | undefined;
    if (saved) return saved;
    const grant: RunGrant = {
      ...input,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    this.store.db
      .prepare('INSERT INTO run_grants VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        grant.id,
        grant.session_id,
        grant.task_id,
        grant.plan_revision,
        grant.binding_digest,
        grant.path_prefix,
        grant.approval_id,
        grant.granted_by,
        grant.created_at,
        null,
      );
    this.store.event(grant.session_id, 'run_grant.created', {
      grant_id: grant.id,
      approval_id: grant.approval_id,
      task_id: grant.task_id,
      path_prefix: grant.path_prefix,
    });
    return grant;
  }
  /** The live grant for exactly this session, task, plan revision and binding, if any. */
  active(scope: {
    session_id: string;
    task_id: string;
    plan_revision: number;
    binding_digest: string;
    task_state: string;
  }): RunGrant | null {
    if (['cancelled', 'succeeded', 'succeeded_with_exception'].includes(scope.task_state))
      return null;
    return (
      (this.store.db
        .prepare(
          'SELECT * FROM run_grants WHERE session_id=? AND task_id=? AND plan_revision=? AND binding_digest=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get(scope.session_id, scope.task_id, scope.plan_revision, scope.binding_digest) as
        RunGrant | undefined) ?? null
    );
  }
}
