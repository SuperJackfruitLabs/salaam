import type { Store } from './store.js';
import { ServiceError, type Controller } from '../core/index.js';

/** Revocation acknowledges the durable fence, never an unobserved process/effect outcome. */
export interface SessionRevocation {
  session_id: string;
  revoked: true;
  reason: string;
  request_id: string;
  session_ids: string[];
  attempt_ids: string[];
  unresolved_operations: string[];
  stop_confirmation: 'not_reported';
}

export class ExecutionAuthority {
  constructor(private store: Store) {}

  revocation(session: string): SessionRevocation | null {
    this.store.session(session);
    const row = this.store.db
      .prepare(
        `WITH RECURSIVE owners(id) AS (
      SELECT ? UNION SELECT c.parent_session FROM child_tasks c JOIN owners o ON c.child_session=o.id
    ) SELECT r.receipt FROM session_revocations r JOIN owners o ON r.session_id=o.id LIMIT 1`,
      )
      .get(session);
    return row ? JSON.parse(String(row.receipt)) : null;
  }

  assert(session: string): void {
    if (this.revocation(session))
      throw new ServiceError(
        'session_revoked',
        'Session execution authority was revoked; create a new session',
      );
    const bound = this.store.db
      .prepare(
        `WITH RECURSIVE owners(id) AS (SELECT ? UNION SELECT c.parent_session FROM child_tasks c JOIN owners o ON c.child_session=o.id)
      SELECT a.session_id FROM agentpod_admissions a JOIN owners o ON o.id=a.session_id LIMIT 1`,
      )
      .get(session);
    if (bound) {
      if (!this.store.agentpodAuthorityCheck)
        throw new ServiceError(
          'authority_unavailable',
          'AgentPod authority control is unavailable',
        );
      this.store.agentpodAuthorityCheck(String(bound.session_id));
    } else if (this.store.requireAgentPodAuthority)
      throw new ServiceError(
        'admission_required',
        'This daemon requires a trusted AgentPod admission before execution',
      );
    this.store.nativeResourceCheck?.(session);
  }

  revoke(
    session: string,
    request: string,
    revision: number,
    reason: string,
    controller: Controller,
    cancel: (attempt: string) => void,
  ): SessionRevocation {
    return this.store.request(
      'local-operator',
      request,
      { kind: 'revoke-session', session, revision, reason },
      () => {
        this.store.authorizeControl(session, controller);
        if (this.store.session(session).revision !== revision)
          throw new ServiceError('revision_conflict', 'Session revision changed');
        this.assert(session);
        return this.revokeInTransaction(session, request, reason, cancel);
      },
    );
  }
  revokeInTransaction(
    session: string,
    request: string,
    reason: string,
    cancel: (attempt: string) => void,
  ): SessionRevocation {
    if (!this.store.db.isTransaction) throw Error('Revocation requires a transaction');
    const prior = this.revocation(session);
    if (prior) return prior;
    const sessions = this.store.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
    SELECT ? UNION SELECT c.child_session FROM child_tasks c JOIN descendants d ON c.parent_session=d.id
  ) SELECT id FROM descendants`,
      )
      .all(session)
      .map((r) => String(r.id));
    const attempts = sessions.flatMap((id) =>
      this.store.db
        .prepare(
          "SELECT id FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running','delegated') ORDER BY rowid",
        )
        .all(id)
        .map((r) => String(r.id)),
    );
    const receipt: SessionRevocation = {
      session_id: session,
      revoked: true,
      reason,
      request_id: request,
      session_ids: sessions,
      attempt_ids: attempts,
      unresolved_operations: [],
      stop_confirmation: 'not_reported',
    };
    this.store.db
      .prepare('INSERT INTO session_revocations VALUES (?,?)')
      .run(session, JSON.stringify(receipt));
    // Fence every admitted attempt and descendant in the same commit as the receipt.
    // A crash before process abort cannot restore this authority.
    for (const attempt of attempts) cancel(attempt);
    receipt.unresolved_operations = sessions.flatMap((id) =>
      this.store.db
        .prepare("SELECT id FROM operations WHERE session_id=? AND state='outcome_unknown'")
        .all(id)
        .map((r) => String(r.id)),
    );
    this.store.db
      .prepare('UPDATE session_revocations SET receipt=? WHERE session_id=?')
      .run(JSON.stringify(receipt), session);
    for (const id of sessions) {
      this.store.db
        .prepare(
          'UPDATE task_runtime SET auto_enabled=0 WHERE task_id IN (SELECT id FROM durable_tasks WHERE session_id=?)',
        )
        .run(id);
      this.store.db
        .prepare(
          "UPDATE command_runs SET cancelled=1 WHERE session_id=? AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
        )
        .run(id);
    }
    for (const id of sessions)
      this.store.event(id, 'execution.revoked', { owner_session: session, reason }, request);
    return receipt;
  }
}
