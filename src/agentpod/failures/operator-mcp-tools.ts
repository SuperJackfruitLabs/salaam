// The tool activity of a stopped attempt, as the operator-MCP rules allow it: every tool a known
// top-level one, every one closed before the stop, and each journaled operator MCP call inside an
// open operator MCP tool that has no call yet. Tools may run in parallel, and a call does not
// name its tool, so a call with no such free tool is refused.
import type { Row } from './rule.js';

/** What the activity is checked against. */
export interface ToolBounds {
  /** The attempt every tool event must belong to. */
  attempt: unknown;
  /** No tool event at or after this seq. */
  before: number;
  /** No tool started at or after this seq, when set. */
  startedBefore?: number;
  /** The tools that may start. */
  tools: string[];
  /** The outcomes an operator MCP call may have. */
  outcomes: string[];
}

/** The operator MCP calls, each with its event seq, or null when the activity is not closed. */
export function operatorMcpCalls(events: Row[], bounds: ToolBounds): Row[] | null {
  const of = (e: Row) => JSON.parse(String(e.payload));
  const calls: Row[] = [];
  const open = new Map<string, { tool: string; calls: number }>();
  for (const e of events) {
    if (!['tool.started', 'tool.finished', 'operator_mcp.call'].includes(String(e.kind))) continue;
    const payload = of(e);
    if (Number(e.seq) >= bounds.before || payload.attempt_id !== bounds.attempt) return null;
    if (e.kind === 'tool.started') {
      if (
        (bounds.startedBefore !== undefined && Number(e.seq) >= bounds.startedBefore) ||
        !bounds.tools.includes(String(payload.tool)) ||
        typeof payload.tool_call_id !== 'string' ||
        !payload.tool_call_id ||
        payload.parent_tool_call_id
      )
        return null;
      open.set(payload.tool_call_id, { tool: String(payload.tool), calls: 0 });
    } else if (e.kind === 'tool.finished') {
      const started = open.get(String(payload.tool_call_id));
      if (!started || payload.tool !== started.tool) return null;
      open.delete(String(payload.tool_call_id));
    } else {
      const free = [...open.values()].find(
        (t) => t.tool === 'salaam_operator_mcp' && t.calls === 0,
      );
      if (!free || !bounds.outcomes.includes(String(payload.outcome))) return null;
      free.calls++;
      calls.push({ seq: e.seq, ...payload });
    }
  }
  if (open.size) return null;
  return calls;
}
