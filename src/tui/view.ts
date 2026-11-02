import { Markdown, wrapTextWithAnsi, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { safeText, shortId, type SalaamTheme } from './theme.js';
import { instructionsLabel, sessionFailure, usageCost, usageInput } from './client.js';
import { commandTerminal } from '../core/index.js';
import { interactiveCoding, runningAttempt } from './turn-keys.js';
import { activityVerb, progressLine } from './activity.js';
import { modelLabel, toolLines, type ViewModel, type ViewTab } from './view-model.js';
import type { DocumentBlocks } from './sections/blocks.js';
import {
  commandLines,
  localCommandLines,
  reviewLines,
  workspaceLines,
} from './sections/changes.js';
import { contextLines } from './sections/context.js';
import { conversationLines, welcome } from './sections/conversation.js';

export {
  modelLabel,
  toolLines,
  type DiffPage,
  type ViewModel,
  type ViewTab,
} from './view-model.js';
/** Rendered lines past this are cut from the top of the document. */
const MAX_DOCUMENT_LINES = 3000;
export function modeLabel(mode: string): string {
  return (
    {
      review: 'review',
      'accept-edits': 'accept edits',
      auto: 'auto',
      inspect: 'inspect only',
      'scoped-edit': 'scoped edits',
    }[mode] ?? mode
  );
}
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
export class Dynamic implements Component {
  constructor(private readonly content: (width: number) => string[]) {}
  render(width: number): string[] {
    return this.content(width);
  }
  invalidate(): void {}
}
export function header(view: ViewModel, width: number): string[] {
  const { client: c, theme: t } = view;
  const state =
    c.connection === 'connected'
      ? '● connected'
      : c.connection === 'connecting'
        ? '◌ connecting'
        : c.connection === 'reconnecting'
          ? '◌ reconnecting'
          : '○ service offline';
  const left = t.ink('◒  S A L A A M', 'jade', true);
  const right = t.ink(state, c.connection === 'connected' ? 'jade' : 'amber');
  const gap = Math.max(1, width - 4 - visibleWidth(left) - visibleWidth(right));
  return [
    t.fill('', width),
    t.line(left + ' '.repeat(gap) + right, width),
    t.line(
      t.ink(
        c.snapshot ? safeText(basename(c.snapshot.cwd)) : 'A quiet place for serious work.',
        'text',
      ) + t.ink('  /  ' + modelLabel(c), 'muted'),
      width,
    ),
    t.rule(width),
  ];
}
export function tabs(view: ViewModel, width: number): string[] {
  const t = view.theme;
  const names: [ViewTab, string][] = [
    ['conversation', 'Conversation'],
    ['changes', 'Changes'],
    ['commands', 'Commands'],
    ['context', 'Context'],
  ];
  return [
    t.line(
      names
        .map(([id, label]) =>
          id === view.tab
            ? t.ink(' ' + label + ' ', 'jade', true)
            : t.ink(' ' + label + ' ', 'muted'),
        )
        .join(t.ink('  ·  ', 'border')),
      width,
    ),
    t.fill('', width),
  ];
}
export function status(view: ViewModel, width: number): string[] {
  const { client: c, theme: t } = view;
  const pending = c.snapshot?.approvals.filter((a) => a.state === 'pending').length ?? 0;
  const active = c.snapshot?.attempts.find((a) =>
    ['accepted', 'dispatching', 'running'].includes(a.state),
  );
  // The turn is timed from when this terminal first saw it running (attempts carry no start time).
  if (active && view.turn?.attempt !== active.id)
    view.turn = { attempt: active.id, since: Date.now() };
  if (!active) view.turn = undefined;
  const turn = active ? view.turn : undefined;
  const running = toolLines(view)
    .filter((l) => l.state === 'running')
    .at(-1);
  const state =
    turn && !pending
      ? progressLine(
          activityVerb(running),
          turn.since,
          Date.now(),
          c.usage?.observations
            ? compactTokens(c.usage.known_input + c.usage.known_output)
            : undefined,
        )
      : view.busy
        ? 'Working…'
        : pending
          ? `${pending} approval${pending === 1 ? '' : 's'} waiting · ctrl+o to review`
          : sessionFailure(c.snapshot) ||
            c.notice ||
            (!c.snapshot
              ? 'ctrl+n to start · ctrl+p to return to a session'
              : active
                ? `Agent ${active.state} · detach anytime`
                : c.controlling
                  ? 'Ready when you are.'
                  : 'Observing · ctrl+k → Take control');
  const tone = pending
    ? 'amber'
    : sessionFailure(c.snapshot) && !view.busy
      ? 'red'
      : turn
        ? 'jade'
        : c.connection === 'reconnecting'
          ? 'amber'
          : 'muted';
  const guidance = c.snapshot?.project_instructions?.files.length
    ? '  Using ' + instructionsLabel(c.snapshot.project_instructions)
    : '';
  const spend = c.usage?.observations
    ? '  ' +
      compactTokens(usageInput(c.usage) + c.usage.known_output) +
      ' tokens · $' +
      usageCost(c.usage).toFixed(2)
    : '';
  const mode = view.mode
    ? '  ' +
      t.ink('mode ' + modeLabel(view.mode.mode), 'muted') +
      (view.mode.access === 'yolo'
        ? ' ' + t.ink('YOLO', 'red')
        : view.mode.access === 'full'
          ? ' ' + t.ink('FULL ACCESS', 'amber')
          : '') +
      t.ink(' · shift+tab', 'muted')
    : '';
  const identity = c.snapshot
    ? '  session ' +
      shortId(c.snapshot.id) +
      (c.workspace ? ' · workspace ' + shortId(c.workspace.id) + ' r' + c.workspace.revision : '')
    : '';
  return [
    t.line(
      t.ink(safeText(state).replace(/\bPi\b/g, 'Worker'), tone) +
        mode +
        t.ink(safeText(guidance) + spend + identity, 'muted'),
      width,
    ),
    t.line(
      (c.snapshot && interactiveCoding(c.snapshot) && runningAttempt(c.snapshot)
        ? [
            t.key('esc', 'interrupt'),
            t.key('enter', 'steer'),
            t.key('tab', 'queue'),
            t.key('alt+enter', 'newline'),
            t.key('ctrl+c ×2', 'leave'),
          ]
        : [
            t.key('enter', 'send'),
            t.key('alt+enter', 'newline'),
            t.key('ctrl+k', 'actions'),
            t.key('ctrl+p', 'sessions'),
            t.key('ctrl+c ×2', 'leave'),
          ]
      ).join('   '),
      width,
    ),
  ];
}
export class DocumentView implements Component, DocumentBlocks {
  private cache = new Map<string, { text: string; theme: SalaamTheme; markdown: Markdown }>();
  constructor(readonly view: ViewModel) {}
  invalidate(): void {
    this.cache.clear();
  }
  prose(id: string, text: string, width: number): string[] {
    const t = this.view.theme,
      clean = safeText(text);
    let cached = this.cache.get(id);
    if (!cached || cached.text !== clean || cached.theme !== t) {
      cached = {
        text: clean,
        theme: t,
        markdown: new Markdown(clean, 0, 0, t.markdown(), { color: (s) => t.ink(s) }),
      };
      this.cache.set(id, cached);
    }
    return cached.markdown.render(Math.max(1, width));
  }
  title(label: string, width: number, role: 'jade' | 'amber' | 'muted' = 'jade'): string[] {
    const t = this.view.theme;
    return [t.line(t.ink(label, role, true), width)];
  }
  text(text: string, width: number): string[] {
    const t = this.view.theme;
    return wrapTextWithAnsi(t.ink(safeText(text)), Math.max(1, width - 4)).map((line) =>
      t.line(line, width),
    );
  }
  render(width: number): string[] {
    const { client: c, theme: t, tab } = this.view;
    if (!c.snapshot) {
      const page = welcome(this, width);
      while (page.length < this.view.bodyRows()) page.push(t.fill('', width));
      return page;
    }
    let lines: string[] = [];
    if (tab === 'conversation') {
      if (!c.snapshot.work_task && !c.snapshot.messages.length && !c.snapshot.submissions.length) {
        lines = welcome(this, width);
        while (lines.length < this.view.bodyRows()) lines.push(t.fill('', width));
        return lines;
      }
      const conversation = conversationLines(this, c.snapshot, width);
      lines.push(...conversation.lines);
      for (const key of this.cache.keys())
        if (key !== 'live-preview' && !conversation.messages.has(key)) this.cache.delete(key);
    } else if (tab === 'changes' && c.snapshot.capabilities.includes('local-coding-reviewed')) {
      lines.push(...reviewLines(this, width));
    } else if (tab === 'commands' && c.snapshot.capabilities.includes('local-coding-reviewed')) {
      lines.push(...localCommandLines(this, c.snapshot, width));
    } else if (tab === 'changes') {
      const failed = sessionFailure(c.snapshot);
      if (failed && !c.workspace) return this.text(failed, width);
      if (!c.workspace)
        return this.text(
          'This session has no coding workspace. Create a coding session to review guarded edits.',
          width,
        );
      lines.push(...workspaceLines(this, c.workspace, width));
    } else if (tab === 'commands') {
      lines.push(...commandLines(this, width));
    } else {
      lines.push(...contextLines(this, c.snapshot, width));
    }
    if (lines.length > MAX_DOCUMENT_LINES)
      lines = [
        ...this.text(
          'Showing the latest 3,000 rendered lines. Full content remains in session history and artifacts.',
          width,
        ),
        ...lines.slice(-(MAX_DOCUMENT_LINES - 1)),
      ];
    while (lines.length < this.view.bodyRows()) lines.push(t.fill('', width));
    return lines;
  }
}
export function sidebar(view: ViewModel, width: number): string[] {
  const { client: c, theme: t } = view,
    lines: string[] = [];
  const row = (text: string, role: 'text' | 'muted' | 'jade' | 'amber' | 'red' = 'text') =>
    lines.push(t.line(t.ink(safeText(text), role), width, 'panel'));
  const label = (text: string) => {
    row('');
    row(text, 'muted');
  };
  label('WORKSPACE');
  row(c.snapshot ? basename(c.snapshot.cwd) : 'No session', 'jade');
  if (c.workspace) {
    row('Owned copy · r' + c.workspace.revision);
    row(shortId(c.workspace.id), 'muted');
  } else row('Conversation', 'muted');
  label('SESSION');
  row(c.snapshot ? shortId(c.snapshot.id) : 'Choose or create one');
  row(c.snapshot?.state ?? 'Waiting', 'muted');
  label('CONTROL');
  row(c.controlling ? '● You have control' : '○ Observer', c.controlling ? 'jade' : 'amber');
  if (c.snapshot?.control.client_id && !c.controlling) {
    row(shortId(c.snapshot.control.client_id), 'muted');
    row(
      Math.max(0, Math.ceil((c.snapshot.control.expires_at - Date.now()) / 1000)) +
        's lease remaining',
      'muted',
    );
  }
  const pending = c.snapshot?.approvals.filter((a) => a.state === 'pending').length ?? 0;
  label('ATTENTION');
  row(
    pending ? `${pending} approval${pending === 1 ? '' : 's'} waiting` : 'All clear',
    pending ? 'amber' : 'muted',
  );
  if (c.pendingInputs)
    row(c.pendingInputs + ' saved input' + (c.pendingInputs === 1 ? '' : 's'), 'amber');
  const active = c.commands.filter((run) => !commandTerminal(run.state));
  if (active.length)
    row(active.length + ' command' + (active.length === 1 ? '' : 's') + ' active', 'amber');
  label('PROVIDER');
  row(modelLabel(c));
  if (c.usage) {
    label('USAGE');
    row(
      usageInput(c.usage).toLocaleString() +
        ' in · ' +
        c.usage.known_output.toLocaleString() +
        ' out',
    );
    if (c.usage.known_cache_read)
      row(c.usage.known_cache_read.toLocaleString() + ' from cache', 'muted');
    row((c.usage.estimated_observations ? 'Est. $' : '$') + usageCost(c.usage).toFixed(4), 'muted');
    if (c.usage.unknown_observations)
      row(c.usage.unknown_observations + ' unknown entries', 'amber');
  }
  label('CODING TOOLS');
  row(
    c.workspace
      ? 'Files · guarded'
      : c.snapshot?.capabilities.includes('local-workspace-read')
        ? c.snapshot?.capabilities.includes('local-coding-reviewed')
          ? 'Files · reviewed edits'
          : 'Files · local read'
        : 'Files · off',
    c.workspace || c.snapshot?.capabilities.includes('local-workspace-read') ? 'jade' : 'muted',
  );
  row(
    c.snapshot?.capabilities.includes('local-coding-reviewed')
      ? 'Commands · ' + (view.mode?.sandbox ?? 'local user')
      : c.workspace && c.health?.execution?.commands
        ? 'Commands · isolated'
        : 'Commands · off',
    c.workspace && c.health?.execution?.commands ? 'jade' : 'muted',
  );
  row('');
  row('ctrl+k  actions', 'muted');
  while (lines.length < view.bodyRows()) row('');
  return lines;
}
