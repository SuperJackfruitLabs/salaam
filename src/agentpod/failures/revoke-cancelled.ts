import { canonical } from '../../core/index.js';
import { noLedgeredEffects } from './ledgers.js';
import type { FailureRule, Row, RuleStore, StoppedRun } from './rule.js';

/** An attempt the owner's authority revocation cancelled (for example a hub restart) before
 * any ledgered effect. The only tool activity allowed is closed operator MCP calls, each
 * journaled with argument and result digests; they are preserved as the known effects. */
export class RevokeCancelled implements FailureRule {
  readonly name = 'revoke_cancelled';
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
    const attempt = attempts[0];
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null ||
      !attempt.outcome
    )
      return null;
    const outcome = JSON.parse(String(attempt.outcome));
    if (
      outcome.version !== 1 ||
      outcome.stopReason !== 'cancelled' ||
      outcome.failure?.kind !== 'cancelled' ||
      outcome.failure.code !== 'attempt_cancelled' ||
      outcome.failure.retryable !== false ||
      outcome.failure.sessionId !== session ||
      outcome.failure.attemptId !== attempt.id
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'cancelled' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    const links = this.store.db
      .prepare(
        'SELECT b.* FROM task_step_attempts b JOIN task_steps s ON s.id=b.step_id WHERE s.task_id=?',
      )
      .all(task.id);
    if (
      links.length !== 1 ||
      links[0]!.attempt_id !== attempt.id ||
      links[0]!.plan_revision !== task.plan_revision ||
      links[0]!.step_id !== steps[0]!.id
    )
      return null;
    // The cancellation came from the node's revocation of this session, not a local operator.
    const node = this.nodeRevocation(session, attempt.id);
    if (!node) return null;
    const { cancellation, revocation } = node;
    const marks = this.store.db
      .prepare(
        "SELECT seq,kind,payload,causation_id FROM events WHERE session_id=? AND kind IN ('attempt.cancel_requested','execution.revoked','attempt.cancelled') ORDER BY seq",
      )
      .all(session);
    const only = (kind: string) => {
      const found = marks.filter((e) => e.kind === kind);
      return found.length === 1 ? found[0]! : null;
    };
    const requested = only('attempt.cancel_requested'),
      revoked = only('execution.revoked'),
      cancelled = only('attempt.cancelled');
    if (
      marks.length !== 3 ||
      !requested ||
      !revoked ||
      !cancelled ||
      requested.causation_id !== 'agentpod-revocation' ||
      JSON.parse(String(requested.payload)).attempt_id !== attempt.id ||
      revoked.causation_id !== revocation.request_id ||
      JSON.parse(String(revoked.payload)).owner_session !== session ||
      JSON.parse(String(cancelled.payload)).attempt_id !== attempt.id ||
      !(Number(requested.seq) < Number(revoked.seq) && Number(revoked.seq) < Number(cancelled.seq))
    )
      return null;
    // Tool activity: only operator MCP tools, each closed before the revocation, each holding
    // at most one journaled call (none for a catalog read), and no call outside a tool.
    const calls = this.operatorMcpCalls(session, attempt.id, Number(requested.seq));
    if (!calls) return null;
    const units = noLedgeredEffects(this.store, session, task);
    if (!units) return null;
    return {
      revocation,
      cancellation,
      events: marks,
      operator_mcp_calls: calls,
      link: links[0],
      unbound_stopped_units: units,
    };
  }
  /** The operator MCP tools, one at a time, each closed before the revocation and holding at
   * most one journaled call. Null when the activity is anything else. */
  private operatorMcpCalls(session: string, attempt: unknown, before: number): Row[] | null {
    const activity = this.store.db
      .prepare(
        "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished','operator_mcp.call','policy.allowed','policy.denied') ORDER BY seq",
      )
      .all(session);
    const calls: Row[] = [];
    let open: { id: string; calls: number } | null = null;
    for (const event of activity) {
      const payload = JSON.parse(String(event.payload));
      if (Number(event.seq) >= before) return null;
      if (payload.attempt_id !== attempt) return null;
      if (event.kind === 'tool.started') {
        if (
          open ||
          payload.tool !== 'salaam_operator_mcp' ||
          typeof payload.tool_call_id !== 'string' ||
          !payload.tool_call_id ||
          payload.parent_tool_call_id
        )
          return null;
        open = { id: payload.tool_call_id, calls: 0 };
      } else if (event.kind === 'tool.finished') {
        if (!open || payload.tool_call_id !== open.id || payload.tool !== 'salaam_operator_mcp')
          return null;
        open = null;
      } else if (event.kind === 'operator_mcp.call') {
        if (
          !open ||
          ++open.calls > 1 ||
          !['returned', 'tool_error', 'failed'].includes(String(payload.outcome))
        )
          return null;
        calls.push({ seq: event.seq, ...payload });
      } else if (event.kind === 'policy.allowed') {
        if (!open || payload.tool !== 'salaam_operator_mcp') return null;
      } else return null;
    }
    if (open) return null;
    return calls;
  }
  /** The attempt's one cancellation, requested by the node, and the session's one revocation
   * receipt naming exactly this session and attempt. Null otherwise. */
  private nodeRevocation(
    session: string,
    attempt: unknown,
  ): { cancellation: Row; revocation: Row } | null {
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt));
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
      revocation.session_id !== session ||
      canonical(revocation.session_ids) !== canonical([session]) ||
      canonical(revocation.attempt_ids) !== canonical([attempt]) ||
      canonical(revocation.unresolved_operations) !== canonical([]) ||
      typeof revocation.request_id !== 'string' ||
      !revocation.request_id
    )
      return null;
    return { cancellation: cancellations[0]!, revocation };
  }
}
