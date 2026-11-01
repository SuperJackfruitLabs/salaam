import { relativeTime } from './session-pick.js';
import type { CheckpointChange, CheckpointHunk } from '../runtime/turn-checkpoints.js';
import type { ChangeReview, RewindReview } from '../runtime/turn-rewind.js';

/** The Changes tab of a local coding session: one file selected, optionally one of its hunks. */
export interface ReviewView {
  data: ChangeReview | null;
  file: number;
  hunks?: CheckpointHunk[];
  /** -1 means the whole file. */
  hunk: number;
}

const SHOWN = 12;

/** Background commands may keep writing while a review or rewind is open (operator ruling). */
export function backgroundNote(running: number | undefined): string | null {
  if (!running) return null;
  return running === 1
    ? '1 background task running; its writes may change files. /jobs shows it.'
    : `${running} background tasks running; their writes may change files. /jobs shows them.`;
}

export function changeCounts(change: CheckpointChange): string {
  return change.added === null ? 'binary' : `+${change.added} −${change.removed}`;
}

/** What one confirm of a rewind does, in words. `changes` are from the folder now to the
 * checkpoint, so a file the checkpoint has and the folder lacks is brought back. */
export function rewindSummary(review: RewindReview): string {
  const lines: string[] = [];
  if (review.mode === 'conversation') lines.push('Files are not changed.');
  else if (!review.changes.length) lines.push('Files already match the checkpoint.');
  else {
    lines.push(
      `Files: ${review.changes.length} to put back as they were before turn ${review.turn}.`,
    );
    for (const change of review.changes.slice(0, SHOWN))
      lines.push(
        '  ' +
          (change.status === 'modified'
            ? 'restore '
            : change.status === 'added'
              ? 'bring back '
              : 'remove ') +
          change.path +
          ` (${changeCounts(change)})`,
      );
    if (review.changes.length > SHOWN)
      lines.push(`  … and ${review.changes.length - SHOWN} more files`);
  }
  lines.push(
    review.mode === 'files'
      ? 'The conversation is kept as it is.'
      : `The conversation continues in a new session from before turn ${review.turn}; this session stays as it is, and its instruction comes back to edit.`,
  );
  lines.push('Commands and anything outside this folder are not undone.');
  const note = backgroundNote(review.background_running);
  if (note) lines.push(note);
  return lines.join('\n');
}

/** /rewind's turn list: newest first, with how long ago each turn started. */
export function rewindItems(
  points: readonly { attempt_id: string; turn: number; text: string; at: string }[],
  now = Date.now(),
) {
  return points
    .slice()
    .reverse()
    .map((p) => ({
      value: p.attempt_id,
      label: `Turn ${p.turn} · ${p.text.split('\n')[0]!.slice(0, 80)}`,
      description: relativeTime(p.at, now),
    }));
}
