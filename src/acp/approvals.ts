// A session's pending approvals asked in the editor's permission prompt, once each, and the
// person's answer recorded as the operator's decision (or, in your own session, as a rule).
import { randomUUID } from 'node:crypto';
import {
  call,
  object,
  permissionKind,
  type Operation,
  type SessionSnapshot,
} from '../core/index.js';
import { onceOnlyReason, type LocalEdit } from '../local/index.js';
import { Outbox } from '../tui/index.js';
import { askReason, editDiffs } from './desk.js';
import {
  controller,
  say,
  send,
  update,
  type AcpContext,
  type Connection,
  type Json,
} from './context.js';
import { cancel } from './receipts.js';

export async function approvals(
  ctx: AcpContext,
  c: Connection,
  view: SessionSnapshot,
  refresh: (c: Connection) => Promise<void>,
): Promise<void> {
  if (ctx.strictWork) return; // Exact work decisions belong to the durable producer handshake.
  for (const approval of view.approvals.filter((a) => a.state === 'pending')) {
    if (c.permissions.has(approval.id)) continue;
    const op = await call<Operation>(ctx.socket, `/v1/operations/${approval.operation_id}`);
    c.permissions.add(approval.id);
    const id = 'permission:' + randomUUID();
    const value = String(op.value);
    // Your own session can approve for the rest of it, unless the command can never be a rule.
    const sessionRule = !!c.desk?.rules && !onceOnlyReason(value);
    const edits = c.desk
      ? await call<{ root: string; edits: LocalEdit[] } | null>(
          ctx.socket,
          `/v1/sessions/${c.id}/local-edits?operation_id=${encodeURIComponent(op.id)}`,
        ).catch(() => null)
      : null;
    const toolCall = {
      toolCallId: 'salaam-operation:' + op.id,
      title: op.kind + ': ' + op.target,
      kind: edits ? 'edit' : permissionKind(op.kind),
      status: 'pending',
      ...(c.desk
        ? {
            content: [
              {
                type: 'content',
                content: { type: 'text', text: askReason(value, c.desk.policyMode) },
              },
              ...(edits?.edits.length
                ? editDiffs(edits.root, edits.edits)
                : [{ type: 'content', content: { type: 'text', text: value } }]),
            ],
            ...(edits?.edits.length
              ? { locations: editDiffs(edits.root, edits.edits).map((d) => ({ path: d.path })) }
              : {}),
          }
        : {}),
      rawInput: {
        target: op.target,
        value: op.value,
        targetVersion: op.target_version,
        operationDigest: op.operation_digest,
        approvalRevision: approval.revision,
      },
    };
    await update(ctx, c.id, { sessionUpdate: 'tool_call', ...toolCall });
    ctx.permissionReplies.set(id, (result) =>
      answer(ctx, c, approval, op, sessionRule, result, refresh),
    );
    await send(ctx, {
      jsonrpc: '2.0',
      id,
      method: 'session/request_permission',
      params: {
        sessionId: c.id,
        toolCall,
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          ...(sessionRule
            ? [
                {
                  optionId: 'allow-session',
                  name: 'Allow for this session',
                  kind: 'allow_always',
                },
              ]
            : []),
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  }
}

/** The person answered one permission prompt. */
async function answer(
  ctx: AcpContext,
  c: Connection,
  approval: SessionSnapshot['approvals'][number],
  op: Operation,
  sessionRule: boolean,
  result: Json,
  refresh: (c: Connection) => Promise<void>,
): Promise<void> {
  const outcome = object(result.outcome);
  if (outcome.outcome === 'cancelled') {
    if (c.lease) await cancel(ctx, c);
    return;
  }
  if (
    outcome.outcome !== 'selected' ||
    !['allow-once', 'reject-once', ...(sessionRule ? ['allow-session'] : [])].includes(
      String(outcome.optionId),
    )
  )
    throw new Error('Invalid permission outcome');
  if (outcome.optionId === 'allow-session') {
    // The rule is the exact request just reviewed. If it cannot become one, nothing is
    // approved and the request is asked again.
    try {
      await call(ctx.socket, `/v1/sessions/${c.id}/approval-rules`, {
        ...(await controller(ctx, c)),
        request_id: randomUUID(),
        scope: 'session',
        operation_id: op.id,
      });
    } catch (error) {
      await say(
        ctx,
        c.id,
        `Not saved as a rule: ${(error as Error).message} Nothing was approved; it will ask again.`,
      );
      c.permissions.delete(approval.id);
      void refresh(c).catch(() => {});
      return;
    }
  }
  const decide = async () => {
    const outbox = new Outbox(ctx.client, c.id);
    outbox.enqueueDecision(
      approval.id,
      approval.operation_digest,
      approval.revision,
      outcome.optionId === 'reject-once' ? 'deny' : 'approve',
    );
    await outbox.flush(ctx.socket, c.id);
  };
  c.decisions = c.decisions.catch(() => {}).then(decide);
  await c.decisions;
}
