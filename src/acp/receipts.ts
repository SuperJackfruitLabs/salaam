// Receipts an editor asked for: a prompt's state as its attempt settles, and each turn
// cancellation's state as the service confirms it. Each is sent once per change.
import { randomUUID } from 'node:crypto';
import { call, type Attempt } from '../core/index.js';
import type { CancellationReceipt } from '../runtime/index.js';
import { controller, update, type AcpContext, type Connection } from './context.js';

export async function promptReceipt(
  ctx: AcpContext,
  session: string,
  request: string,
  attemptId: string,
): Promise<void> {
  if (!ctx.bound || !ctx.wantsReceipts) return;
  const attempt = await call<Attempt>(ctx.socket, `/v1/attempts/${attemptId}`);
  const state =
    attempt.state === 'completed' && attempt.outcome?.stopReason === 'end_turn'
      ? 'completed'
      : ['interrupted', 'failed', 'cancelled', 'completed'].includes(attempt.state)
        ? 'interrupted'
        : 'accepted';
  const connection = ctx.sessions.get(session);
  if (connection?.promptStates.get(request) === state) return;
  connection?.promptStates.set(request, state);
  await update(ctx, session, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '' },
    _meta: {
      'salaam.dev/promptReceipt': { sessionId: session, requestId: request, attemptId, state },
    },
  });
}

export async function cancellationReceipt(
  ctx: AcpContext,
  c: Connection,
  receipt: CancellationReceipt,
): Promise<void> {
  const value = JSON.stringify(receipt);
  if (c.cancellations.get(receipt.requestId) === value) return;
  c.cancellations.set(receipt.requestId, value);
  if (ctx.wantsCancellations)
    await update(ctx, c.id, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { 'salaam.dev/cancellationReceipt': receipt },
    });
}

export async function cancellationReceipts(ctx: AcpContext, c: Connection): Promise<void> {
  for (const receipt of await call<CancellationReceipt[]>(
    ctx.socket,
    `/v1/sessions/${c.id}/cancellations`,
  ))
    await cancellationReceipt(ctx, c, receipt);
}

/** Cancel a session's turn: the active prompt unless another is named. */
export async function cancel(
  ctx: AcpContext,
  c: Connection,
  request: string = randomUUID(),
  target: string | null = c.activePrompts.keys().next().value ?? null,
): Promise<void> {
  const actor = await controller(ctx, c);
  const receipt = await call<CancellationReceipt>(
    ctx.socket,
    `/v1/sessions/${c.id}/cancellations`,
    {
      ...actor,
      request_id: request,
      target_request_id: target,
    },
  );
  await cancellationReceipt(ctx, c, receipt);
}
