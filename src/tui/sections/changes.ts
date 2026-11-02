import { wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { commandTerminal, workspaceDiff, type SessionSnapshot } from '../../core/index.js';
import type { OperatorClient } from '../client.js';
import { backgroundNote, changeCounts } from '../review.js';
import { safeText, shortId } from '../theme.js';
import type { DocumentBlocks } from './blocks.js';

// The Changes and Commands tabs: a local coding session's per-file review and recorded commands,
// and a coding workspace's guarded diff and isolated commands.

export function reviewLines(doc: DocumentBlocks, width: number): string[] {
  const t = doc.view.theme,
    review = doc.view.review,
    lines = doc.title('CHANGES SINCE REVIEW', width);
  if (!review) return [...lines, ...doc.text('Loading changes…', width)];
  if (!review.data)
    return [
      ...lines,
      ...doc.text(
        'Changes appear here after the first turn starts; each turn is checkpointed.',
        width,
      ),
    ];
  const note = backgroundNote(review.data.background_running);
  if (note) lines.push(...doc.text(note, width));
  if (!review.data.files.length)
    return [
      ...lines,
      ...doc.text('Nothing to review: the folder matches what you accepted.', width),
    ];
  review.data.files.forEach((change, i) => {
    const mark = i === review.file ? '▸ ' : '  ';
    lines.push(
      t.line(
        mark +
          safeText(change.path) +
          '  ' +
          t.ink(change.status + ' · ' + changeCounts(change), 'muted'),
        width,
      ),
    );
  });
  lines.push(t.fill('', width));
  const file = review.data.files[review.file]!;
  const hunks = review.hunks ?? [];
  lines.push(
    ...doc.title(
      safeText(file.path) +
        (review.hunk >= 0 ? ` · hunk ${review.hunk + 1} of ${hunks.length}` : ' · whole file'),
      width,
    ),
  );
  if (!hunks.length) lines.push(...doc.text('No text diff to show for this file.', width));
  hunks.forEach((hunk, i) => {
    const selected = i === review.hunk;
    lines.push(
      ...t
        .highlight(safeText(hunk.text).replace(/\n$/, ''), 'diff')
        .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 4)))
        .map((line) => t.line((selected ? '┃ ' : review.hunk >= 0 ? '  ' : '') + line, width)),
    );
  });
  lines.push(
    t.fill('', width),
    t.line(
      t.key('alt+←/→', 'file') +
        '   ' +
        t.key('alt+↑/↓', 'hunk') +
        '   ' +
        t.key('a', 'accept') +
        '   ' +
        t.key('r', 'revert') +
        '   ' +
        t.key('i', 'instruct'),
      width,
    ),
    ...doc.text(
      'a/r/i work while the message box is empty. Accept marks a change reviewed; revert writes the reviewed base back. /rewind returns to before any turn.',
      width,
    ),
  );
  return lines;
}
/** A local coding session's recorded commands, newest first. */
export function localCommandLines(
  doc: DocumentBlocks,
  s: SessionSnapshot,
  width: number,
): string[] {
  const t = doc.view.theme;
  const lines: string[] = [];
  const operations = s.operations.filter(
    (op) => op.kind === 'workspace' && op.target.startsWith('Local command:'),
  );
  lines.push(...doc.title('LOCAL COMMAND RESULTS', width));
  if (!operations.length)
    lines.push(
      ...doc.text(
        'Commands appear here with their recorded exit status and output. ' +
          (doc.view.mode?.sandbox
            ? 'Where commands run: ' + doc.view.mode.sandbox + '.'
            : 'Commands run as your local user.'),
        width,
      ),
    );
  for (const op of operations.slice().reverse()) {
    lines.push(
      t.rule(width),
      ...doc.title(
        shortId(op.id) + ' · ' + op.state,
        width,
        op.state === 'succeeded' ? 'jade' : 'amber',
      ),
      ...doc.text(op.value, width),
    );
    if (op.receipt)
      lines.push(...doc.title('RECORDED RESULT', width), ...doc.text(op.receipt, width));
    if (op.error) lines.push(...doc.text(op.error, width));
  }
  lines.push(
    ...doc.text(
      'Ctrl+O reviews pending approvals. Cancel current work from Ctrl+K stops the active foreground command. These are saved operation records, not a live Git diff.',
      width,
    ),
  );
  return lines;
}
/** A coding workspace's checked diff against the original checkout. */
export function workspaceLines(
  doc: DocumentBlocks,
  w: NonNullable<OperatorClient['workspace']>,
  width: number,
): string[] {
  const t = doc.view.theme;
  const lines: string[] = [];
  lines.push(
    ...doc.title('WORKSPACE CHANGES', width),
    ...doc.text('Original checkout: ' + w.source, width),
    ...doc.text(
      'Workspace ' + shortId(w.id) + ' · revision ' + w.revision + ' · ' + shortId(w.digest),
      width,
    ),
    t.fill('', width),
  );
  if (!doc.view.diff) lines.push(...doc.text('Loading the checked diff…', width));
  else if (!doc.view.diff.changes.length)
    lines.push(...doc.text('No changes yet. Your original checkout is unchanged.', width));
  else
    for (const change of doc.view.diff.changes) {
      lines.push(...doc.title(safeText(change.path), width));
      const patch = workspaceDiff(change);
      const painted = t
        .highlight(patch, 'diff')
        .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 4)))
        .map((line) => t.line(line, width));
      lines.push(
        ...painted,
        t.fill('', width),
        t.line(
          t.key('alt+left', 'previous file') + '    ' + t.key('alt+right', 'next file'),
          width,
        ),
      );
    }
  if (w.observed_digest !== w.digest)
    lines.push(
      ...doc.title('Human edits detected', width, 'amber'),
      ...doc.text('Review and refresh the exact observed workspace before continuing.', width),
    );
  return lines;
}
/** A coding workspace's isolated commands, newest first, and the output being read. */
export function commandLines(doc: DocumentBlocks, width: number): string[] {
  const { client: c, theme: t } = doc.view;
  const lines: string[] = [];
  lines.push(...doc.title('COMMANDS', width));
  if (!c.commands.length)
    lines.push(
      ...doc.text(
        c.health?.execution?.commands
          ? 'Commands will appear here with their actual exit status and captured revision.'
          : 'Command execution is off for this service.',
        width,
      ),
    );
  for (const run of [...c.commands].reverse()) {
    const role =
      run.state === 'succeeded'
        ? 'jade'
        : ['running', 'accepted'].includes(run.state)
          ? 'amber'
          : run.state === 'failed' || run.state === 'outcome_unknown'
            ? 'red'
            : 'muted';
    lines.push(
      t.line(
        t.ink(run.state === 'succeeded' ? '✓ ' : commandTerminal(run.state) ? '· ' : '◌ ', role) +
          t.ink(safeText(run.command)),
        width,
      ),
      t.line(
        t.ink(
          '  ' +
            run.state +
            ' · ' +
            shortId(run.id) +
            ' · r' +
            run.workspace_revision +
            (run.exit_code === null ? '' : ' · exit ' + run.exit_code),
          'muted',
        ),
        width,
      ),
    );
    if (run.error) lines.push(...doc.text(run.error, width));
    lines.push(t.fill('', width));
  }
  if (doc.view.log) {
    lines.push(
      t.rule(width),
      ...doc.title('OUTPUT · ' + shortId(doc.view.log.id), width),
      ...doc.text(doc.view.log.text || '(No captured output yet.)', width),
      ...doc.text(
        doc.view.log.complete
          ? 'End of captured output.'
          : 'Live output · byte offset ' + doc.view.log.offset,
        width,
      ),
    );
  }
  lines.push(t.fill('', width), ...doc.text('ctrl+k → Command logs or Cancel a command', width));
  return lines;
}
