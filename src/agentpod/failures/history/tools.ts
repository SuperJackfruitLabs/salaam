// The tools of the historical read-only check: every tool started was finished once (but the
// boundary write's), each by an attempt of the run, and each was a closed read: an admitted MCP
// read or catalog, a delegated child, a child inspection or result, or the probe.
import { canonical, digest, textDigest } from '../../../core/index.js';
import { mcpAdmissionView } from '../../../mcp/index.js';
import type { Row } from '../rule.js';
import type { McpHistory } from './ledgers.js';
import type { AppliedPatch, History, HistoryRun, Unapplied } from './context.js';

/** What a tool start is checked against. */
interface ToolJournal {
  run: HistoryRun;
  mcp: Row[];
  assigned: Row[];
  tools: Row[];
  matchedChildren: Set<string>;
  unapplied: Unapplied | null;
  appliedCall: Row | null;
}

/** Every tool start and finish, paired, and every child delegated by exactly one start. */
export function closedTools(
  h: History,
  run: HistoryRun,
  mcpHistory: McpHistory,
  unapplied: Unapplied | null,
  appliedPatch: AppliedPatch | null,
): void {
  const { require, rows, session } = h;
  const { children, sessions, marks } = run;
  const { mcp, assigned } = mcpHistory;
  const appliedCall = appliedPatch?.call ?? null;
  const tools = rows(
    'tools',
    `SELECT * FROM events WHERE session_id IN (${marks}) AND kind IN ('tool.started','tool.finished') ORDER BY seq`,
    ...sessions,
  );
  const starts = tools.filter((e) => e.kind === 'tool.started');
  require(tools.length === starts.length * 2 - (unapplied ? 1 : 0));
  require(
    !appliedCall ||
      starts.filter((e) => {
        const p = JSON.parse(String(e.payload));
        return (
          e.session_id === session &&
          p.attempt_id === appliedCall.attempt_id &&
          p.tool_call_id === appliedCall.tool_call_id
        );
      }).length === 1,
  );
  const matchedChildren = new Set<string>();
  require(
    mcp.every((c) =>
      starts.some((e) => {
        const p = JSON.parse(String(e.payload));
        return (
          e.session_id === c.session_id &&
          p.tool === 'salaam_mcp' &&
          JSON.parse(p.input).action === 'call' &&
          p.attempt_id === c.attempt_id &&
          p.worker_epoch === c.worker_epoch &&
          p.tool_call_id === c.tool_call_id
        );
      }),
    ),
  );
  for (const start of starts) {
    toolStart(h, { run, mcp, assigned, tools, matchedChildren, unapplied, appliedCall }, start);
  }
  require(matchedChildren.size === children.length);
  require(
    !unapplied ||
      starts.filter((e) => {
        const p = JSON.parse(String(e.payload));
        return (
          e.session_id === session &&
          p.attempt_id === unapplied.attempt &&
          p.tool_call_id === unapplied.tool
        );
      }).length === 1,
  );
}

/** One tool start: owned by a run attempt, finished once, and a tool this history allows. */
function toolStart(h: History, journal: ToolJournal, start: Row): void {
  const { require, session } = h;
  const { run, tools, unapplied, appliedCall } = journal;
  const { attempts } = run;
  const p = JSON.parse(String(start.payload)),
    owner = attempts.find(
      (a) =>
        a.id === p.attempt_id &&
        a.session_id === start.session_id &&
        a.worker_epoch === p.worker_epoch,
    );
  const ends = tools.filter((e) => {
    const q = JSON.parse(String(e.payload));
    return (
      e.kind === 'tool.finished' &&
      e.session_id === start.session_id &&
      q.attempt_id === p.attempt_id &&
      q.worker_epoch === p.worker_epoch &&
      q.tool_call_id === p.tool_call_id &&
      q.tool === p.tool &&
      q.failed === false &&
      Number(e.seq) > Number(start.seq)
    );
  });
  require(
    owner &&
      typeof p.tool_call_id === 'string' &&
      p.tool_call_id &&
      (unapplied && p.attempt_id === unapplied.attempt && p.tool_call_id === unapplied.tool
        ? ends.length === 0
        : ends.length === 1) &&
      !p.input_truncated &&
      typeof p.input === 'string' &&
      textDigest(p.input) === p.input_digest,
  );
  if (unapplied && p.attempt_id === unapplied.attempt && p.tool_call_id === unapplied.tool) {
    require(
      start.session_id === session &&
        p.worker_epoch === unapplied.call.worker_epoch &&
        p.tool === 'salaam_station' &&
        canonical(JSON.parse(p.input)) === unapplied.call.args_json,
    );
  } else if (
    appliedCall &&
    p.attempt_id === appliedCall.attempt_id &&
    p.tool_call_id === appliedCall.tool_call_id
  ) {
    require(
      start.session_id === session &&
        p.worker_epoch === appliedCall.worker_epoch &&
        p.tool === 'salaam_station' &&
        canonical(JSON.parse(p.input)) === appliedCall.args_json,
    );
  } else if (p.tool === 'salaam_mcp') mcpStart(h, journal, start, p);
  else if (p.tool === 'spawn_child') spawnStart(h, journal, start, p);
  else if (p.tool === 'inspect_child' || p.tool === 'consume_child_result')
    childToolStart(h, journal, start, p);
  else probeStart(h, p);
}

/** salaam_mcp: an admitted catalog read, or exactly one journaled read call. */
function mcpStart(h: History, journal: ToolJournal, start: Row, p: Row): void {
  const { require, session, root } = h;
  const { mcp, assigned } = journal;
  const input = JSON.parse(p.input);
  const call =
    input.action === 'call' &&
    mcp.some(
      (c) =>
        c.session_id === start.session_id &&
        c.attempt_id === p.attempt_id &&
        c.tool_call_id === p.tool_call_id,
    );
  const catalog =
    input.action === 'catalog' &&
    start.session_id === session &&
    Object.keys(input).every((k) => ['action', 'server', 'tool'].includes(k)) &&
    assigned.some((e) => {
      if (e.session_id !== session) return false;
      const v = mcpAdmissionView(JSON.parse(String(e.payload)));
      return (
        v.binding_digest === root &&
        (input.server === undefined
          ? input.tool === undefined
          : v.servers.some(
              (server) =>
                server.name === input.server &&
                (input.tool === undefined || server.tools.some((t) => t.name === input.tool)),
            ))
      );
    });
  require(
    catalog ||
      (call &&
        mcp.some(
          (c) =>
            c.session_id === start.session_id &&
            c.attempt_id === p.attempt_id &&
            c.tool_call_id === p.tool_call_id &&
            canonical(JSON.parse(p.input)) ===
              canonical({
                action: 'call',
                server: c.server_name,
                tool: c.tool_name,
                arguments: JSON.parse(String(c.arguments_json)),
              }),
        )),
  );
}

/** spawn_child: probe-only children, each matched to one child task. */
function spawnStart(h: History, journal: ToolJournal, start: Row, p: Row): void {
  const { require, session } = h;
  const { run, matchedChildren } = journal;
  const { children } = run;
  require(start.session_id === session);
  const input = JSON.parse(p.input),
    authority = input.authority ?? ['salaam_probe'],
    budget = input.budget ?? 2;
  require(!input.profile && canonical(authority) === canonical(['salaam_probe']));
  const tasks = input.tasks ?? [{ step_key: input.step_key ?? '', prompt: input.prompt ?? '' }];
  require(Array.isArray(tasks) && tasks.length > 0 && tasks.length <= 2);
  for (const t of tasks) {
    const child = children.find(
      (c) =>
        c.parent_attempt === p.attempt_id &&
        c.step_key === t.step_key &&
        c.budget === budget &&
        c.input_digest === digest({ prompt: t.prompt, budget, requested: authority }),
    );
    require(child);
    matchedChildren.add(String(child!.id));
  }
}

/** inspect_child and consume_child_result, on this run's own children. */
function childToolStart(h: History, journal: ToolJournal, start: Row, p: Row): void {
  const { require, session } = h;
  const { run } = journal;
  const { children } = run;
  require(start.session_id === session);
  const input = JSON.parse(p.input);
  if (p.tool === 'inspect_child')
    require(
      canonical(input) ===
        canonical(input.child_id === undefined ? {} : { child_id: input.child_id }) &&
        (input.child_id === undefined || children.some((c) => c.id === input.child_id)),
    );
  else
    require(
      children.some((c) => c.id === input.child_id && c.result_id === input.result_id) &&
        Object.keys(input).every((k) => ['child_id', 'result_id', 'acknowledge'].includes(k)) &&
        (input.acknowledge === undefined || typeof input.acknowledge === 'boolean'),
    );
}

/** Anything else is the probe, with at most its nested flag. */
function probeStart(h: History, p: Row): void {
  const { require } = h;
  require(p.tool === 'salaam_probe');
  const input = JSON.parse(p.input);
  require(
    Object.keys(input).every((k) => k === 'nested') &&
      (input.nested === undefined || typeof input.nested === 'boolean'),
  );
}
