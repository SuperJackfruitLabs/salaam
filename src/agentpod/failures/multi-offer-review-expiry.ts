import { canonical } from '../../core/index.js';
import { noLedgeredEffects } from './ledgers.js';
import type { FailureRule, Json, Row, RuleStore } from './rule.js';
import type { WorkTask } from '../../core/index.js';

/** An expired decision offer and the run it was offered in. */
export interface ExpiredOffers {
  readonly session: string;
  readonly task: WorkTask;
  readonly runtime: Row | undefined;
  readonly offered: Row;
}

/** Several unanswered review offers in one attempt: each one expired, or was invalidated by the
 * owner's revocation (a hub restart), before anyone answered it. Every operation was cancelled
 * before dispatch, the only station calls are closed reads, and nothing ran after the revoke. */
export class MultiOfferReviewExpiry implements FailureRule<ExpiredOffers> {
  readonly name = 'several_review_offers';
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, offered }: ExpiredOffers) {
    if (
      task.state !== 'blocked' ||
      task.steps.some((s) => !['pending', 'cancelled'].includes(s.state)) ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs
    )
      return null;
    const revoked = this.revokedAttempt(session);
    if (!revoked) return null;
    const { attempt, revocation, events, requested } = revoked;
    // Two or more review operations, all on this attempt, all cancelled before dispatch.
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (
      ops.length < 2 ||
      !ops.some((op) => op.id === offered.operation_id) ||
      ops.some(
        (op) =>
          op.kind !== 'review' ||
          op.state !== 'cancelled_before_dispatch' ||
          op.attempt_id !== attempt.id,
      )
    )
      return null;
    const offers = this.unansweredOffers(session, events, requested, ops);
    if (!offers) return null;
    // The decision being settled is one that expired unanswered, exactly as it was offered.
    const settled = offers.find((o) => o.approval_id === offered.approval_id);
    const approval = this.store.db
      .prepare('SELECT * FROM approvals WHERE id=?')
      .get(String(offered.approval_id));
    if (
      settled?.state !== 'expired' ||
      !approval ||
      approval.operation_digest !== offered.operation_digest ||
      approval.expires_at !== offered.expires_at
    )
      return null;
    const units = noLedgeredEffects(this.store, session, task, {
      operations: true,
      stationReads: true,
    });
    if (!units) return null;
    return {
      revocation,
      offers,
      reads: this.store.db
        .prepare('SELECT id,input_digest FROM station_calls WHERE session_id=? ORDER BY id')
        .all(session),
      unbound_stopped_units: units,
    };
  }
  /** Each operation's one approval, unanswered: expired (and its operation cancelled right
   * after), or invalidated in the revocation's own block. Null when any is neither. */
  private unansweredOffers(
    session: string,
    events: Row[],
    requested: Row,
    ops: Row[],
  ): Json[] | null {
    const of = (e: Row) => JSON.parse(String(e.payload));
    // The invalidations the revocation made: the contiguous block of invalidated approvals and
    // their cancelled operations that ends at the revocation's own cancel request.
    const block = new Set<string>();
    for (let n = events.indexOf(requested) - 1; n >= 0; n--) {
      const e = events[n]!;
      if (e.kind === 'operation.cancelled_before_dispatch') continue;
      if (e.kind !== 'approval.invalidated') break;
      block.add(String(of(e).approval_id));
    }
    const offers: Json[] = [];
    for (const op of ops) {
      const approvals = this.store.db
        .prepare('SELECT * FROM approvals WHERE operation_id=?')
        .all(String(op.id));
      const approval = approvals[0];
      if (
        approvals.length !== 1 ||
        !approval ||
        approval.session_id !== session ||
        approval.decision !== null ||
        approval.operation_digest !== op.operation_digest
      )
        return null;
      if (approval.state === 'expired') {
        const expired = events.findIndex(
          (e) => e.kind === 'approval.expired' && of(e).approval_id === approval.id,
        );
        if (
          expired < 0 ||
          Number(approval.expires_at) > Date.now() ||
          events[expired + 1]?.kind !== 'operation.cancelled_before_dispatch' ||
          of(events[expired + 1]!).operation_id !== op.id
        )
          return null;
      } else if (approval.state !== 'invalidated' || !block.has(String(approval.id))) return null;
      offers.push({ operation_id: op.id, approval_id: approval.id, state: approval.state });
    }
    return offers;
  }
  /** The session's one attempt, cancelled by the node's revocation of this session (which names
   * exactly it) with nothing started after the cancel request. Null otherwise. */
  private revokedAttempt(
    session: string,
  ): { attempt: Row; revocation: Row; events: Row[]; requested: Row } | null {
    const attempts = this.store.db
      .prepare('SELECT * FROM attempts WHERE session_id=?')
      .all(session);
    const attempt = attempts[0];
    if (
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.resolved_by !== null ||
      attempt.result !== null
    )
      return null;
    // Cancelled by the node's revocation of this session, which names exactly this attempt.
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt.id));
    const revocations = this.store.db
      .prepare('SELECT * FROM session_revocations WHERE session_id=?')
      .all(session);
    if (
      cancellations.length !== 1 ||
      cancellations[0]!.requested_by !== 'agentpod-node' ||
      revocations.length !== 1
    )
      return null;
    const revocation = JSON.parse(String(revocations[0]!.receipt));
    if (
      revocation.revoked !== true ||
      canonical(revocation.attempt_ids) !== canonical([attempt.id]) ||
      canonical(revocation.unresolved_operations) !== canonical([])
    )
      return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload,causation_id FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const one = (kind: string) => {
      const found = events.filter((e) => e.kind === kind);
      return found.length === 1 ? found[0]! : null;
    };
    const requested = one('attempt.cancel_requested'),
      revoked = one('execution.revoked'),
      cancelled = one('attempt.cancelled');
    if (
      !requested ||
      !revoked ||
      !cancelled ||
      requested.causation_id !== 'agentpod-revocation' ||
      !(
        Number(requested.seq) < Number(revoked.seq) && Number(revoked.seq) < Number(cancelled.seq)
      ) ||
      events.some((e) => e.kind === 'tool.started' && Number(e.seq) > Number(requested.seq))
    )
      return null;
    return { attempt, revocation, events, requested };
  }
}
