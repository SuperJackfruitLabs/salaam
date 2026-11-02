import { visibleWidth } from '@earendil-works/pi-tui';
import { typedText, type SessionSnapshot } from '../../core/index.js';
import { safeText } from '../theme.js';
import { toolLines } from '../view-model.js';
import type { DocumentBlocks } from './blocks.js';

// The Conversation tab: the task, the messages with the tool calls that came before each, queued
// input, the live preview, waiting approvals and interrupted work; and the welcome page.

export function welcome(doc: DocumentBlocks, width: number): string[] {
  const { theme: t, client: c } = doc.view;
  const center = (text: string) =>
    t.fill(' '.repeat(Math.max(2, Math.floor((width - visibleWidth(text)) / 2))) + text, width);
  return [
    ...Array.from({ length: Math.max(1, Math.min(4, Math.floor(doc.view.rows() / 8))) }, () =>
      t.fill('', width),
    ),
    center(t.ink('◒', 'jade')),
    t.fill('', width),
    center(t.ink('S A L A A M', 'jade', true)),
    center(t.ink('Your work. A little more peaceful.', 'muted')),
    t.fill('', width),
    t.rule(width),
    t.fill('', width),
    ...doc.text(
      c.snapshot
        ? c.snapshot.capabilities.includes('local-workspace-read')
          ? c.snapshot.capabilities.includes('local-coding-reviewed')
            ? 'Describe a change. Review edits and commands, then check the result.'
            : 'Explore this project. Ask about its files, decisions, or code.'
          : 'Build something thoughtful. Fix something stubborn. Explore an idea.'
        : 'A durable workspace that stays with you, in this terminal or over SSH.',
      width,
    ),
    t.fill('', width),
    t.line(t.key('ctrl+n', 'new session') + '     ' + t.key('ctrl+p', 'recent sessions'), width),
    t.line(t.key('ctrl+k', 'all actions') + '      ' + t.key('alt+g', 'review changes'), width),
    ...(c.snapshot
      ? [
          t.fill('', width),
          t.line(
            t.ink(
              c.workspace
                ? 'Owned coding workspace · guarded edits'
                : c.snapshot.capabilities.includes('local-workspace-read')
                  ? c.snapshot.capabilities.includes('local-coding-reviewed')
                    ? 'Local coding · reviewed edits · commands ' +
                      (doc.view.mode?.sandbox ? '· ' + doc.view.mode.sandbox : 'run as your user')
                    : 'Local workspace · read, list and search · /coding for edits and commands'
                  : 'Conversation session · coding tools are off',
              'muted',
            ),
            width,
          ),
        ]
      : []),
  ];
}
/** Compact lines for tool calls (with their output in the full transcript), children indented. */
export function toolBlock(
  doc: DocumentBlocks,
  calls: ReturnType<typeof toolLines>,
  byKey: Map<string, ReturnType<typeof toolLines>[number]>,
  width: number,
): string[] {
  const t = doc.view.theme,
    lines: string[] = [],
    shown = doc.view.transcript ? calls : calls.slice(-8);
  if (shown.length < calls.length)
    lines.push(
      t.line(
        t.ink(`  … ${calls.length - shown.length} earlier calls · ctrl+x shows all`, 'muted'),
        width,
      ),
    );
  for (const call of shown) {
    let depth = 0,
      parent = call.parent;
    const visited = new Set<string>();
    while (parent && !visited.has(parent) && depth < 4) {
      visited.add(parent);
      depth++;
      parent = byKey.get(parent)?.parent;
    }
    const indent = depth ? '  '.repeat(depth) + '└─ ' : '';
    lines.push(
      t.line(
        t.ink(
          call.state === 'running' ? '◌ ' : call.state === 'failed' ? '× ' : '✓ ',
          call.state === 'failed' ? 'red' : call.state === 'running' ? 'amber' : 'jade',
        ) + t.ink(indent + call.label),
        width,
      ),
    );
    const detail = doc.view.transcript
      ? call.output
        ? safeText(call.output).split('\n').slice(0, 40)
        : []
      : call.tail;
    for (const tail of detail)
      lines.push(...doc.text('  ' + ' '.repeat(indent.length) + '│ ' + tail, width));
  }
  return lines;
}
/** The conversation, from the task to the interrupted work. The prose cache keeps only what
 * this returns ids for (`messages`). */
export function conversationLines(
  doc: DocumentBlocks,
  session: SessionSnapshot,
  width: number,
): { lines: string[]; messages: Set<string> } {
  const { client: c, theme: t } = doc.view;
  const lines: string[] = [];
  if (session.work_task)
    lines.push(
      ...doc.title('TASK · ' + session.work_task.state.toUpperCase(), width),
      ...doc.text(session.work_task.objective, width),
      ...doc.text(
        'Inspect the saved plan in Context. Ctrl+K → Task actions controls explicit or bounded work.',
        width,
      ),
      t.fill('', width),
    );
  if (session.history_truncated)
    lines.push(
      ...doc.text(
        'Recent conversation · earlier history is available through the history command.',
        width,
      ),
      t.fill('', width),
    );
  const ids = new Set(session.messages.map((m) => m.entry_id));
  // Each turn's tool calls sit where they ran: before the message that followed them.
  const calls = toolLines(doc.view),
    byKey = new Map(calls.map((l) => [l.key, l])),
    groups = new Map<string, typeof calls>(),
    rootOf = new Map<string, string>(),
    placed = new Set<string>();
  for (const call of calls) {
    let root = call.key;
    const visited = new Set<string>();
    while (byKey.get(root)?.parent && !visited.has(root) && visited.size < 8) {
      visited.add(root);
      root = byKey.get(root)!.parent!;
    }
    groups.set(root, [...(groups.get(root) ?? []), call]);
    rootOf.set(root.slice(root.indexOf(':') + 1), root);
  }
  for (const message of session.messages) {
    const before = (message.tool_calls ?? [])
      .map((id) => rootOf.get(id))
      .filter((root): root is string => !!root && !placed.has(root));
    if (before.length) {
      for (const root of before) placed.add(root);
      lines.push(
        ...toolBlock(
          doc,
          before.flatMap((root) => groups.get(root)!),
          byKey,
          width,
        ),
        t.fill('', width),
      );
    }
    lines.push(
      ...doc.title(
        message.role === 'user' ? 'YOU' : 'SALAAM',
        width,
        message.role === 'user' ? 'muted' : 'jade',
      ),
    );
    lines.push(
      ...doc
        .prose(
          message.entry_id,
          message.role === 'user' ? typedText(message.text) : message.text,
          width - 4,
        )
        .map((line) => t.line(line, width)),
      ...(message.truncated
        ? doc.text(
            'Message preview truncated. Read its full history entry to inspect all content.',
            width,
          )
        : []),
      t.fill('', width),
    );
  }
  for (const submission of [...session.submissions]
    .toReversed()
    .filter((s) => ['accepted', 'dispatching', 'running'].includes(s.state))) {
    lines.push(
      ...doc.title(
        submission.state === 'accepted' ? 'YOU · queued' : 'YOU · in progress',
        width,
        'muted',
      ),
      ...doc.text(typedText(submission.text), width),
      t.fill('', width),
    );
  }
  // Calls not placed before a message: the turn still running, or ones history no longer shows.
  const rest = [...groups.entries()].filter(([root]) => !placed.has(root));
  if (rest.length) {
    lines.push(
      ...doc.title(
        doc.view.transcript
          ? 'TRANSCRIPT · every tool call'
          : 'TOOLS · ctrl+x for the full transcript',
        width,
        'muted',
      ),
      ...toolBlock(
        doc,
        rest.flatMap(([, group]) => group),
        byKey,
        width,
      ),
      t.fill('', width),
    );
  }
  if (c.preview)
    lines.push(
      ...doc.title('SALAAM · writing', width),
      ...doc.prose('live-preview', c.preview.text, width - 4).map((line) => t.line(line, width)),
      ...(c.preview.truncated
        ? doc.text('Live preview limited; the final message will replace it.', width)
        : []),
      t.fill('', width),
    );
  for (const approval of session.approvals.filter((a) => a.state === 'pending')) {
    const op = session.operations.find((o) => o.id === approval.operation_id);
    lines.push(
      t.rule(width),
      ...doc.title('!  Approval needed', width, 'amber'),
      ...doc.text(op?.target ?? approval.id, width),
      ...doc.text('ctrl+o reviews the exact request before a decision.', width),
      t.rule(width),
      t.fill('', width),
    );
  }
  const interrupted = session.attempts.find((a) => a.state === 'interrupted' && !a.resolved_by);
  if (interrupted)
    lines.push(
      ...doc.title('Work was interrupted', width, 'amber'),
      ...doc.text(
        'The previous instruction was not replayed. Choose Continue interrupted work from ctrl+k, then enter a new instruction.',
        width,
      ),
    );
  return { lines, messages: ids };
}
