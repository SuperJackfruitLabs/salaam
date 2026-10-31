import { Markdown, wrapTextWithAnsi, visibleWidth, type Component } from '@earendil-works/pi-tui';
import { basename } from 'node:path';
import { SalaamTheme, safeText, shortId, humanTool } from './tui-theme.js';
import { instructionsLabel, type OperatorClient } from './tui-client.js';
import type { WorkspaceChange } from './workspace-diff.js';
import { workspaceDiff } from './workspace-diff.js';
import { commandTerminal } from './coding.js';
import { interactiveCoding, runningAttempt } from './tui-turn-keys.js';

export type ViewTab = 'conversation' | 'changes' | 'commands' | 'context';
export interface DiffPage {
  revision: number;
  digest: string;
  changes: WorkspaceChange[];
  next_offset: number | null;
}
export interface ViewModel {
  client: OperatorClient;
  theme: SalaamTheme;
  tab: ViewTab;
  rows(): number;
  bodyRows(): number;
  diff?: DiffPage;
  diffOffset: number;
  log?: { id: string; text: string; offset: number; complete: boolean };
  busy: boolean;
  continuation?: string;
  /** Phase 2b: the session's mode, its access (full access or YOLO) and where commands run. */
  mode?: { mode: string; access?: 'full' | 'yolo'; sandbox?: string };
}
/** How the status line names a mode. */
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
export function modelLabel(client: OperatorClient): string {
  const route = client.snapshot?.provider_route ?? client.health?.provider_route;
  if (!route) return 'Connect your workspace';
  if (['offline', 'salaam-proof'].includes(route.provider)) return 'Offline demo';
  const warning =
    (client.snapshot?.provider_capabilities ?? client.health?.provider_capabilities)
      ?.output_token_cap === false
      ? ' · no output cap'
      : '';
  return (
    route.model.replace('claude-sonnet-', 'Claude Sonnet ').replace(/(\d)-(\d)$/, '$1.$2') + warning
  );
}
/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M". */
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
  const state = view.busy
    ? 'Working…'
    : pending
      ? `${pending} approval${pending === 1 ? '' : 's'} waiting · ctrl+o to review`
      : c.notice ||
        (!c.snapshot
          ? 'ctrl+n to start · ctrl+p to return to a session'
          : active
            ? `Agent ${active.state} · detach anytime`
            : c.controlling
              ? 'Ready when you are.'
              : 'Observing · ctrl+k → Take control');
  const tone = pending ? 'amber' : c.connection === 'reconnecting' ? 'amber' : 'muted';
  const guidance = c.snapshot?.project_instructions?.files.length
    ? '  Using ' + instructionsLabel(c.snapshot.project_instructions)
    : '';
  const spend = c.usage?.observations
    ? '  ' +
      compactTokens(c.usage.known_input + c.usage.known_output) +
      ' tokens · $' +
      Math.max(c.usage.known_cost, c.usage.estimated_cost).toFixed(2)
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
            t.key('esc', 'stop'),
            t.key('enter', 'steer'),
            t.key('tab', 'queue'),
            t.key('alt+enter', 'newline'),
            t.key('ctrl+c', 'detach'),
          ]
        : [
            t.key('enter', 'send'),
            t.key('alt+enter', 'newline'),
            t.key('ctrl+k', 'actions'),
            t.key('ctrl+p', 'sessions'),
            t.key('ctrl+c', 'detach'),
          ]
      ).join('   '),
      width,
    ),
  ];
}
export class DocumentView implements Component {
  private cache = new Map<string, { text: string; theme: SalaamTheme; markdown: Markdown }>();
  constructor(readonly view: ViewModel) {}
  invalidate(): void {
    this.cache.clear();
  }
  private prose(id: string, text: string, width: number): string[] {
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
  private title(label: string, width: number, role: 'jade' | 'amber' | 'muted' = 'jade'): string[] {
    const t = this.view.theme;
    return [t.line(t.ink(label, role, true), width)];
  }
  private text(text: string, width: number): string[] {
    const t = this.view.theme;
    return wrapTextWithAnsi(t.ink(safeText(text)), Math.max(1, width - 4)).map((line) =>
      t.line(line, width),
    );
  }
  private welcome(width: number): string[] {
    const { theme: t, client: c } = this.view;
    const center = (text: string) =>
      t.fill(' '.repeat(Math.max(2, Math.floor((width - visibleWidth(text)) / 2))) + text, width);
    return [
      ...Array.from({ length: Math.max(1, Math.min(4, Math.floor(this.view.rows() / 8))) }, () =>
        t.fill('', width),
      ),
      center(t.ink('◒', 'jade')),
      t.fill('', width),
      center(t.ink('S A L A A M', 'jade', true)),
      center(t.ink('Your work. A little more peaceful.', 'muted')),
      t.fill('', width),
      t.rule(width),
      t.fill('', width),
      ...this.text(
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
      t.line(t.key('ctrl+k', 'all actions') + '      ' + t.key('ctrl+g', 'review changes'), width),
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
                        (this.view.mode?.sandbox
                          ? '· ' + this.view.mode.sandbox
                          : 'run as your user')
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
  render(width: number): string[] {
    const { client: c, theme: t, tab } = this.view;
    if (!c.snapshot) {
      const welcome = this.welcome(width);
      while (welcome.length < this.view.bodyRows()) welcome.push(t.fill('', width));
      return welcome;
    }
    let lines: string[] = [];
    if (tab === 'conversation') {
      if (c.snapshot.work_task)
        lines.push(
          ...this.title('TASK · ' + c.snapshot.work_task.state.toUpperCase(), width),
          ...this.text(c.snapshot.work_task.objective, width),
          ...this.text(
            'Inspect the saved plan in Context. Ctrl+K → Task actions controls explicit or bounded work.',
            width,
          ),
          t.fill('', width),
        );
      if (!c.snapshot.work_task && !c.snapshot.messages.length && !c.snapshot.submissions.length) {
        lines = this.welcome(width);
        while (lines.length < this.view.bodyRows()) lines.push(t.fill('', width));
        return lines;
      }
      if (c.snapshot.history_truncated)
        lines.push(
          ...this.text(
            'Recent conversation · earlier history is available through the history command.',
            width,
          ),
          t.fill('', width),
        );
      const ids = new Set(c.snapshot.messages.map((m) => m.entry_id));
      for (const message of c.snapshot.messages) {
        lines.push(
          ...this.title(
            message.role === 'user' ? 'YOU' : 'SALAAM',
            width,
            message.role === 'user' ? 'muted' : 'jade',
          ),
        );
        lines.push(
          ...this.prose(message.entry_id, message.text, width - 4).map((line) =>
            t.line(line, width),
          ),
          ...(message.truncated
            ? this.text(
                'Message preview truncated. Read its full history entry to inspect all content.',
                width,
              )
            : []),
          t.fill('', width),
        );
      }
      for (const submission of [...c.snapshot.submissions]
        .reverse()
        .filter((s) => ['accepted', 'dispatching', 'running'].includes(s.state))) {
        lines.push(
          ...this.title(
            submission.state === 'accepted' ? 'YOU · queued' : 'YOU · in progress',
            width,
            'muted',
          ),
          ...this.text(submission.text, width),
          t.fill('', width),
        );
      }
      const tools = new Map<
        string,
        { label: string; state: string; failed: boolean; parent?: string }
      >();
      for (const event of c.activity) {
        const p = event.payload;
        const key = p.attempt_id + ':' + p.tool_call_id;
        const before = tools.get(key);
        tools.set(key, {
          label:
            event.kind === 'tool.started'
              ? humanTool(p.tool, p.input)
              : (before?.label ?? humanTool(p.tool)),
          state: event.kind === 'tool.started' ? 'running' : p.failed ? 'failed' : 'finished',
          failed: !!p.failed,
          parent: p.parent_tool_call_id
            ? p.attempt_id + ':' + p.parent_tool_call_id
            : before?.parent,
        });
      }
      if (tools.size) {
        lines.push(...this.title('TOOL ACTIVITY', width, 'muted'));
        for (const tool of [...tools.values()].slice(-6)) {
          let depth = 0,
            parent = tool.parent;
          const visited = new Set<string>();
          while (parent && !visited.has(parent) && depth < 4) {
            visited.add(parent);
            depth++;
            parent = tools.get(parent)?.parent;
          }
          lines.push(
            t.line(
              t.ink(
                tool.state === 'running' ? '◌ ' : tool.failed ? '× ' : '✓ ',
                tool.failed ? 'red' : tool.state === 'running' ? 'amber' : 'jade',
              ) +
                t.ink((depth ? '  '.repeat(depth) + '└─ ' : '') + tool.label) +
                t.ink('  ' + tool.state, 'muted'),
              width,
            ),
          );
        }
        lines.push(t.fill('', width));
      }
      if (c.preview)
        lines.push(
          ...this.title('SALAAM · writing', width),
          ...this.prose('live-preview', c.preview.text, width - 4).map((line) =>
            t.line(line, width),
          ),
          ...(c.preview.truncated
            ? this.text('Live preview limited; the final message will replace it.', width)
            : []),
          t.fill('', width),
        );
      for (const approval of c.snapshot.approvals.filter((a) => a.state === 'pending')) {
        const op = c.snapshot.operations.find((o) => o.id === approval.operation_id);
        lines.push(
          t.rule(width),
          ...this.title('!  Approval needed', width, 'amber'),
          ...this.text(op?.target ?? approval.id, width),
          ...this.text('ctrl+o reviews the exact request before a decision.', width),
          t.rule(width),
          t.fill('', width),
        );
      }
      const interrupted = c.snapshot.attempts.find(
        (a) => a.state === 'interrupted' && !a.resolved_by,
      );
      if (interrupted)
        lines.push(
          ...this.title('Work was interrupted', width, 'amber'),
          ...this.text(
            'The previous instruction was not replayed. Choose Continue interrupted work from ctrl+k, then enter a new instruction.',
            width,
          ),
        );
      for (const key of this.cache.keys())
        if (key !== 'live-preview' && !ids.has(key)) this.cache.delete(key);
    } else if (
      (tab === 'changes' || tab === 'commands') &&
      c.snapshot.capabilities.includes('local-coding-reviewed')
    ) {
      const prefix = tab === 'changes' ? 'Local edit:' : 'Local command:';
      const operations = c.snapshot.operations.filter(
        (op) => op.kind === 'workspace' && op.target.startsWith(prefix),
      );
      lines.push(
        ...this.title(tab === 'changes' ? 'REVIEWED LOCAL EDITS' : 'LOCAL COMMAND RESULTS', width),
      );
      if (!operations.length)
        lines.push(
          ...this.text(
            tab === 'changes'
              ? 'Proposed edits appear here with their approval and apply outcome.'
              : 'Commands appear here with their recorded exit status and output. ' +
                  (this.view.mode?.sandbox
                    ? 'Where commands run: ' + this.view.mode.sandbox + '.'
                    : 'Commands run as your local user.'),
            width,
          ),
        );
      for (const op of operations.slice().reverse()) {
        lines.push(
          t.rule(width),
          ...this.title(
            shortId(op.id) + ' · ' + op.state,
            width,
            op.state === 'succeeded' ? 'jade' : 'amber',
          ),
          ...this.text(op.value, width),
        );
        if (op.receipt)
          lines.push(...this.title('RECORDED RESULT', width), ...this.text(op.receipt, width));
        if (op.error) lines.push(...this.text(op.error, width));
      }
      lines.push(
        ...this.text(
          'Ctrl+O reviews pending approvals. Cancel current work from Ctrl+K stops the active foreground command. These are saved operation records, not a live Git diff.',
          width,
        ),
      );
    } else if (tab === 'changes') {
      if (!c.workspace)
        return this.text(
          'This session has no coding workspace. Create a coding session to review guarded edits.',
          width,
        );
      lines.push(
        ...this.title('WORKSPACE CHANGES', width),
        ...this.text('Original checkout: ' + c.workspace.source, width),
        ...this.text(
          'Workspace ' +
            shortId(c.workspace.id) +
            ' · revision ' +
            c.workspace.revision +
            ' · ' +
            shortId(c.workspace.digest),
          width,
        ),
        t.fill('', width),
      );
      if (!this.view.diff) lines.push(...this.text('Loading the checked diff…', width));
      else if (!this.view.diff.changes.length)
        lines.push(...this.text('No changes yet. Your original checkout is unchanged.', width));
      else
        for (const change of this.view.diff.changes) {
          lines.push(...this.title(safeText(change.path), width));
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
      if (c.workspace.observed_digest !== c.workspace.digest)
        lines.push(
          ...this.title('Human edits detected', width, 'amber'),
          ...this.text('Review and refresh the exact observed workspace before continuing.', width),
        );
    } else if (tab === 'commands') {
      lines.push(...this.title('COMMANDS', width));
      if (!c.commands.length)
        lines.push(
          ...this.text(
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
            t.ink(
              run.state === 'succeeded' ? '✓ ' : commandTerminal(run.state) ? '· ' : '◌ ',
              role,
            ) + t.ink(safeText(run.command)),
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
        if (run.error) lines.push(...this.text(run.error, width));
        lines.push(t.fill('', width));
      }
      if (this.view.log) {
        lines.push(
          t.rule(width),
          ...this.title('OUTPUT · ' + shortId(this.view.log.id), width),
          ...this.text(this.view.log.text || '(No captured output yet.)', width),
          ...this.text(
            this.view.log.complete
              ? 'End of captured output.'
              : 'Live output · byte offset ' + this.view.log.offset,
            width,
          ),
        );
      }
      lines.push(
        t.fill('', width),
        ...this.text('ctrl+k → Command logs or Cancel a command', width),
      );
    } else {
      lines.push(
        ...this.title('SESSION CONTEXT', width),
        ...this.text('Session ' + c.snapshot.id, width),
        ...this.text('Worker epoch ' + c.snapshot.epoch + ' · ' + c.snapshot.state, width),
        ...this.text('Provider ' + modelLabel(c), width),
        t.fill('', width),
      );
      if (c.snapshot.inbox?.length) {
        lines.push(...this.title('OPERATOR INBOX · ' + c.snapshot.inbox.length, width));
        for (const item of c.snapshot.inbox)
          lines.push(
            ...this.text(item.kind + ' · ' + item.id + ' · revision ' + item.revision, width),
            ...this.text(item.detail, width),
          );
        lines.push(
          ...this.text(
            'Ctrl+K → Operator inbox to inspect or acknowledge. Acknowledgement never approves work.',
            width,
          ),
        );
      }
      if (c.workspace)
        lines.push(
          ...this.title('OWNED WORKSPACE', width),
          ...this.text(c.workspace.id, width),
          ...this.text('Revision ' + c.workspace.revision + ' · ' + c.workspace.digest, width),
          ...this.text('Current root: ' + c.workspace.root, width),
          t.fill('', width),
        );
      if (c.snapshot.recurring_occurrence) {
        const r = c.snapshot.recurring_occurrence;
        lines.push(
          ...this.title('RECURRING OCCURRENCE', width),
          ...this.text('Definition ' + r.job_id + ' · occurrence ' + r.id, width),
          ...this.text(
            'Key ' + r.occurrence_key + ' · schedule revision ' + r.schedule_revision,
            width,
          ),
        );
      }
      if (c.snapshot.job) {
        const job = c.snapshot.job;
        lines.push(
          ...this.title('ONE-SHOT JOB · ' + job.state.toUpperCase(), width),
          ...this.text(job.name + ' · ' + job.id, width),
          ...this.text('Binding ' + job.binding_digest, width),
          ...this.text(
            job.occurrence
              ? 'Occurrence ' + job.occurrence.id + ' · ' + job.occurrence.occurrence_key
              : 'No occurrence admitted',
            width,
          ),
          ...this.text(job.reason, width),
        );
      }
      const team = c.snapshot.team as
        | {
            assignments: {
              id: string;
              profile_id: string;
              generation: number;
              step_state: string;
              stale: boolean;
              runtime?: { id: string; provider_route?: { provider: string; model: string } } | null;
              execution?: {
                state: string;
                stopped: boolean;
                stop_scope?: string;
                peer?: {
                  peer_id: string;
                  task_id: string | null;
                  cancel_state: string | null;
                  remote_state: string | null;
                } | null;
              } | null;
            }[];
            messages: {
              id: string;
              sender: string;
              recipient: string;
              delivered_at: number | null;
              acknowledged_at: number | null;
            }[];
          }
        | undefined;
      if (team?.assignments.length) {
        lines.push(...this.title('TEAM BOARD', width));
        for (const a of team.assignments) {
          lines.push(
            ...this.text(
              `${shortId(a.id)} · ${a.profile_id} · claim ${a.generation} · ${a.step_state}${a.stale ? ' · stale plan' : ''}`,
              width,
            ),
          );
          if (a.runtime)
            lines.push(
              ...this.text(a.runtime.id + ' · invocation budget · model usage unknown', width),
            );
          if (a.execution?.peer)
            lines.push(
              ...this.text(
                'Peer ' +
                  a.execution.peer.peer_id +
                  ' · task ' +
                  (a.execution.peer.task_id ?? 'acceptance unknown'),
                width,
              ),
              ...this.text(
                (a.execution.peer.remote_state ?? 'remote state unknown') +
                  ' · ' +
                  (a.execution.peer.cancel_state ?? 'no cancel requested'),
                width,
              ),
            );
          if (a.runtime?.provider_route)
            lines.push(
              ...this.text(
                'Backend ' +
                  a.runtime.provider_route.provider +
                  '/' +
                  a.runtime.provider_route.model,
                width,
              ),
            );
          if (a.execution)
            lines.push(
              ...this.text(
                a.execution.state +
                  ' · ' +
                  (a.execution.stop_scope === 'never-dispatched'
                    ? 'not dispatched'
                    : a.execution.stop_scope === 'remote-terminal-receipt'
                      ? a.execution.stopped
                        ? 'remote terminal receipt'
                        : 'remote stop unconfirmed'
                      : a.execution.stopped
                        ? 'stop confirmed'
                        : 'stop unconfirmed'),
                width,
              ),
            );
        }
        lines.push(
          ...this.text(
            'Messages are passive. Starting or continuing work requires a separate grant.',
            width,
          ),
        );
        for (const m of team.messages)
          lines.push(
            ...this.text(
              `${shortId(m.id)} · ${m.sender === 'operator' ? 'operator' : shortId(m.sender)} → ${shortId(m.recipient)} · ${m.acknowledged_at ? 'acknowledged' : m.delivered_at ? 'delivered' : 'stored'}`,
              width,
            ),
          );
      }
      const task = c.snapshot.work_task;
      if (task) {
        lines.push(
          ...this.title('DURABLE TASK · ' + task.state.toUpperCase(), width),
          ...this.text(
            task.id + ' · revision ' + task.revision + ' · plan ' + task.plan_revision,
            width,
          ),
          ...this.text(task.objective, width),
          ...this.text(task.reason, width),
        );
        if (task.runtime)
          lines.push(
            ...this.text(
              'Requests ' +
                task.runtime.requests_spent +
                ' spent + ' +
                task.runtime.reserved_requests +
                ' reserved / ' +
                task.limits.requests,
              width,
            ),
            ...this.text(
              task.limits.token_units === null
                ? 'Token budget disabled · ' +
                    (task.limits.output_token_bound === null
                      ? 'no task output-token bound'
                      : 'output bound ' + task.limits.output_token_bound)
                : 'Declared token units ' +
                    task.runtime.token_units +
                    ' + ' +
                    task.runtime.reserved_tokens +
                    ' reserved / ' +
                    task.limits.token_units,
              width,
            ),
            ...this.text(
              'Bounded progression ' +
                (task.runtime.auto_enabled
                  ? 'enabled · ' + task.runtime.remaining_steps + ' new steps remain'
                  : 'paused') +
                (task.runtime.auto_error ? ' · ' + task.runtime.auto_error : ''),
              width,
            ),
          );
        if (task.verification) {
          const verification = task.verification as {
            checks?: {
              id: string;
              check_key: string;
              state: string;
              fresh: boolean;
              workspace_revision: number;
            }[];
            completion?: { state: string; fresh: boolean } | null;
          };
          lines.push(...this.title('VERIFICATION', width));
          for (const check of verification.checks ?? [])
            lines.push(
              ...this.text(
                `${check.check_key} · ${check.state} · ${check.fresh ? 'current' : 'historical'} · r${check.workspace_revision} · ${shortId(check.id)}`,
                width,
              ),
            );
          if (verification.completion)
            lines.push(
              ...this.text(
                `Task ${verification.completion.state} · ${verification.completion.fresh ? 'current verification' : 'verification needs refresh'}`,
                width,
              ),
            );
          lines.push(...this.text('Ctrl+K → Inspect task for complete check receipts.', width));
        }
        for (const constraint of task.constraints)
          lines.push(...this.text('Constraint: ' + constraint, width));
        for (const step of task.steps)
          lines.push(
            ...this.title(step.key + ' · ' + step.state, width, 'muted'),
            ...this.text(step.title, width),
            ...this.text(step.instruction, width),
            ...this.text(
              'Step ' + step.id + (step.attempt_id ? ' · attempt ' + step.attempt_id : ''),
              width,
            ),
            ...this.text('Depends on: ' + (step.depends_on.join(', ') || 'none'), width),
            ...(step.review ? this.text('Operator review: ' + step.review, width) : []),
          );
        lines.push(
          ...this.text(
            'Ctrl+K → Task actions · receipts bind the exact workspace revision.',
            width,
          ),
          t.fill('', width),
        );
      }
      lines.push(...this.title('TASK FACTS', width));
      const facts = c.facts.filter((f) => !(f as { superseded_by?: string }).superseded_by);
      if (!facts.length)
        lines.push(...this.text('No explicit task facts have been recorded.', width));
      for (const fact of facts)
        lines.push(
          ...this.title(fact.kind.toUpperCase(), width, 'muted'),
          ...this.prose(fact.id, fact.text, width - 4).map((line) => t.line(line, width)),
          t.fill('', width),
        );
      lines.push(...this.title('CHILD WORK', width));
      for (const agent of c.snapshot.agents ?? [])
        lines.push(
          ...this.text(
            `${agent.profile_id} · revision ${agent.revision} · ${agent.state} · ${agent.route.provider}/${agent.route.model} · ${agent.tools.join(', ')}`,
            width,
          ),
        );
      if (!c.snapshot.children.length)
        lines.push(...this.text('No child work in this session.', width));
      for (const child of c.snapshot.children)
        lines.push(
          ...this.text(
            '└─ ' +
              shortId(child.id) +
              ' · ' +
              child.state +
              (child.result_id ? ' · result ' + shortId(child.result_id) : '') +
              (child.acknowledged ? ' · acknowledged' : ''),
            width,
          ),
          ...(child.worker
            ? this.text(
                `${child.worker.binding.profile.id} · ${child.worker.binding.runtime} · generation ${child.worker.generation} · ${child.worker.dispatch_state} · ${child.worker.binding.bounds.scope === 'model-requests' ? child.worker.binding.bounds.requests + ' model requests' : child.worker.binding.bounds.invocations + ' invocation · internal model usage unknown'}`,
                width,
              )
            : []),
          ...(child.worker?.binding.isolation
            ? this.text(
                `Private draft ${shortId(child.worker.binding.isolation.workspace_id)} · execution ${child.worker.binding.isolation.execution.evidence} · root integration requires a reviewed proposal digest`,
                width,
              )
            : []),
        );
      lines.push(t.fill('', width), ...this.title('USAGE', width));
      if (c.usage)
        lines.push(
          ...this.text(
            `${c.usage.observations} provider observations · ${c.usage.unknown_observations} unknown`,
            width,
          ),
          ...this.text(
            `Recorded tokens: ${c.usage.known_input} input · ${c.usage.known_output} output`,
            width,
          ),
          ...this.text(
            `Recorded cost $${c.usage.known_cost.toFixed(4)} · estimated $${c.usage.estimated_cost.toFixed(4)}`,
            width,
          ),
        );
      if (c.health?.execution?.backend)
        lines.push(
          t.fill('', width),
          ...this.title('EXECUTION', width),
          ...this.text(JSON.stringify(c.health.execution.backend, null, 2), width),
        );
    }
    if (lines.length > 3000)
      lines = [
        ...this.text(
          'Showing the latest 3,000 rendered lines. Full content remains in session history and artifacts.',
          width,
        ),
        ...lines.slice(-2999),
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
      c.usage.known_input.toLocaleString() +
        ' in · ' +
        c.usage.known_output.toLocaleString() +
        ' out',
    );
    row('Est. $' + c.usage.estimated_cost.toFixed(4), 'muted');
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
