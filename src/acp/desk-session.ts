// Your own local coding session in the editor: its mode picker and /rewind.
import { randomUUID } from 'node:crypto';
import { call, ServiceError } from '../core/index.js';
import type { RewindReview, TurnCheckpoint } from '../runtime/index.js';
import { rewindSummary } from '../tui/index.js';
import {
  checkpointList,
  CONVERSATION_REWIND_NOTE,
  FULL_ACCESS_WARNING,
  modeState,
  policyFor,
  REWIND_CHOICES,
} from './desk.js';
import {
  ask,
  controller,
  permissions,
  say,
  update,
  type AcpContext,
  type Connection,
} from './context.js';

/** The mode picker's state; sent again when the mode changes anywhere, e.g. Shift+Tab in the terminal. */
export async function deskState(ctx: AcpContext, c: Connection, announce = false) {
  if (!c.desk) return {};
  const current = await permissions(ctx, c.id);
  const state = modeState(current);
  const changed = c.desk.mode !== state.modes.currentModeId;
  c.desk.mode = state.modes.currentModeId;
  c.desk.policyMode = current.policy.mode;
  if (announce && changed) {
    await update(ctx, c.id, {
      sessionUpdate: 'current_mode_update',
      currentModeId: state.modes.currentModeId,
    });
    await update(ctx, c.id, {
      sessionUpdate: 'config_option_update',
      configOptions: state.configOptions,
    });
  }
  return state;
}

export async function setMode(ctx: AcpContext, c: Connection, modeId: string) {
  if (!c.desk)
    throw new ServiceError(
      'modes_unavailable',
      'Modes are for your own local coding sessions (salaam acp --local)',
    );
  const current = await permissions(ctx, c.id);
  const next = policyFor(modeId, { full: current.full_access_allowed });
  if (next.access === 'full' && current.policy.access !== 'full') {
    const choice = await ask(ctx, c, 'Turn on full access?', FULL_ACCESS_WARNING, [
      { optionId: 'on', name: 'Turn on full access', kind: 'allow_once' },
      { optionId: 'cancel', name: 'Keep the current mode', kind: 'reject_once' },
    ]);
    if (choice !== 'on') {
      // The picker already moved; put it back.
      c.desk.mode = undefined;
      return deskState(ctx, c, true);
    }
  }
  await call(ctx.socket, `/v1/sessions/${c.id}/permissions`, {
    ...(await controller(ctx, c)),
    request_id: randomUUID(),
    expected_revision: current.policy.revision,
    policy: next,
  });
  return deskState(ctx, c, true);
}

/** /rewind from the editor: list turns, or review one turn's files and restore them on a yes. */
export async function rewind(
  ctx: AcpContext,
  c: Connection,
  turn: number | undefined,
): Promise<void> {
  if (!c.desk) throw new Error('/rewind is for your own local coding sessions.');
  const { checkpoints } = await call<{ checkpoints: TurnCheckpoint[] }>(
    ctx.socket,
    `/v1/sessions/${c.id}/checkpoints`,
  );
  if (turn === undefined) return say(ctx, c.id, checkpointList(checkpoints));
  const point = checkpoints.find((p) => p.turn === turn);
  if (!point) return say(ctx, c.id, `No checkpoint for turn ${turn}. /rewind lists them.`);
  const review = await call<RewindReview>(
    ctx.socket,
    `/v1/sessions/${c.id}/rewind?attempt=${encodeURIComponent(point.attempt_id)}&mode=files`,
  );
  const body =
    rewindSummary(review) +
    (review.background_running
      ? `\n${review.background_running} background command(s) are still running and may write while you decide.`
      : '') +
    '\n\n' +
    CONVERSATION_REWIND_NOTE;
  if (
    (await ask(ctx, c, `Rewind files to before turn ${review.turn}`, body, REWIND_CHOICES)) !==
    'files'
  )
    return say(ctx, c.id, 'Nothing was restored.');
  const result = await call<{ state: string }>(ctx.socket, `/v1/sessions/${c.id}/rewind`, {
    ...(await controller(ctx, c)),
    request_id: randomUUID(),
    attempt_id: review.attempt_id,
    mode: review.mode,
    review_digest: review.digest,
  });
  return say(
    ctx,
    c.id,
    result.state === 'completed'
      ? `Files restored to before turn ${review.turn}. The conversation is kept as it is.`
      : 'Rewind outcome is uncertain; inspect files before continuing.',
  );
}
