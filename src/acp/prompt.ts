// session/prompt: one turn, journaled before dispatch, followed until its attempt settles, and
// answered with a typed stop or failure.
import { randomUUID } from 'node:crypto';
import {
  acpFailure,
  AcpFailureError,
  call,
  object,
  ServiceError,
  string,
  type Attempt,
} from '../core/index.js';
import { controller, snapshot, type AcpContext, type Connection, type Json } from './context.js';
import { parseDeskCommand } from './desk.js';
import { rewind } from './desk-session.js';
import { promptReceipt } from './receipts.js';
import { refresh } from './refresh.js';

/** The longest text block a prompt may carry. */
const PROMPT_TEXT_LIMIT = 256 * 1024;
/** How often a running turn's attempt is checked. */
const TURN_POLL_MS = 75;

/** The prompt's content blocks as the text the model receives. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt) || !prompt.length) throw new Error('Prompt content required');
  return prompt
    .map((value) => {
      const block = object(value);
      if (block.type === 'text') return string(block.text, 'text', PROMPT_TEXT_LIMIT);
      if (block.type === 'resource_link')
        return `Resource reference ${string(block.name, 'name')}: ${string(block.uri, 'uri')}`;
      throw new Error('Only text and resource links are supported');
    })
    .join('\n');
}

export async function prompt(ctx: AcpContext, c: Connection, params: Json): Promise<unknown> {
  const input = promptText(params.prompt);
  const command = c.desk ? parseDeskCommand(input) : null;
  if (command) {
    // Handled here, never sent to the model.
    await rewind(ctx, c, command.turn);
    return { stopReason: 'end_turn' };
  }
  const meta = object(params._meta ?? {});
  const logical =
    meta['salaam.dev/requestId'] === undefined
      ? randomUUID()
      : string(meta['salaam.dev/requestId'], 'requestId', 128);
  if (c.activePrompts.size && !c.activePrompts.has(logical))
    throw new ServiceError('worker_busy', 'A prompt is already active on this transport');
  c.activePrompts.set(logical, (c.activePrompts.get(logical) ?? 0) + 1);
  try {
    const actor = await controller(ctx, c, meta['salaam.dev/takeover'] === true);
    await call(ctx.socket, `/v1/sessions/${c.id}/resume`, actor);
    const view = await snapshot(ctx, c.id);
    const record = ctx.journal.prepare(
      c.id,
      logical,
      input,
      view.revision,
      meta['salaam.dev/continuesAttemptId'] === undefined
        ? undefined
        : string(meta['salaam.dev/continuesAttemptId'], 'continuesAttemptId', 128),
    );
    const accepted = await ctx.journal.dispatch(ctx.socket, record, actor);
    await promptReceipt(ctx, c.id, logical, accepted.attempt_id);
    while (!ctx.closed) {
      if (c.failed) throw c.failed;
      const attempt = await call<Attempt>(ctx.socket, `/v1/attempts/${accepted.attempt_id}`);
      await refresh(ctx, c);
      if (!['accepted', 'dispatching', 'running'].includes(attempt.state)) {
        await promptReceipt(ctx, c.id, logical, accepted.attempt_id);
        return settled(ctx, c, logical, attempt);
      }
      await new Promise((resolve) => setTimeout(resolve, TURN_POLL_MS));
    }
    return { stopReason: 'cancelled' }; // Transport closed; no service cancellation is issued.
  } catch (error) {
    throw new AcpFailureError(acpFailure(error, { sessionId: c.id, requestId: logical }));
  } finally {
    const count = (c.activePrompts.get(logical) ?? 1) - 1;
    if (count) c.activePrompts.set(logical, count);
    else c.activePrompts.delete(logical);
  }
}

/** The answer to a turn whose attempt has settled. */
function settled(ctx: AcpContext, c: Connection, logical: string, attempt: Attempt): Json {
  const context = { sessionId: c.id, requestId: logical, attemptId: attempt.id };
  const failure = attempt.outcome?.failure;
  if (
    attempt.state === 'interrupted' ||
    (attempt.state === 'failed' &&
      ((ctx.bound && !ctx.wantsTypedStops) ||
        !['refusal', 'max_tokens'].includes(attempt.outcome?.stopReason ?? '')))
  )
    throw new AcpFailureError(
      failure
        ? { ...failure, ...context }
        : acpFailure(
            new ServiceError('attempt_interrupted', attempt.error ?? 'Attempt did not complete'),
            context,
          ),
    );
  if (attempt.state === 'completed' && !attempt.outcome)
    throw new AcpFailureError(
      acpFailure(
        new ServiceError(
          'legacy_outcome_unverified',
          'This saved turn predates typed outcomes; inspect its history before starting new work',
        ),
        context,
      ),
    );
  return {
    stopReason:
      attempt.state === 'cancelled' ? 'cancelled' : (attempt.outcome?.stopReason ?? 'end_turn'),
    _meta: {
      'salaam.dev/requestId': logical,
      'salaam.dev/attemptId': attempt.id,
      ...(failure ? { 'salaam.dev/failure': { ...failure, ...context } } : {}),
    },
  };
}
