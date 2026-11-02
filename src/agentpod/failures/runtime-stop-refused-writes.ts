import { canonical } from '../../core/index.js';
import { noLedgeredEffects } from './ledgers.js';
import { operatorMcpCalls } from './operator-mcp-tools.js';
import type { FailureRule, Row, RuleStore, StoppedRun } from './rule.js';

/** The errors a refused write and a write never sent are journaled with. */
const REFUSED = 'Protected filesystem refused before its mutation boundary';
const NOT_SENT = 'Workspace apply was cancelled before dispatch';

/** An attempt the task runtime limit stopped while its approved workspace writes were all
 * refused by the protected filesystem before their mutation boundary. Each write is journaled
 * failed_definite: refused by the station helper after its approval, or (the one still waiting
 * when the stop came) cancelled before dispatch with its approval invalidated. Every other
 * station call is a closed read, every operator MCP call is closed inside its own tool, and no
 * tool started after the stop. The refused writes and the reads are the known effects. */
export class RuntimeStopRefusedWrites implements FailureRule {
  readonly name = 'runtime_stop_refused_writes';
  constructor(private readonly store: RuleStore) {}
  match({ session, task, runtime, attempts }: StoppedRun) {
    const reason = 'Task runtime limit reached',
      attempt = attempts[0];
    if (
      task.state !== 'blocked' ||
      !runtime ||
      runtime.blocked_reason !== reason ||
      runtime.started_at === null ||
      !Number.isFinite(Number(runtime.started_at)) ||
      Date.now() - Number(runtime.started_at) < task.limits.runtime_ms ||
      runtime.auto_enabled ||
      runtime.reserved_requests ||
      runtime.reserved_tokens ||
      runtime.verification_runs ||
      attempts.length !== 1 ||
      !attempt ||
      attempt.state !== 'cancelled' ||
      attempt.error !== 'Attempt aborted' ||
      attempt.resolved_by !== null ||
      attempt.continues_attempt_id !== null ||
      attempt.result !== null
    )
      return null;
    const steps = task.steps.filter((s) => s.attempt_id === attempt.id);
    if (
      steps.length !== 1 ||
      steps[0]!.state !== 'cancelled' ||
      task.steps.some((s) => s !== steps[0] && (s.state !== 'pending' || s.attempt_id !== null))
    )
      return null;
    // Stopped by the runtime limit's own task stop, not by anyone.
    const cancellations = this.store.db
      .prepare('SELECT * FROM cancellations WHERE attempt_id=?')
      .all(String(attempt.id));
    if (cancellations.length !== 1 || cancellations[0]!.requested_by !== 'task-stop') return null;
    const events = this.store.db
      .prepare('SELECT seq,kind,payload FROM events WHERE session_id=? ORDER BY seq')
      .all(session);
    const of = (e: Row) => JSON.parse(String(e.payload));
    const blocks = events.filter(
        (e) => e.kind === 'work_task.budget_blocked' && of(e).reason === reason,
      ),
      requested = events.filter((e) => e.kind === 'attempt.cancel_requested'),
      cancelled = events.filter((e) => e.kind === 'attempt.cancelled');
    if (
      blocks.length !== 1 ||
      requested.length !== 1 ||
      cancelled.length !== 1 ||
      of(requested[0]!).attempt_id !== attempt.id ||
      of(cancelled[0]!).attempt_id !== attempt.id ||
      !(
        Number(blocks[0]!.seq) < Number(requested[0]!.seq) &&
        Number(requested[0]!.seq) < Number(cancelled[0]!.seq)
      )
    )
      return null;
    // Every operation is a workspace write on this attempt that never crossed its boundary.
    const ops = this.store.db
      .prepare('SELECT * FROM operations WHERE session_id=? ORDER BY rowid')
      .all(session);
    const calls = this.store.db
      .prepare('SELECT * FROM station_calls WHERE session_id=? ORDER BY rowid')
      .all(session);
    if (!ops.length) return null;
    const writes = this.refusedWrites(attempt, ops, calls);
    if (!writes) return null;
    // The remaining station calls are closed reads.
    const reads = calls.filter((c) => c.operation_id === null);
    if (reads.some((c) => c.kind !== 'read' || c.state !== 'returned')) return null;
    // Tools: station calls and operator MCP tools, every one closed, none started after the stop,
    // each operator MCP call inside an open operator MCP tool that has no call yet.
    const mcp = operatorMcpCalls(events, {
      attempt: attempt.id,
      before: Number(cancelled[0]!.seq),
      startedBefore: Number(requested[0]!.seq),
      tools: ['salaam_operator_mcp', 'salaam_station', 'salaam_board'],
      outcomes: ['returned', 'failed', 'tool_error'],
    });
    if (!mcp) return null;
    const units = noLedgeredEffects(this.store, session, task, {
      operations: true,
      stationCalls: true,
    });
    if (!units) return null;
    return {
      blocked: blocks[0],
      cancel_requested: requested[0],
      cancelled: cancelled[0],
      refused_writes: writes,
      reads: reads.map((c) => ({ id: c.id, input_digest: c.input_digest })),
      operator_mcp_calls: mcp,
      unbound_stopped_units: units,
    };
  }
  /** Each operation a workspace write of the attempt, journaled failed_definite and refused before
   * its mutation boundary (or never sent). Null when any is not. */
  private refusedWrites(attempt: Row, ops: Row[], calls: Row[]): Record<string, unknown>[] | null {
    const writes: Record<string, unknown>[] = [];
    for (const op of ops) {
      const approval = this.store.db
        .prepare('SELECT * FROM approvals WHERE operation_id=?')
        .get(String(op.id));
      const linked = calls.filter((c) => c.operation_id === op.id);
      const call = linked[0];
      if (
        op.kind !== 'workspace' ||
        op.attempt_id !== attempt.id ||
        op.state !== 'failed_definite' ||
        linked.length !== 1 ||
        !call ||
        call.kind !== 'patch' ||
        call.attempt_id !== attempt.id ||
        !approval ||
        approval.operation_digest !== op.operation_digest
      )
        return null;
      if (op.error === REFUSED) {
        // Approved, sent, and refused by the helper before it could change anything.
        if (
          approval.state !== 'decided' ||
          approval.decision !== 'approve' ||
          call.state !== 'failed' ||
          call.helper_state !== 'stopped' ||
          !call.result_json ||
          canonical(JSON.parse(String(call.result_json))) !==
            canonical({ code: 'station_files_changed' })
        )
          return null;
      } else if (op.error === NOT_SENT) {
        // Still waiting when the stop came: never sent to the helper at all.
        if (
          approval.state !== 'invalidated' ||
          call.state !== 'cancelled' ||
          call.helper_state !== 'none' ||
          call.result_json !== null
        )
          return null;
      } else return null;
      writes.push({
        operation_id: op.id,
        operation_digest: op.operation_digest,
        error: op.error,
        approval: approval.state,
        call_id: call.id,
        call_state: call.state,
      });
    }
    return writes;
  }
}
