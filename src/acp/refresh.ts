// Keeping the editor current with a session: its feed of events, and a refresh that sends what
// changed (history, receipts, approvals, inbox, operation states, the task plan).
import { call, planUpdate, toolMetadata, toolTitle, type SessionSnapshot } from '../core/index.js';
import type { LocalEdit } from '../local/index.js';
import { subscribe } from '../tui/index.js';
import { approvals } from './approvals.js';
import { snapshot, update, type AcpContext, type Connection, type Json } from './context.js';
import { editDiffs } from './desk.js';
import { deskState } from './desk-session.js';
import { replay } from './history.js';
import { cancellationReceipts, promptReceipt } from './receipts.js';

/** How long a dropped feed waits before it reconnects. */
const RESUBSCRIBE_MS = 250;
/** Events after which the session is refreshed. */
const REFRESHING_EVENTS = [
  'inbox.changed',
  'inbox.resolved',
  'inbox.acknowledged',
  'transcript.synced',
  'approval.requested',
  'approval.decided',
  'operation.succeeded',
  'operation.outcome_unknown',
  'turn.cancel_requested',
  'turn.cancel_status',
  'attempt.cancelled',
  'attempt.failed',
  'attempt.interrupted',
  'attempt.completed',
];

/** Send the session's durable task plan when it differs from the last one sent. */
export async function sendPlan(
  ctx: AcpContext,
  c: Connection,
  task?: SessionSnapshot['work_task'],
): Promise<void> {
  const plan = planUpdate(task === undefined ? (await snapshot(ctx, c.id)).work_task : task);
  const key = plan ? JSON.stringify(plan) : undefined;
  if (!plan || key === c.plan) return;
  c.plan = key;
  await update(ctx, c.id, plan as unknown as Json);
}

export function refresh(ctx: AcpContext, c: Connection): Promise<void> {
  c.dirty = true;
  if (c.refresh) return c.refresh;
  c.refresh = (async () => {
    while (c.dirty && !ctx.closed) {
      c.dirty = false;
      await refreshOnce(ctx, c);
    }
  })().finally(() => {
    delete c.refresh;
  });
  return c.refresh;
}

async function refreshOnce(ctx: AcpContext, c: Connection): Promise<void> {
  const view = await snapshot(ctx, c.id);
  await replay(ctx, c, true);
  if (ctx.wantsCancellations || c.cancellations.size) await cancellationReceipts(ctx, c);
  if (ctx.bound && ctx.wantsReceipts)
    for (const record of ctx.journal.records(c.id)) {
      if (
        record.receipt &&
        !['completed', 'interrupted'].includes(c.promptStates.get(record.request_id) ?? '')
      )
        await promptReceipt(ctx, c.id, record.request_id, record.receipt.attempt_id);
    }
  await approvals(ctx, c, view, (x) => refresh(ctx, x));
  const inbox = JSON.stringify(view.inbox ?? []);
  if (c.inboxDigest !== inbox && (inbox !== '[]' || c.inboxDigest !== undefined)) {
    c.inboxDigest = inbox;
    await update(ctx, c.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Salaam operator inbox: ' + inbox },
      _meta: { 'salaam.dev/inbox': view.inbox ?? [] },
    });
  }
  delete c.failed;
  for (const op of view.operations) {
    const status =
      op.state === 'succeeded'
        ? 'completed'
        : ['failed_definite', 'cancelled_before_dispatch', 'outcome_unknown'].includes(op.state)
          ? 'failed'
          : 'in_progress';
    if (c.operations.get(op.id) !== status) {
      c.operations.set(op.id, status);
      await update(ctx, c.id, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'salaam-operation:' + op.id,
        title: op.kind + ': ' + op.target,
        status,
      });
    }
  }
}

interface ToolEvent {
  tool_call_id?: string;
  parent_tool_call_id?: string;
  tool?: string;
  input?: string;
  failed?: boolean;
  output?: string;
  kind?: string;
  locations?: unknown[];
}

/** A tool's start or finish, as the editor's tool call. */
function toolEvent(ctx: AcpContext, c: Connection, started: boolean, p: ToolEvent): void {
  if (typeof p.tool_call_id !== 'string') return;
  const fresh = !c.liveTools.has(p.tool_call_id);
  c.liveTools.add(p.tool_call_id);
  const callId = p.tool_call_id;
  // A finished edit in your own session shows as a diff, whichever mode applied it.
  const diffs =
    !started && !p.failed && c.desk && p.tool === 'salaam_local'
      ? call<{ root: string; edits: LocalEdit[] } | null>(
          ctx.socket,
          `/v1/sessions/${c.id}/local-edits?tool_call=${encodeURIComponent(callId)}`,
        )
          .then((found) => (found ? editDiffs(found.root, found.edits) : []))
          .catch(() => [])
      : Promise.resolve([]);
  void diffs
    .then(async (diff) =>
      update(ctx, c.id, {
        sessionUpdate: started && fresh ? 'tool_call' : 'tool_call_update',
        toolCallId: p.tool_call_id,
        title: p.tool ? toolTitle(p.tool, p.input) : 'Tool',
        ...(started
          ? {
              kind: p.kind ?? toolMetadata(p.tool ?? '', p.input).kind,
              locations: p.locations ?? [],
            }
          : {}),
        status: started ? 'in_progress' : p.failed ? 'failed' : 'completed',
        ...(started && p.input ? { rawInput: p.input } : {}),
        ...(!started && (p.output || diff.length)
          ? {
              content: [
                ...diff,
                ...(p.output
                  ? [{ type: 'content', content: { type: 'text', text: p.output } }]
                  : []),
              ],
            }
          : {}),
        ...(p.parent_tool_call_id
          ? { _meta: { 'salaam.dev/parentToolCallId': p.parent_tool_call_id } }
          : {}),
      }),
    )
    .catch((error) => {
      c.failed = error;
    });
}

/** Follow a session's events until the transport closes, reconnecting a dropped feed. */
export function watch(ctx: AcpContext, c: Connection): void {
  if (ctx.closed) return;
  const feed = subscribe(ctx.socket, c.id, c.cursor, (event) => {
    c.cursor = event.seq;
    if (event.kind === 'tool.started' || event.kind === 'tool.finished')
      toolEvent(ctx, c, event.kind === 'tool.started', event.payload as ToolEvent);
    if (event.kind === 'permissions.configured' && c.desk)
      void deskState(ctx, c, true).catch((error) => {
        c.failed = error;
      });
    if (event.kind.startsWith('work_task.'))
      void sendPlan(ctx, c).catch((error) => {
        c.failed = error;
      });
    if (REFRESHING_EVENTS.includes(event.kind))
      void refresh(ctx, c).catch((error) => {
        c.failed = error;
      });
  });
  c.feed = feed;
  void feed.done
    .catch(() => {})
    .finally(() => {
      if (!ctx.closed) {
        const retry = setTimeout(() => {
          void refresh(ctx, c)
            .catch((error) => {
              c.failed = error;
            })
            .finally(() => watch(ctx, c));
        }, RESUBSCRIBE_MS);
        retry.unref();
      }
    });
}
