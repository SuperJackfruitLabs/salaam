import { matchesKey } from '@earendil-works/pi-tui';
import type { RewindMode } from '../../runtime/index.js';
import { REVIEW_KEYS } from '../keymap.js';
import { rewindItems, rewindSummary } from '../review.js';
import type { TabContext } from './context.js';

// The Changes tab of a local coding session (per-file review against the review base) and
// /rewind, which restores files or the conversation to before an earlier turn.

export async function loadReview(
  ctx: TabContext,
  file = ctx.view.review?.file ?? 0,
): Promise<void> {
  const id = ctx.client.snapshot?.id;
  const data = await ctx.client.changeReview();
  if (ctx.client.snapshot?.id !== id) return;
  const index = data?.files.length ? Math.min(Math.max(0, file), data.files.length - 1) : 0;
  const path = data?.files[index]?.path;
  const hunks = data && path ? await ctx.client.changeHunks(data, path) : undefined;
  ctx.view.review = { data, file: index, hunks, hunk: -1 };
  ctx.document.invalidate();
  ctx.tui.requestRender();
}
/** Changes-tab keys: alt+left/right file, alt+up/down hunk; with an empty editor, a accepts,
 * r reverts and i starts a follow-up instruction about the selection. */
export function reviewKey(ctx: TabContext, data: string): { consume: true } | undefined {
  const review = ctx.view.review;
  if (!review?.data?.files.length) return;
  const file = review.data.files[review.file]!;
  if (
    matchesKey(data, REVIEW_KEYS.nextFile.key) ||
    matchesKey(data, REVIEW_KEYS.previousFile.key)
  ) {
    const next = review.file + (matchesKey(data, REVIEW_KEYS.nextFile.key) ? 1 : -1);
    if (next >= 0 && next < review.data.files.length) void ctx.execute(() => loadReview(ctx, next));
    return { consume: true };
  }
  if (
    matchesKey(data, REVIEW_KEYS.nextHunk.key) ||
    matchesKey(data, REVIEW_KEYS.previousHunk.key)
  ) {
    const count = review.hunks?.length ?? 0;
    review.hunk = Math.max(
      -1,
      Math.min(count - 1, review.hunk + (matchesKey(data, REVIEW_KEYS.nextHunk.key) ? 1 : -1)),
    );
    ctx.document.invalidate();
    ctx.tui.requestRender();
    return { consume: true };
  }
  if (ctx.editor.getExpandedText() !== '') return;
  const hunk = review.hunk >= 0 ? review.hunks?.[review.hunk] : undefined;
  const what = file.path + (hunk ? ` (hunk ${review.hunk + 1})` : '');
  const act = (action: 'accept' | 'revert') => async () => {
    const data = await ctx.client.changeAct(review.data!, action, file.path, hunk);
    ctx.view.review = { data, file: review.file, hunk: -1 };
    await loadReview(ctx, review.file);
    ctx.client.report((action === 'accept' ? 'Accepted ' : 'Reverted ') + what + '.');
  };
  if (data === REVIEW_KEYS.accept.key) {
    void ctx.execute(act('accept'));
    return { consume: true };
  }
  if (data === REVIEW_KEYS.revert.key) {
    ctx.confirm(
      'Revert ' + what,
      (hunk ? 'Puts this hunk back' : 'Puts this file back') +
        ' the way it was at the review base. Only the reviewed version is written; if the file changed since, nothing is written and you review again.',
      'Revert',
      act('revert'),
    );
    return { consume: true };
  }
  if (data === REVIEW_KEYS.instruct.key) {
    ctx.setTab('conversation');
    ctx.editor.setText(
      `In ${file.path}${hunk ? ` (the change at ${hunk.text.split('\n')[0]})` : ''}: `,
    );
    return { consume: true };
  }
  return;
}
/** /rewind [turn]: choose a turn and what to restore, review, then confirm once. */
export async function rewind(ctx: TabContext, args: string): Promise<void> {
  const points = await ctx.client.checkpoints();
  if (!points.length)
    throw new Error(
      'No turn has been checkpointed in this session yet. A checkpoint is taken as each turn starts.',
    );
  const choose = (attempt: string) =>
    ctx.choice(
      'Rewind · what to restore',
      [
        {
          value: 'both',
          label: 'Files and conversation',
          description: 'Restore files and continue from before this turn in a new session',
        },
        {
          value: 'files',
          label: 'Files only',
          description: 'Restore files; keep the conversation',
        },
        {
          value: 'conversation',
          label: 'Conversation only',
          description: 'Continue from before this turn in a new session; files stay',
        },
      ],
      (mode) =>
        void ctx.execute(async () => {
          const review = await ctx.client.rewindReview(attempt, mode as RewindMode);
          ctx.confirm(
            `Rewind to before turn ${review.turn}`,
            rewindSummary(review),
            'Rewind',
            async () => {
              const text = await ctx.client.rewind(review);
              if (review.mode !== 'files') ctx.editor.setText(text);
            },
          );
        }),
    );
  if (args) {
    const found = points.find((p) => String(p.turn) === args.trim());
    if (!found) throw new Error(`No checkpoint for turn ${args.trim()}. /rewind lists them.`);
    choose(found.attempt_id);
    return;
  }
  ctx.choice('Rewind to before which turn?', rewindItems(points), choose);
}
