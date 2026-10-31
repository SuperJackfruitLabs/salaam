import {
  Editor,
  CombinedAutocompleteProvider,
  ProcessTerminal,
  TuiAltScreen,
  ScrollView,
  VStack,
  HStack,
  matchesKey,
  type Component,
  type OverlayHandle,
  type KeyId,
} from '@earendil-works/pi-tui';
import { extractMentions, isSensitivePath } from './mentions.js';
import { MentionAutocompleteProvider } from './tui-mentions.js';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import {
  cancelChoices,
  queuedItems,
  runningAttempt,
  turnKey,
  turnKeyAction,
} from './tui-turn-keys.js';
import { randomUUID } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  fstatSync,
  constants,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT } from './config.js';
import {
  PI_PROVIDERS,
  REASONING_LEVELS,
  providerRoute,
  type ProviderRoute,
} from './provider-config.js';
import {
  INIT_INSTRUCTION,
  SLASH_COMMANDS,
  SLASH_COMPLETIONS,
  parseSlashCommand,
  slashHelp,
} from './tui-commands.js';
import { conversationExport, writeConversationExport } from './tui-export.js';
import { credentialPath } from './credentials.js';
import { call } from './transport.js';
import { OperatorClient } from './tui-client.js';
import { SalaamTheme, safeText, shortId, type ThemeName } from './tui-theme.js';
import {
  Dynamic,
  DocumentView,
  header,
  modelLabel,
  tabs,
  status,
  sidebar,
  type ViewModel,
  type ViewTab,
  type DiffPage,
  modeLabel,
} from './tui-view.js';
import { nextMode, leavingPlanNeedsConfirm } from './autonomy.js';
import { ChoiceModal, FormModal, ConfirmModal, ApprovalModal, TextModal } from './tui-modals.js';
import type { Approval } from './protocol.js';
import { commandTerminal } from './coding.js';

export interface TuiOptions {
  state: string;
  session?: string;
  observe?: boolean;
  takeover?: boolean;
  theme?: ThemeName;
  cwd?: string;
  codingRoot?: string;
  codingSocket?: string;
  /** `salaam code`: open this folder directly (step 0, 2026-10-31). */
  start?: import('./session-pick.js').CodeStart;
}
/** Frames are atomic. A slow terminal gets one fresh full redraw after drain. */
export class SalaamTerminal extends ProcessTerminal {
  private waiting = false;
  private skipped = false;
  onDrain?: () => void;
  override get columns(): number {
    return Math.min(300, super.columns);
  }
  override get rows(): number {
    return Math.min(100, super.rows);
  }
  override write(data: string): void {
    const frame = data.startsWith('\x1b[?2026h') && !data.includes('\x1b[?1049');
    if (frame && process.stdout.writableLength > 256 * 1024) {
      this.skipped = true;
      this.drain();
      return;
    }
    super.write(data);
    if (process.stdout.writableNeedDrain) this.drain();
  }
  private drain(): void {
    if (this.waiting) return;
    this.waiting = true;
    process.stdout.once('drain', () => {
      this.waiting = false;
      if (this.skipped) {
        this.skipped = false;
        this.onDrain?.();
      }
    });
  }
}
/** Quoted editor arguments only; expansion and shell evaluation are deliberately absent. */
export function editorArguments(value: string): string[] {
  const parts: string[] = [];
  let current = '',
    quote = '',
    escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else current += char;
  }
  if (escaped || quote) throw new Error('Close the quotes in VISUAL or EDITOR.');
  if (current) parts.push(current);
  if (!parts.length) throw new Error('Set VISUAL or EDITOR to an editor executable.');
  return parts;
}
export class SalaamApp {
  readonly terminal = new SalaamTerminal();
  readonly tui = new TuiAltScreen(this.terminal, true, undefined, {
    mouse: true,
    copyOnSelect: false,
  });
  readonly client: OperatorClient;
  readonly editor: Editor;
  readonly view: ViewModel;
  readonly document: DocumentView;
  readonly scroll: ScrollView;
  private rail = true;
  private selectedRoute?: ProviderRoute;
  private modal?: OverlayHandle;
  private finish!: () => void;
  private readonly done: Promise<void>;
  private running = false;
  private editorProcess?: ChildProcess;
  private painter?: NodeJS.Timeout;
  private logBusy = false;
  private diffBusy = false;
  private pendingAction?: () => void;
  private logBytes = Buffer.alloc(0);
  private readonly drafts = new Map<string, string>();
  private lastSession?: string;
  private lastRevision?: number;
  private readonly historyKeys = new Set<string>();
  private readonly removeInput: () => void;
  constructor(readonly options: TuiOptions) {
    this.client = new OperatorClient(options.state);
    const theme = new SalaamTheme(options.theme ?? 'night');
    this.view = {
      client: this.client,
      theme,
      tab: 'conversation',
      rows: () => this.terminal.rows,
      bodyRows: () =>
        Math.max(
          1,
          this.terminal.rows - 9 - Math.min(8, this.editor.render(this.contentWidth()).length),
        ),
      diffOffset: 0,
      busy: false,
    };
    this.editor = new Editor(
      this.tui,
      {
        borderColor: (s) => this.view.theme.ink(s, 'border'),
        selectList: {
          selectedPrefix: (s) => this.view.theme.ink(s, 'jade'),
          selectedText: (s) => this.view.theme.ink(s, 'jade'),
          description: (s) => this.view.theme.ink(s, 'muted'),
          scrollInfo: (s) => this.view.theme.ink(s, 'muted'),
          noMatch: (s) => this.view.theme.ink(s, 'muted'),
        },
      },
      { paddingX: 2 },
    );
    // The app journals the exact expanded input before clearing it. The library's submit path trims and clears first.
    this.editor.disableSubmit = true;
    this.editor.setAutocompleteProvider(
      new MentionAutocompleteProvider([...SLASH_COMPLETIONS], options.cwd ?? process.cwd()),
    );
    this.editor.onChange = () => {
      const text = this.editor.getExpandedText(),
        clean = safeText(text);
      if (clean !== text) {
        this.editor.setText(clean);
        return;
      }
      if (this.client.snapshot) this.drafts.set(this.client.snapshot.id, clean);
      this.tui.requestRender();
    };
    this.document = new DocumentView(this.view);
    this.scroll = new ScrollView(this.document, {
      primary: true,
      follow: 'end',
      scrollbar: 'auto',
      scrollbarTrackStyle: (s) => this.view.theme.ink(s, 'border'),
      scrollbarThumbStyle: (s) => this.view.theme.ink(s, 'jade'),
    });
    const body = new HStack([
      { component: this.scroll, grow: 1, minSize: 20 },
      {
        component: new ScrollView(new Dynamic((width) => sidebar(this.view, width)), {
          scrollbar: 'hidden',
        }),
        basis: 31,
        shrink: 0,
        visible: (viewport) => this.rail && viewport.width >= 104 && viewport.height >= 12,
      },
    ]);
    const composerLabel = new Dynamic((width) => [
      this.view.theme.line(
        this.view.theme.ink(
          this.view.continuation
            ? 'Continue interrupted work · ' + shortId(this.view.continuation)
            : this.client.controlling
              ? this.client.snapshot?.capabilities.includes('local-workspace-read')
                ? 'Ask about this project · /model · /help'
                : 'Ask Salaam to build, fix, or explore…'
              : 'Observing · take control to write',
          this.view.continuation ? 'amber' : 'muted',
        ),
        width,
      ),
    ]);
    const composer = new Dynamic((width) =>
      this.editor
        .render(width)
        .map((line) => this.view.theme.fill(this.view.theme.ink(line), width)),
    );
    this.tui.setLayoutRoot(
      new VStack([
        { component: new Dynamic((width) => header(this.view, width)), basis: 4, shrink: 0 },
        { component: new Dynamic((width) => tabs(this.view, width)), basis: 2, shrink: 0 },
        { component: body, grow: 1, minSize: 1 },
        { component: composerLabel, basis: 1, shrink: 0 },
        { component: composer, maxSize: 8, shrink: 0 },
        { component: new Dynamic((width) => status(this.view, width)), basis: 2, shrink: 0 },
      ]),
    );
    this.tui.setFocus(this.editor);
    this.terminal.onDrain = () => {
      if (this.running) this.tui.requestRender(true);
    };
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.removeInput = this.tui.addInputListener((data) => this.input(data));
    this.client.on('change', () => this.changed());
  }
  private contentWidth(): number {
    return Math.max(
      1,
      this.terminal.columns - (this.rail && this.terminal.columns >= 104 ? 31 : 0),
    );
  }
  private changed(): void {
    const snapshot = this.client.snapshot;
    if (snapshot) {
      if (snapshot.id !== this.lastSession) {
        if (this.lastSession) this.drafts.set(this.lastSession, this.editor.getExpandedText());
        this.lastSession = snapshot.id;
        this.view.log = undefined;
        this.logBytes = Buffer.alloc(0);
        this.view.diff = undefined;
        this.view.diffOffset = 0;
        this.lastRevision = undefined;
        this.view.continuation = undefined;
        this.editor.setText(this.drafts.get(snapshot.id) ?? '');
        this.resetScroll();
      }
      for (const submission of [...snapshot.submissions].reverse())
        if (!this.historyKeys.has(submission.id)) {
          this.historyKeys.add(submission.id);
          this.editor.addToHistory(submission.text);
        }
      // Phase 2b: the status line shows this session's mode; reload it when the session changes.
      if (this.client.snapshot?.id !== this.modeSession) {
        this.modeSession = this.client.snapshot?.id;
        void this.loadMode().catch(() => {});
      }
      if (this.client.workspace?.revision !== this.lastRevision) {
        this.lastRevision = this.client.workspace?.revision;
        this.view.diff = undefined;
        if (this.view.tab === 'changes')
          void this.loadDiff(0).catch((error) => this.client.report(error));
      }
      if (this.view.log) void this.loadLogs();
    }
    this.tui.requestRender();
  }
  private input(data: string): { consume: true } | undefined {
    if (
      matchesKey(data, 'ctrl+c') ||
      (matchesKey(data, 'ctrl+d') && !this.editor.getExpandedText())
    ) {
      this.finish();
      return { consume: true };
    }
    if (this.modal) return;
    if (
      this.editor.isShowingAutocomplete() &&
      (matchesKey(data, 'enter') || matchesKey(data, 'tab') || matchesKey(data, 'escape'))
    )
      return;
    // Esc stops the running turn, Enter steers it, Tab queues behind it (interactive coding only).
    const key = turnKey(data);
    const action = key
      ? turnKeyAction({
          key,
          text: this.editor.getExpandedText(),
          snapshot: this.client.snapshot,
          modal: false,
          autocomplete: false,
        })
      : null;
    if (action === 'interrupt') {
      const attempt = runningAttempt(this.client.snapshot);
      if (attempt)
        void this.execute(async () => {
          await this.client.cancel(attempt);
          this.client.report(
            'Stopped the turn. Edits already made stay; /undo reverts the last one. Your typed text is kept.',
          );
        });
      return { consume: true };
    }
    if (action === 'steer' || action === 'queue') {
      const text = this.editor.getExpandedText(),
        session = this.client.snapshot?.id;
      void this.execute(async () => {
        if (action === 'steer') await this.client.steer(text);
        else {
          await this.client.submit(text);
          const waiting = this.client.snapshot ? queuedItems(this.client.snapshot).length : 0;
          this.client.report(
            'Queued for after this turn (' + waiting + ' waiting). /queue edits or removes them.',
          );
        }
        this.editor.addToHistory(text);
        if (this.client.snapshot?.id === session && this.editor.getExpandedText() === text) {
          this.editor.setText('');
          if (session) this.drafts.delete(session);
        }
      });
      return { consume: true };
    }
    if (matchesKey(data, 'enter')) {
      const text = this.editor.getExpandedText(),
        session = this.client.snapshot?.id;
      const submit = () => {
        if (
          !this.modal &&
          this.editor.getExpandedText() === text &&
          this.client.snapshot?.id === session
        )
          void this.execute(() => this.submit());
      };
      if (this.view.busy) this.pendingAction = submit;
      else submit();
      return { consume: true };
    }
    const keys: [KeyId, () => void][] = [
      ['ctrl+k', () => this.palette()],
      ['ctrl+p', () => void this.execute(() => this.sessions())],
      ['ctrl+n', () => void this.execute(() => this.newSession())],
      ['ctrl+o', () => this.approvals()],
      ['ctrl+g', () => this.setTab('changes')],
      ['ctrl+t', () => this.setTab('commands')],
      [
        'ctrl+b',
        () => {
          this.rail = !this.rail;
          this.tui.requestRender(true);
        },
      ],
      ['ctrl+r', () => void this.execute(() => this.refresh())],
      ['ctrl+e', () => void this.execute(() => this.editPrompt())],
      ['shift+tab', () => void this.execute(() => this.cycleMode())],
      ['f1', () => this.help()],
    ];
    for (const [key, action] of keys)
      if (matchesKey(data, key)) {
        if (this.view.busy) this.pendingAction = action;
        else action();
        return { consume: true };
      }
    if (matchesKey(data, 'tab') && this.editor.getExpandedText().trimStart().startsWith('/'))
      return;
    if (matchesKey(data, 'tab')) {
      const names: ViewTab[] = ['conversation', 'changes', 'commands', 'context'];
      this.setTab(names[(names.indexOf(this.view.tab) + 1) % names.length]!);
      return { consume: true };
    }
    if (
      this.view.tab === 'changes' &&
      (matchesKey(data, 'alt+right') || matchesKey(data, 'alt+left'))
    ) {
      const offset = matchesKey(data, 'alt+left')
        ? Math.max(0, this.view.diffOffset - 1)
        : this.view.diff?.next_offset;
      if (offset !== undefined && offset !== null) void this.execute(() => this.loadDiff(offset));
      return { consume: true };
    }
    return;
  }
  private async execute(work: () => Promise<unknown>): Promise<void> {
    if (this.view.busy) {
      const session = this.client.snapshot?.id ?? this.options.session;
      this.pendingAction = () => {
        if (this.client.snapshot?.id === session) void this.execute(work);
      };
      return;
    }
    this.view.busy = true;
    this.tui.requestRender();
    try {
      await work();
    } catch (error) {
      this.client.report(error);
    } finally {
      this.view.busy = false;
      this.tui.requestRender();
      const pending = this.pendingAction;
      this.pendingAction = undefined;
      if (this.running) pending?.();
    }
  }
  private closeModal(): void {
    this.modal?.hide();
    this.modal = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }
  private showModal(component: Component, width = 78): void {
    this.closeModal();
    this.modal = this.tui.showOverlay(component, {
      anchor: 'center',
      width: Math.max(20, Math.min(width, this.terminal.columns - 4)),
      maxHeight: Math.max(1, this.terminal.rows - 2),
    });
    this.tui.requestRender();
  }
  private choice(
    title: string,
    items: { value: string; label: string; description?: string }[],
    choose: (value: string) => void,
  ): void {
    this.showModal(
      new ChoiceModal(
        title,
        items,
        this.view.theme,
        () => this.tui.requestRender(),
        () => this.closeModal(),
        (item) => {
          this.closeModal();
          choose(item.value);
        },
        () => this.terminal.rows,
      ),
    );
  }
  private confirm(
    title: string,
    description: string,
    label: string,
    confirm: () => Promise<unknown>,
    confirmByDefault = false,
  ): void {
    if (this.terminal.rows < 18) {
      this.client.report('Expand the terminal to at least 18 rows to review this action.');
      return;
    }
    this.showModal(
      new ConfirmModal(
        title,
        description,
        label,
        this.view.theme,
        () => this.tui.requestRender(),
        () => this.closeModal(),
        () => {
          this.closeModal();
          void this.execute(confirm);
        },
        confirmByDefault,
      ),
    );
  }
  private async startService(): Promise<void> {
    await this.client.list();
    if (this.client.connection === 'connected') return;
    if (
      !this.selectedRoute &&
      (existsSync(credentialPath()) || existsSync(credentialPath() + '.json'))
    )
      this.selectedRoute = providerRoute('anthropic');
    const provider = 'offline';
    await promisify(execFile)(
      process.execPath,
      [
        join(ROOT, 'bin/salaam.mjs'),
        'service',
        'start',
        '--state',
        this.options.state,
        '--provider',
        provider,
        ...(this.options.codingRoot ? ['--coding-root', resolve(this.options.codingRoot)] : []),
        ...(this.options.codingSocket
          ? ['--coding-socket', resolve(this.options.codingSocket)]
          : []),
      ],
      { timeout: 20000, maxBuffer: 65536 },
    );
    await this.client.list();
    if (this.client.connection === 'offline')
      throw new Error('Service did not become available. Inspect sal service status.');
  }
  /** Interactive sessions switch in place between turns; otherwise the choice opens a new session. */
  private async applyRoute(route: import('./provider-config.js').ProviderRoute): Promise<void> {
    if (this.client.snapshot?.provider_route && this.client.controlling) {
      await this.client.switchRoute(route);
      this.client.notice = 'Now using ' + modelLabel(this.client) + ' in this session.';
      return;
    }
    this.selectedRoute = route;
    await this.newSession();
  }
  private modelPicker(): void {
    const configured = (this.client.snapshot?.provider_route ?? this.client.health?.provider_route)
      ?.provider;
    const live = PI_PROVIDERS.filter((p) => p.getModels().length);
    this.choice(
      this.client.snapshot ? 'Provider · switches this session' : 'Provider',
      [
        // The configured provider first; the scripted demo last, never the default.
        ...[
          ...live.filter((p) => p.id === configured),
          ...live.filter((p) => p.id !== configured),
        ].map((p) => ({
          value: p.id,
          label: p.name,
          description: p.id + (p.id === configured ? ' · current' : ''),
        })),
        {
          value: 'offline',
          label: 'Offline demo',
          description: 'Scripted fixture, not an AI model',
        },
      ],
      (provider) => {
        if (provider === 'offline') {
          void this.execute(() => this.applyRoute(providerRoute()));
          return;
        }
        const catalog = PI_PROVIDERS.find((p) => p.id === provider)!;
        this.choice(
          'Model · ' + catalog.name,
          catalog.getModels().map((m) => ({
            value: m.id,
            label: m.name,
            description: m.id + ' · ' + m.contextWindow + ' context tokens',
          })),
          (model) => void this.execute(() => this.applyRoute(providerRoute(provider, model))),
        );
      },
    );
  }
  private modeSession: string | undefined;
  /** Phase 2b: the session's mode and full access, for the status line. */
  private async loadMode(): Promise<void> {
    if (!this.client.snapshot) {
      this.view.mode = undefined;
      return;
    }
    const current = await this.client.permissions();
    this.view.mode =
      current.configurable && current.coding
        ? { mode: current.policy.mode, full: current.policy.access === 'full' }
        : undefined;
    this.tui.requestRender();
  }
  /** Shift+Tab: review → accept edits → auto → plan. Leaving plan for a mode that can change the
   * workspace asks first. Full access is kept as it is; it has its own command. */
  private async cycleMode(): Promise<void> {
    const session = this.client.snapshot?.id;
    if (!session) throw new Error('Open a session first.');
    const current = await this.client.permissions();
    if (!current.configurable || !current.coding)
      throw new Error('Modes are for local coding sessions. No session or files were changed.');
    const from = current.policy.mode,
      to = nextMode(from);
    const apply = async () => {
      await this.client.setPermissions(session, current.policy.revision, {
        mode: to,
        paths: [],
        ...(current.policy.access === 'full' ? { access: 'full' as const } : {}),
      });
      await this.loadMode();
    };
    if (leavingPlanNeedsConfirm(from, to))
      this.confirm(
        'Leave plan mode?',
        `Switch from plan to ${modeLabel(to)}. The agent may then change files${to === 'auto' ? ' and run sandboxed commands without asking' : ''}.`,
        'switch mode',
        apply,
      );
    else await apply();
  }
  /** Full access on (with a warning and a confirm) or off (at once). */
  private async fullAccess(): Promise<void> {
    const session = this.client.snapshot?.id;
    if (!session) throw new Error('Open a session first.');
    const current = await this.client.permissions();
    if (!current.configurable || !current.coding)
      throw new Error('Full access is for local coding sessions. Nothing was changed.');
    const on = current.policy.access === 'full';
    const apply = async () => {
      await this.client.setPermissions(session, current.policy.revision, {
        mode: current.policy.mode,
        paths: current.policy.paths,
        ...(on ? {} : { access: 'full' as const }),
      });
      await this.loadMode();
    };
    if (on) {
      await apply();
      return;
    }
    if (current.full_access_allowed === false)
      throw new Error(
        'The operator does not allow full access on this host. Commands stay in the OS sandbox.',
      );
    this.confirm(
      'Turn on full access?',
      'Later commands in this session run WITHOUT the OS sandbox: they can read and change any file your user can, and reach the network directly. Each command still asks for your approval, even in auto mode. Run /full-access again to turn it off.',
      'turn on full access',
      apply,
    );
  }
  private showText(title: string, text: string): void {
    this.showModal(
      new TextModal(
        title,
        text,
        this.view.theme,
        () => this.terminal.rows,
        () => this.tui.requestRender(),
        () => this.closeModal(),
      ),
    );
  }
  private async runSlashCommand(command: string, args = ''): Promise<void> {
    const snapshot = this.client.snapshot;
    const definition = SLASH_COMMANDS.find((c) => c.name === command);
    if (!definition) throw new Error('Unknown command. Use /help.');
    if (definition.kind === 'unavailable')
      throw new Error(definition.description + '. No session or files were changed.');
    if (command === 'exit') {
      this.finish();
      return;
    }
    if (command === 'help') {
      this.showText('Salaam commands', slashHelp(args || undefined));
      return;
    }
    if (command === 'keys') {
      this.help();
      return;
    }
    if (command === 'model') {
      if (!args) {
        this.modelPicker();
        return;
      }
      const slash = args.indexOf('/');
      if (slash <= 0) throw new Error('Use /model provider/model.');
      await this.applyRoute(providerRoute(args.slice(0, slash), args.slice(slash + 1)));
      return;
    }
    if (command === 'provider') {
      if (!args) {
        this.modelPicker();
        return;
      }
      if (args === 'offline') {
        await this.applyRoute(providerRoute());
        return;
      }
      const provider = PI_PROVIDERS.find((p) => p.id === args);
      if (!provider)
        throw new Error('Unknown provider. Use /provider to browse the pinned catalog.');
      this.choice(
        'Model · ' + provider.name,
        provider.getModels().map((m) => ({ value: m.id, label: m.name, description: m.id })),
        (model) => void this.execute(() => this.applyRoute(providerRoute(args, model))),
      );
      return;
    }
    if (command === 'new' || command === 'coding') {
      if (args) {
        await this.startService();
        await this.client.create(resolve(args), false, this.selectedRoute, command === 'coding');
        this.setTab('conversation');
      } else await this.newSession(command === 'coding');
      return;
    }
    if (command === 'sessions') {
      if (args) {
        await this.client.open(args, {
          observe: this.options.observe,
          takeover: this.options.takeover,
        });
        this.setTab('conversation');
      } else await this.sessions();
      return;
    }
    if (command === 'settings') {
      this.choice(
        'Settings',
        [
          { value: 'permissions', label: 'Permissions · inspect, review or scoped edits' },
          { value: 'progression', label: 'Progression · manual, bounded tasks or schedules' },
          { value: 'model', label: 'Provider and model' },
          { value: 'theme', label: 'Switch Night / Paper' },
          { value: 'rail', label: 'Toggle workspace rail' },
          { value: 'keys', label: 'Keyboard shortcuts' },
        ],
        (value) => {
          if (value === 'theme') {
            this.view.theme = new SalaamTheme(this.view.theme.name === 'night' ? 'paper' : 'night');
            this.document.invalidate();
            this.tui.requestRender(true);
          } else if (value === 'rail') {
            this.rail = !this.rail;
            this.tui.requestRender(true);
          } else void this.execute(() => this.runSlashCommand(value));
        },
      );
      return;
    }
    if (command === 'status') {
      this.showText(
        'Session status',
        JSON.stringify(
          {
            connection: this.client.connection,
            session: snapshot?.id,
            workspace: snapshot?.cwd,
            route: snapshot?.provider_route ?? this.client.health?.provider_route,
            capabilities: snapshot?.capabilities,
            pending_delivery: this.client.pendingInputs,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!snapshot) throw new Error('Choose a session with /sessions or /new first.');
    if (command === 'undo') {
      if (args === 'reconcile') {
        await this.client.reconcileUndo();
        return;
      }
      if (args) throw new Error('Use /undo or /undo reconcile.');
      const review = await this.client.undoReview();
      this.showModal(
        new TextModal(
          'Undo local edit · review the inverse',
          review.edits
            .map(
              (e) =>
                '--- ' +
                e.path +
                '\n' +
                e.after +
                '\n+++ restored\n' +
                (e.before ?? '(remove new file)'),
            )
            .join('\n\n'),
          this.view.theme,
          () => this.terminal.rows,
          () => this.tui.requestRender(),
          () => this.closeModal(),
          undefined,
          () => {
            this.closeModal();
            void this.execute(() => this.client.undo(review));
          },
        ),
      );
      return;
    }
    if (command === 'fork') {
      this.confirm(
        'Fork session',
        'Create an independent conversation from the captured history? Both sessions share the same workspace; files are not cloned. Pending approvals and task authority are not copied.',
        'Fork conversation',
        () => this.client.fork(),
      );
      return;
    }
    if (command === 'init') {
      if (!snapshot.capabilities.includes('local-coding-reviewed'))
        throw new Error('/init writes a file. Start a coding session with /coding first.');
      await this.client.submit(INIT_INSTRUCTION);
      this.setTab('conversation');
      return;
    }
    if (command === 'compact') {
      await this.client.compact();
      return;
    }
    if (command === 'history') {
      await this.history();
      return;
    }
    if (command === 'context') {
      this.setTab('context');
      return;
    }
    if (command === 'diff') {
      if (snapshot.capabilities.includes('local-workspace-read')) {
        const diff = await call<{ text: string }>(
          this.client.socket,
          `/v1/sessions/${snapshot.id}/local-diff`,
        );
        this.showText('Local Git changes', diff.text);
      } else this.setTab('changes');
      return;
    }
    if (command === 'approvals') {
      this.approvals();
      return;
    }
    if (command === 'tasks') {
      this.taskActions();
      return;
    }
    if (command === 'cancel') {
      const active = cancelChoices(snapshot);
      if (!active.length) {
        this.client.report('No active or queued instruction to cancel.');
        return;
      }
      const cancel = (id: string) =>
        this.confirm(
          'Cancel instruction',
          'Cancel attempt ' +
            shortId(id) +
            '? Your typed text is kept. /exit would leave it running.',
          'Cancel work',
          () => this.client.cancel(id),
          true,
        );
      if (active.length === 1) cancel(active[0]!.id);
      else
        this.choice(
          'Cancel an instruction',
          active.map((a) => ({ value: a.id, label: a.label })),
          cancel,
        );
      return;
    }
    if (command === 'steer') {
      if (!args) throw new Error('Use /steer followed by guidance for the active turn.');
      await this.client.steer(args);
      return;
    }
    if (command === 'queue') {
      if (args) {
        await this.client.submit(args);
        return;
      }
      const queued = queuedItems(snapshot);
      if (!queued.length) {
        this.client.report('Nothing is queued. Tab queues text for after the running turn.');
        return;
      }
      this.choice(
        'Queued instructions',
        queued.map((q) => ({ value: q.attempt, label: q.text.slice(0, 80) })),
        (attempt) => {
          const item = queued.find((q) => q.attempt === attempt)!;
          this.choice(
            'Queued instruction',
            [
              { value: 'edit', label: 'Edit', description: 'Move it back into the input' },
              { value: 'remove', label: 'Remove', description: 'Cancel it before it runs' },
            ],
            (choice) =>
              void this.execute(async () => {
                await this.client.cancel(item.attempt);
                if (choice === 'edit') this.editor.setText(item.text);
              }),
          );
        },
      );
      return;
    }
    if (command === 'plan' || command === 'review') {
      const instruction =
        command === 'plan'
          ? 'Produce an implementation plan. Inspect relevant workspace files, explain assumptions, steps and validation. Do not edit files or run mutating commands. '
          : 'Review the workspace changes. Inspect the actual code and report actionable bugs with file references and verification gaps. Do not edit files. ';
      this.confirm(
        command === 'plan' ? 'Request a plan' : 'Request a review',
        'This submits a model instruction and uses provider credits. It does not change tool permissions; mutations still use existing approval controls.',
        'Submit instruction',
        () => this.client.submit(instruction + args).then(() => undefined),
      );
      return;
    }
    if (command === 'usage') {
      this.showText(
        'Provider usage',
        JSON.stringify(
          this.client.usage ?? { status: 'No usage observations yet; this is not zero usage.' },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'mode') {
      await this.cycleMode();
      return;
    }
    if (command === 'full-access') {
      await this.fullAccess();
      return;
    }
    if (command === 'permissions') {
      await this.permissionControls();
      return;
    }
    if (command === 'progression') {
      this.choice(
        'Progression · does not change permissions',
        [
          {
            value: 'manual',
            label: 'Manual steps',
            description: 'Pause future task steps; current work can settle',
          },
          {
            value: 'bounded',
            label: 'Bounded automatic task',
            description: 'Checked task, step grant and budgets; permission gates still apply',
          },
          {
            value: 'scheduled',
            label: 'Scheduled tasks',
            description: 'Reviewed templates and fresh bounded occurrences',
          },
        ],
        (value) => {
          if (value === 'bounded') this.taskActions(true);
          else if (value === 'scheduled') void this.execute(() => this.schedules());
          else {
            const task = this.client.snapshot?.work_task;
            if (!task)
              this.client.report(
                'Manual instruction mode is active. No task is configured for automatic progression.',
              );
            else
              this.confirm(
                'Manual progression',
                'Stop admitting later task steps? Already-running work may settle. Permissions remain unchanged.',
                'Pause progression',
                () =>
                  this.client.taskAction(
                    'auto',
                    { max_steps: 0, compact: false },
                    { id: task.id, revision: task.revision },
                  ),
              );
          }
        },
      );
      return;
    }
    if (command === 'tools') {
      this.showText(
        command === 'tools' ? 'Tools and activity' : 'Session authority',
        JSON.stringify(
          {
            capabilities: snapshot.capabilities,
            controller: snapshot.control,
            pending_approvals: snapshot.approvals.filter((a) => a.state === 'pending'),
            ...(command === 'tools' ? { activity: this.client.activity } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'agents') {
      this.showText(
        'Agents',
        JSON.stringify(
          {
            profiles: snapshot.agents ?? [],
            children: snapshot.children,
            team: snapshot.team ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'mcp') {
      this.showText(
        'Managed MCP',
        JSON.stringify(
          {
            capabilities: snapshot.capabilities.filter((c) => /mcp|toolkit/.test(c)),
            operations: snapshot.operations.filter((o) => o.kind === 'mcp'),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'skills') {
      if (args === 'clear' || args.startsWith('review ')) {
        const paths =
          args === 'clear' ? [] : args.slice('review '.length).trim().split(/\s+/).filter(Boolean);
        if (args !== 'clear' && !paths.length)
          throw Error('Use /skills review AGENTS.md .salaam/skills/sjl-profile');
        const plan = await this.client.planContext({
          files: paths.filter((path) => path.endsWith('.md')),
          bundles: paths.filter((path) => !path.endsWith('.md')),
        });
        this.confirm(
          'Review context and skills',
          'These exact bytes become model context. No tools or permissions are granted. Editing any reviewed resource blocks future grants until renewed.\n\n' +
            JSON.stringify(plan, null, 2),
          args === 'clear' ? 'Clear admission' : 'Admit reviewed context',
          () => this.client.admitContext(plan),
        );
        return;
      }
      if (args) throw Error('Use /skills, /skills review <relative paths>, or /skills clear');
      this.showText(
        'Skills',
        JSON.stringify(
          await call(this.client.socket, `/v1/sessions/${snapshot.id}/context`),
          null,
          2,
        ),
      );
      return;
    }
    if (command === 'thinking') {
      const current = snapshot.provider_route;
      if (!current || current.provider === 'salaam-proof')
        throw new Error('Choose a live provider/model first with /model.');
      const choose = (level: string) =>
        this.applyRoute(
          providerRoute(
            current.provider,
            current.model,
            current.max_tokens,
            current.workspace_id,
            current.connection,
            level as import('./provider-config.js').ReasoningLevel,
          ),
        );
      if (args) await choose(args);
      else
        this.choice(
          'Reasoning · current ' + (current.reasoning ?? 'automatic low'),
          REASONING_LEVELS.map((level) => ({ value: level, label: level })),
          (level) => void this.execute(() => choose(level)),
        );
      return;
    }
    if (command === 'name') {
      if (!args || args.length > 120 || /[\x00-\x1f\x7f]/.test(args))
        throw new Error('Use /name followed by 1–120 printable characters.');
      await this.client.name(args);
      this.client.report('Session named ' + args);
      return;
    }
    if (command === 'export') {
      const path = resolve(args || `salaam-${snapshot.id}.md`);
      const text = await conversationExport(this.client.socket, snapshot.id);
      writeConversationExport(path, text);
      this.client.report('Exported full captured history to ' + path);
      return;
    }
    if (command === 'copy') {
      const last = [...snapshot.messages].reverse().find((m) => m.role === 'assistant');
      if (!last) throw new Error('No assistant response to copy.');
      if (last.truncated)
        throw new Error(
          'Response preview is truncated. Use /export for complete captured history.',
        );
      if (process.platform !== 'darwin')
        throw new Error(
          'Clipboard copying is currently supported on macOS; use /export on this platform.',
        );
      await new Promise<void>((resolve, reject) => {
        const child = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
        child.on('error', reject);
        child.stdin.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error('Clipboard copy failed.')),
        );
        child.stdin.end(last.text);
      });
      this.client.report('Copied the last assistant response.');
      return;
    }
    throw new Error('Command has no handler: ' + command);
  }
  private async newSession(localCoding = false): Promise<void> {
    await this.startService();
    this.showModal(
      new FormModal(
        (localCoding
          ? 'New coding session · reviewed edits and unsandboxed commands · '
          : 'New session · ') +
          (this.selectedRoute?.model ?? this.client.health?.provider_route.model ?? 'default'),
        this.options.cwd ?? this.client.snapshot?.cwd ?? process.cwd(),
        this.view.theme,
        !localCoding && !!this.client.health?.coding_root,
        () => this.tui.requestRender(),
        () => this.closeModal(),
        (cwd, coding) => {
          this.closeModal();
          void this.execute(async () => {
            await this.client.create(resolve(cwd), coding, this.selectedRoute, localCoding);
            this.setTab('conversation');
          });
        },
      ),
    );
  }
  private async sessions(): Promise<void> {
    await this.client.list();
    this.choice(
      'Your Salaam sessions',
      [
        { value: 'new', label: '+ New session', description: 'Start a fresh workspace' },
        ...this.client.sessions.map((session) => ({
          value: session.id,
          label:
            (this.client.names[session.id] ?? basename(session.cwd)) + '  ' + shortId(session.id),
          description: session.state + ' · ' + session.cwd,
        })),
      ],
      (value) => {
        if (value === 'model') this.modelPicker();
        else if (value === 'help') void this.execute(() => this.runSlashCommand('help'));
        else if (value === 'coding') void this.execute(() => this.newSession(true));
        else if (value === 'new') void this.execute(() => this.newSession());
        else
          void this.execute(async () => {
            await this.client.open(value, {
              observe: this.options.observe,
              takeover: this.options.takeover,
            });
            this.setTab('conversation');
          });
      },
    );
  }
  private async submit(): Promise<void> {
    const text = this.editor.getExpandedText(),
      session = this.client.snapshot?.id,
      continuation = this.view.continuation;
    if (!text.trim()) return;
    const command = parseSlashCommand(text);
    if (command) {
      await this.runSlashCommand(command.name, command.args);
      if (this.editor.getExpandedText() === text) this.editor.setText('');
      if (session) this.drafts.delete(session);
      return;
    }
    if (!session) throw new Error('Create or choose a session with ctrl+n or ctrl+p first.');
    if (Buffer.byteLength(text) > 65536)
      throw new Error('The composer accepts at most 64 KiB. Use an artifact for longer input.');
    const secrets = extractMentions(text).filter(isSensitivePath);
    if (secrets.length) {
      this.confirm(
        'Attach secret-looking files?',
        `${secrets.map((s) => '@' + s).join(', ')} will be sent to the model in full.`,
        'Attach and send',
        () => this.deliver(text, session, continuation, true),
      );
      return;
    }
    await this.deliver(text, session, continuation, false);
  }
  private async deliver(
    text: string,
    session: string,
    continuation: string | undefined,
    confirmSensitive: boolean,
  ): Promise<void> {
    await this.client.submit(text, continuation, confirmSensitive);
    this.editor.addToHistory(text);
    if (this.client.snapshot?.id === session && this.editor.getExpandedText() === text) {
      this.editor.setText('');
      this.drafts.delete(session);
    }
    if (this.view.continuation === continuation) this.view.continuation = undefined;
    this.view.tab = 'conversation';
    this.scroll.scrollToEnd();
  }
  setTab(tab: ViewTab): void {
    this.view.tab = tab;
    this.resetScroll();
    if (tab === 'changes') void this.execute(() => this.loadDiff(this.view.diffOffset));
    this.tui.requestRender();
  }
  private resetScroll(): void {
    if (this.view.tab === 'conversation' || this.view.tab === 'commands') this.scroll.scrollToEnd();
    else this.scroll.scrollTo(0, { disableFollow: true });
  }
  private async refresh(): Promise<void> {
    await this.client.refresh();
    if (this.view.tab === 'changes') await this.loadDiff(this.view.diffOffset);
  }
  private async loadDiff(offset: number): Promise<void> {
    if (this.diffBusy) return;
    this.diffBusy = true;
    try {
      const id = this.client.snapshot?.id;
      if (!id || !this.client.workspace) return;
      const page = await call<DiffPage>(
        this.client.socket,
        `/v1/sessions/${id}/workspace/diff?offset=${offset}`,
      );
      if (this.client.snapshot?.id !== id) return;
      if (
        page.revision !== this.client.workspace?.revision ||
        page.digest !== this.client.workspace.digest
      ) {
        this.view.diff = undefined;
        this.client.report(
          'Workspace changed while loading the diff. Refresh to review its current revision.',
        );
        return;
      }
      this.view.diff = page;
      this.view.diffOffset = offset;
      this.tui.requestRender();
    } finally {
      this.diffBusy = false;
    }
  }
  private approvals(): void {
    const approvals = this.client.snapshot?.approvals.filter((a) => a.state === 'pending') ?? [];
    if (!approvals.length) {
      this.client.report('No approvals are waiting.');
      return;
    }
    const open = (id: string) =>
      void this.execute(async () => {
        const approval = approvals.find((a) => a.id === id)!;
        const reviewed = await this.client.review(approval);
        // Desk sessions can approve for the session or always; strict work only ever approves once.
        const rules = await this.client.approvalRules().catch(() => ({ applies: false }));
        this.showApproval(reviewed.approval, reviewed.operation, rules.applies);
      });
    if (approvals.length === 1) open(approvals[0]!.id);
    else
      this.choice(
        'Approvals waiting',
        approvals.map((approval) => ({
          value: approval.id,
          label:
            this.client.snapshot?.operations.find((op) => op.id === approval.operation_id)
              ?.target ?? shortId(approval.id),
          description: shortId(approval.id) + ' · revision ' + approval.revision,
        })),
        open,
      );
  }
  /** /permissions → Approval rules: list them, remove one, or add one in plain words. */
  private async approvalRules(): Promise<void> {
    const { applies, rules, problems } = await this.client.approvalRules();
    if (!applies) {
      this.client.report('Approval rules apply only to desk coding sessions.');
      return;
    }
    const describe = (r: import('./approval-rules.js').StoredRule) =>
      `${r.effect} ${r.tool} ${r.command ?? (r.paths ?? []).join(', ')}`.trim();
    this.choice(
      'Approval rules · deny beats ask beats allow · unmatched requests ask',
      [
        {
          value: 'add',
          label: 'Add a rule',
          description: 'e.g. allow command npm test *  ·  deny edit src/secrets/**',
        },
        ...rules.map((r) => ({
          value: 'rule:' + r.id,
          label: describe(r),
          description:
            r.source === 'user'
              ? 'From your permissions.json; edit that file to change it'
              : r.source === 'repo'
                ? 'Always, in this repo · choose to remove'
                : 'This session · choose to remove',
        })),
        ...problems.map((p, i) => ({ value: 'problem:' + i, label: 'Problem', description: p })),
      ],
      (value) => {
        if (value === 'add') {
          this.taskInput(
            'New approval rule',
            '',
            'effect tool words-or-paths',
            'allow|ask|deny, then command or edit, then command words (a final * takes any further words) or comma-separated path globs. Example: allow command git status',
            (text) => {
              const [effect, tool, ...rest] = text.trim().split(/\s+/);
              const target = rest.join(' ');
              const rule =
                tool === 'edit'
                  ? {
                      effect,
                      tool,
                      paths: target
                        .split(',')
                        .map((p) => p.trim())
                        .filter(Boolean),
                    }
                  : { effect, tool, command: target };
              this.choice(
                'Keep this rule for…',
                [
                  {
                    value: 'session',
                    label: 'This session',
                    description: 'Gone when the session ends',
                  },
                  {
                    value: 'repo',
                    label: 'This repo',
                    description: "Every desk session here; kept in Salaam's state",
                  },
                ],
                (scope) =>
                  void this.execute(() =>
                    this.client.addRule(
                      scope as 'session' | 'repo',
                      rule as import('./approval-rules.js').ApprovalRule,
                    ),
                  ),
              );
            },
          );
          return;
        }
        if (!value.startsWith('rule:')) return;
        const rule = rules.find((r) => 'rule:' + r.id === value)!;
        if (rule.source === 'user') {
          this.client.report(
            'This rule comes from your permissions.json; edit that file to change it.',
          );
          return;
        }
        this.confirm('Remove this rule?', describe(rule), 'remove', () =>
          this.client.removeRule(rule.id),
        );
      },
    );
  }
  private showApproval(
    approval: Approval,
    operation: import('./protocol.js').Operation,
    offerRules = false,
  ): void {
    this.showModal(
      new ApprovalModal(
        approval,
        operation,
        this.view.theme,
        () => this.terminal.rows,
        () => this.client.snapshot?.approvals.find((a) => a.id === approval.id),
        () => this.tui.requestRender(),
        () => this.closeModal(),
        (decision) => {
          this.closeModal();
          if (decision === 'approve' || decision === 'deny') {
            void this.execute(() => this.client.decide(approval, decision));
            return;
          }
          // The rule is the exact request just reviewed: its command words or its edited paths.
          // If it cannot become a rule (shell features, odd words), nothing is approved; say why.
          const approveWith = (scope: 'session' | 'repo') => async () => {
            // While the approval is pending the status line shows it, not a notice, so a
            // refused rule is shown where it cannot be missed.
            try {
              await this.client.ruleFromOperation(operation.id, scope);
            } catch (error) {
              this.showText(
                'Not saved as a rule',
                `${error instanceof Error ? error.message : String(error)}\n\nNothing was approved. Press ctrl+o to approve it once instead.`,
              );
              return;
            }
            await this.client.decide(approval, 'approve');
            this.client.report(
              scope === 'session'
                ? 'Approved, and the same request will be approved for the rest of this session.'
                : 'Approved, and the same request will always be approved in this repo. Remove it in /permissions.',
            );
          };
          if (decision === 'approve-session') void this.execute(approveWith('session'));
          else
            this.confirm(
              'Always allow in this repo?',
              `${safeText(operation.target)}

This exact request will be approved without asking in every desk session on this repository, until you remove it in /permissions. It is kept in Salaam's state, not in the repository.`,
              'always allow',
              approveWith('repo'),
            );
        },
        offerRules,
      ),
      86,
    );
  }
  private taskInput(
    title: string,
    initial: string,
    field: string,
    hint: string,
    submit: (value: string) => void,
  ): void {
    this.showModal(
      new FormModal(
        title,
        initial,
        this.view.theme,
        false,
        () => this.tui.requestRender(),
        () => this.closeModal(),
        (value) => {
          this.closeModal();
          submit(value);
        },
        { field, submit: 'continue', hint },
      ),
    );
  }
  private async permissionControls(): Promise<void> {
    const session = this.client.snapshot!.id;
    const current = await this.client.permissions();
    if (!current.configurable) {
      this.showText(
        'Managed permissions',
        'This session uses host-managed authority. Local permission presets cannot change station or specialist grants.',
      );
      return;
    }
    this.choice(
      'Permissions · ' + current.policy.mode + ' · revision ' + current.policy.revision,
      [
        {
          value: 'inspect-current',
          label: 'Inspect current policy',
          description: current.policy.paths.join(', ') || 'No automatic edit scopes',
        },
        {
          value: 'inspect',
          label: 'Inspect only',
          description: 'Deny future local mutations, including manually approved operations',
        },
        ...(current.coding
          ? [
              {
                value: 'rules',
                label: 'Approval rules',
                description: 'Allow, ask or deny by command words and path globs',
              },
              {
                value: 'review',
                label: 'Review every mutation',
                description: 'Explicit approval for each edit and unsandboxed shell command',
              },
              {
                value: 'scoped-edit',
                label: 'Auto-approve scoped edits',
                description: 'Exact files or directory prefixes; shell commands still ask',
              },
            ]
          : []),
      ],
      (mode) => {
        if (mode === 'rules') {
          void this.execute(() => this.approvalRules());
          return;
        }
        if (mode === 'inspect-current') {
          this.showText('Permissions and execution boundary', JSON.stringify(current, null, 2));
          return;
        }
        const apply = (paths: string[]) =>
          this.showModal(
            new TextModal(
              'Review permission policy',
              `Session ${session}\nWorkspace ${current.policy.root}\nMode ${mode}\nAuto-edit paths: ${paths.join(', ') || '(none)'}\nCommands ask unless an approval rule or the session mode allows them (auto allows only sandboxed commands). Commands run in the host OS sandbox unless full access is on. Progression and budgets remain unchanged. Already-running commands are not stopped.`,
              this.view.theme,
              () => this.terminal.rows,
              () => this.tui.requestRender(),
              () => this.closeModal(),
              undefined,
              () => {
                this.closeModal();
                void this.execute(() =>
                  this.client.setPermissions(session, current.policy.revision, {
                    mode: mode as import('./autonomy.js').PermissionMode,
                    paths,
                  }),
                );
              },
              'save permissions',
            ),
          );
        if (mode === 'scoped-edit')
          this.taskInput(
            'Auto-edit scopes',
            current.policy.paths.join(', '),
            'Comma-separated files or directories ending in /',
            'Example: src/, test/, README.md. No glob patterns or private paths. Other files still require review.',
            (text) =>
              apply(
                text
                  .split(',')
                  .map((p) => p.trim())
                  .filter(Boolean),
              ),
          );
        else apply([]);
      },
    );
  }
  private taskActions(progressionOnly = false): void {
    const task = this.client.snapshot?.work_task;
    if (!task) {
      const initial = JSON.stringify({
        objective: 'Describe the task',
        constraints: [],
        steps: [
          {
            key: 'work',
            title: 'Implement and inspect',
            instruction: 'Describe the task',
            depends_on: [],
            checks: ['tests'],
          },
        ],
        acceptance: [{ key: 'tests', command: 'node --test', cwd: '.' }],
        deliverables: [],
      });
      this.taskInput(
        'Create task · plan JSON',
        initial,
        'Paste the objective, steps, checks and deliverables',
        'Creates a saved plan. No work starts until explicitly requested.',
        (value) =>
          void this.execute(async () => {
            const plan = JSON.parse(value);
            this.confirm(
              'Create this task',
              String(plan.objective).slice(0, 256) +
                '\n' +
                (Array.isArray(plan.steps) ? plan.steps.length : 0) +
                ' saved steps. No work starts yet.\nReview the full plan in Context after creation.',
              'Create task',
              () => this.client.taskAction('create', { plan }),
            );
          }),
      );
      return;
    }
    const reviewed = { id: task.id, revision: task.revision };
    const items = [
      {
        value: 'inspect',
        label: 'Inspect task and verification',
        description: task.state + ' · revision ' + task.revision,
      },
      {
        value: 'plan',
        label: 'Revise task plan',
        description: 'Preserve history; attempted steps remain immutable',
      },
      {
        value: 'run',
        label: 'Start or continue one step',
        description: 'Explicit instruction · same durable task',
      },
      {
        value: 'review',
        label: 'Record operator step review',
        description: 'A review is separate from verified success',
      },
      {
        value: 'verify',
        label: 'Run an acceptance check',
        description: 'Actual isolated command outcome and workspace digest',
      },
      {
        value: 'finish',
        label: 'Verify task completion',
        description: 'Requires fresh checks and deliverables',
      },
      {
        value: 'auto',
        label: 'Run bounded task',
        description: 'Explicit step limit · checked steps · idle compaction',
      },
      {
        value: 'pause',
        label: 'Pause task progression',
        description: 'Current work may settle; no later steps start',
      },
      {
        value: 'checkpoint',
        label: 'Create task checkpoint',
        description: 'Capture the owned workspace at an idle boundary',
      },
      {
        value: 'restore',
        label: 'Restore task checkpoint',
        description: 'Preserve human edits and report conflicts',
      },
      {
        value: 'cancel',
        label: 'Cancel task',
        description: 'Stop work; uncertain external effects remain recorded',
      },
    ];
    this.choice(
      progressionOnly ? 'Bounded progression · permissions unchanged' : 'Salaam · task',
      progressionOnly
        ? items.filter((i) => ['inspect', 'plan', 'auto', 'pause'].includes(i.value))
        : items,
      (action) => {
        if (action === 'inspect')
          this.showModal(
            new TextModal(
              'Task · ' + task.id,
              JSON.stringify(task, null, 2),
              this.view.theme,
              () => this.view.rows() - 8,
              () => this.tui.requestRender(),
              () => this.closeModal(),
            ),
          );
        else if (action === 'plan')
          this.taskInput(
            'Revise task · plan JSON',
            JSON.stringify({
              objective: task.objective,
              constraints: task.constraints,
              steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
                key,
                title,
                instruction,
                depends_on,
                checks,
              })),
              acceptance: task.acceptance,
              deliverables: task.deliverables,
              limits: task.limits,
            }),
            'Review the complete revised plan',
            'Revising pauses progression and requires fresh verification.',
            (value) =>
              void this.execute(() =>
                this.client.taskAction('revise', { plan: JSON.parse(value) }, reviewed),
              ),
          );
        else if (action === 'run') {
          const eligible = task.steps.filter((s) =>
            ['pending', 'failed', 'cancelled', 'interrupted'].includes(s.state),
          );
          if (!eligible.length) {
            this.client.report('No step is eligible for an explicit run.');
            return;
          }
          this.choice(
            'Choose a saved step',
            eligible.map((s) => ({
              value: s.id,
              label: s.title,
              description: s.key + ' · ' + s.state,
            })),
            (id) => {
              const step = eligible.find((s) => s.id === id)!;
              this.taskInput(
                'Step instruction',
                step.state === 'interrupted' ? '' : step.instruction,
                'Review or enter the instruction',
                step.state === 'interrupted'
                  ? 'Inspect the interrupted outcome first; this creates a new attempt.'
                  : 'Dependencies and task limits are checked by the service.',
                (instruction) =>
                  void this.execute(() =>
                    this.client.taskAction(
                      `steps/${id}/run`,
                      {
                        instruction,
                        ...(step.state === 'interrupted'
                          ? { continues_attempt_id: step.attempt_id }
                          : {}),
                      },
                      reviewed,
                    ),
                  ),
              );
            },
          );
        } else if (action === 'review') {
          const steps = task.steps.filter((s) => s.state === 'awaiting_review');
          if (!steps.length) {
            this.client.report('No step awaits operator review.');
            return;
          }
          this.choice(
            'Review a settled step',
            steps.map((s) => ({ value: s.id, label: s.title, description: s.attempt_id ?? '' })),
            (id) =>
              this.taskInput(
                'Record operator review',
                '',
                'What did you inspect?',
                'This records your decision; fresh command receipts are still required for task success.',
                (review) =>
                  void this.execute(() =>
                    this.client.taskAction(`steps/${id}/complete`, { review }, reviewed),
                  ),
              ),
          );
        } else if (action === 'verify') {
          if (!task.acceptance.length) {
            this.client.report('Configure acceptance checks in the task plan first.');
            return;
          }
          this.choice(
            'Choose acceptance check',
            task.acceptance.map((c) => ({ value: c.key, label: c.key, description: c.command })),
            (key) =>
              void this.execute(() =>
                this.client.taskAction('verify', { check_key: key }, reviewed),
              ),
          );
        } else if (action === 'finish')
          this.confirm(
            'Verify task completion',
            'The service will recheck every configured command receipt and deliverable against the current workspace.',
            'Verify completion',
            () => this.client.taskAction('finish', {}, reviewed),
          );
        else if (action === 'auto')
          this.taskInput(
            'Bounded progression',
            String(task.steps.filter((s) => s.state === 'pending').length),
            'Maximum new steps (1–32)',
            'Steps advance only after their configured checks pass. Human approvals remain separate.',
            (value) => {
              const max_steps = Number(value);
              this.confirm(
                'Run this bounded plan',
                `Task ${shortId(task.id)} · plan revision ${task.plan_revision}\nAt most ${max_steps} new steps; each step needs fresh passing checks.\nLimits: ${task.limits.requests} requests · ${task.limits.runtime_ms} ms · ${task.limits.concurrency} concurrent executions.\n${task.limits.token_units === null ? 'Token budget disabled' : task.limits.token_units + ' declared token units'} · ${task.limits.verification_runs} verification runs.\nChecks: ${task.acceptance.map((c) => c.key).join(', ') || 'none'} · Deliverables: ${task.deliverables.length}.\nDeterministic compaction at idle boundaries. Human approvals remain separate.`,
                'Run bounded task',
                () => this.client.taskAction('auto', { max_steps, compact: true }, reviewed),
              );
            },
          );
        else if (action === 'pause')
          void this.execute(() =>
            this.client.taskAction('auto', { max_steps: 0, compact: false }, reviewed),
          );
        else if (action === 'checkpoint')
          void this.execute(() => this.client.taskAction('checkpoint', {}, reviewed));
        else if (action === 'restore')
          void this.execute(async () => {
            const checkpoints = await call<{ id: string; revision: number; digest: string }[]>(
              this.client.socket,
              `/v1/tasks/${task.id}/checkpoints`,
            );
            if (!checkpoints.length) {
              this.client.report('No checkpoints have been saved.');
              return;
            }
            this.choice(
              'Choose checkpoint',
              checkpoints.map((c) => ({
                value: c.id,
                label: 'Workspace revision ' + c.revision,
                description: c.digest,
              })),
              (checkpoint_id) => {
                const w = this.client.workspace;
                if (!w?.observed_digest) {
                  this.client.report('Refresh the owned workspace before restoring.');
                  return;
                }
                this.confirm(
                  'Restore reviewed task changes',
                  JSON.stringify(
                    {
                      checkpoint_id,
                      current_revision: w.revision,
                      current_digest: w.observed_digest,
                      human_edits: 'Preserved; conflicts are reported',
                      external_effects: 'Not rolled back',
                    },
                    null,
                    2,
                  ),
                  'Restore checkpoint',
                  () =>
                    this.client.taskAction(
                      'restore',
                      {
                        checkpoint_id,
                        workspace_revision: w.revision,
                        workspace_digest: w.observed_digest,
                      },
                      reviewed,
                    ),
                );
              },
            );
          });
        else if (action === 'cancel')
          this.confirm(
            'Cancel this task',
            'Current work is cancelled and later steps stop. Inspect any uncertain effects separately.',
            'Cancel task',
            () => this.client.taskAction('cancel', {}, reviewed),
          );
      },
    );
  }
  private jobActions(): void {
    const snapshot = this.client.snapshot,
      job = snapshot?.job,
      task = snapshot?.work_task;
    if (!snapshot || !task) {
      this.client.report('Create a checked task first.');
      return;
    }
    if (!job) {
      this.taskInput(
        'Create one-shot job · JSON',
        JSON.stringify({
          name: task.objective.slice(0, 100),
          max_steps: task.steps.length,
          compact: false,
        }),
        'Bind this task and its reviewed execution scope',
        'Creates an immutable definition. It stays idle until explicitly triggered.',
        (value) =>
          void this.execute(() =>
            this.client.jobAction('create', JSON.parse(value), {
              id: task.id,
              revision: task.revision,
            }),
          ),
      );
      return;
    }
    const reviewed = { id: job.id, revision: job.revision };
    this.choice(
      'Salaam · one-shot job',
      [
        {
          value: 'inspect',
          label: 'Inspect job binding',
          description: job.state + ' · ' + job.name,
        },
        {
          value: 'run',
          label: 'Trigger one-shot job',
          description: 'Stable logical key · same occurrence on retry',
        },
        {
          value: 'cancel',
          label: 'Cancel job',
          description: 'Revoke future grants and cancel active owned work',
        },
      ],
      (action) => {
        if (action === 'inspect')
          this.showModal(
            new TextModal(
              'Job · ' + job.id,
              JSON.stringify(job, null, 2),
              this.view.theme,
              () => this.view.rows() - 8,
              () => this.tui.requestRender(),
              () => this.closeModal(),
            ),
          );
        else if (action === 'run')
          this.taskInput(
            'One-shot occurrence key',
            job.occurrence?.occurrence_key ?? randomUUID(),
            'Use one stable key for this intentional run',
            'Binding ' +
              job.binding_digest.slice(0, 16) +
              ' · at most ' +
              job.max_steps +
              ' new steps. Existing task budgets and approvals apply.',
            (key) =>
              void this.execute(() =>
                this.client.jobAction('run', { occurrence_key: key }, reviewed),
              ),
          );
        else
          this.confirm(
            'Cancel one-shot job',
            'Cancels active owned work. Unknown external outcomes still require inspection.',
            'Cancel job',
            () => this.client.jobAction('cancel', {}, reviewed),
          );
      },
    );
  }
  private async schedules(offset = 0): Promise<void> {
    const page = await call<{
      jobs: (import('./recurring-work.js').RecurringJob & { schedule: unknown })[];
      next_offset: number | null;
    }>(this.client.socket, '/v1/schedules?offset=' + offset);
    this.choice(
      'Salaam · recurring jobs',
      [
        {
          value: 'create',
          label: 'Capture a recurring template',
          description: 'Reviewed task and exact workspace snapshot',
        },
        ...page.jobs.map((j) => ({
          value: j.id,
          label: j.name,
          description: j.state + ' · ' + j.id,
        })),
        ...(page.next_offset !== null
          ? [{ value: 'next', label: 'Next page', description: 'More recurring definitions' }]
          : []),
      ],
      (id) => {
        if (id === 'next') {
          void this.execute(() => this.schedules(page.next_offset!));
          return;
        }
        const task = this.client.snapshot?.work_task;
        if (id === 'create') {
          if (!task) {
            this.client.report('Create a checked task first.');
            return;
          }
          this.taskInput(
            'Recurring template · JSON',
            JSON.stringify({
              name: task.objective.slice(0, 100),
              max_steps: task.steps.length,
              compact: false,
              schedule: null,
            }),
            'Capture an immutable template',
            'Every occurrence receives fresh IDs and a workspace copy. Use null schedule for explicit triggers.',
            (value) =>
              void this.execute(() =>
                this.client.scheduleAction('create', JSON.parse(value), {
                  id: task.id,
                  revision: task.revision,
                }),
              ),
          );
          return;
        }
        const job = page.jobs.find((j) => j.id === id)!;
        this.choice(
          'Recurring · ' + job.name,
          [
            {
              value: 'inspect',
              label: 'Inspect definition and occurrences',
              description: job.template_digest,
            },
            {
              value: 'run',
              label: 'Trigger an occurrence',
              description: 'Stable logical key · overlap prevented',
            },
            {
              value: 'update',
              label: 'Revise schedule or pause/cancel',
              description: 'Template remains immutable',
            },
          ],
          (action) => {
            if (action === 'inspect') {
              void this.execute(async () => {
                const detail = await call(this.client.socket, `/v1/schedules/${job.id}`);
                this.showModal(
                  new TextModal(
                    'Recurring · ' + job.id,
                    JSON.stringify(detail, null, 2),
                    this.view.theme,
                    () => this.view.rows() - 8,
                    () => this.tui.requestRender(),
                    () => this.closeModal(),
                  ),
                );
              });
              return;
            }
            if (job.session_id !== this.client.snapshot?.id) {
              this.client.report(
                'Switch to template session ' + job.session_id + ' to change its schedule.',
              );
              return;
            }
            this.taskInput(
              action === 'run' ? 'Occurrence key' : 'Schedule revision · JSON',
              action === 'run'
                ? randomUUID()
                : JSON.stringify({ state: job.state, schedule: job.schedule }),
              'Review this admission',
              'Revisions affect future slots. Cancel revokes active owned work; pausing preserves it.',
              (value) =>
                void this.execute(() =>
                  this.client.scheduleAction(
                    action as 'run' | 'update',
                    action === 'run' ? { occurrence_key: value } : JSON.parse(value),
                    { id: job.id, revision: job.revision },
                  ),
                ),
            );
          },
        );
      },
    );
  }
  private async inbox(offset = 0): Promise<void> {
    const page = await call<{
      items: import('./operator-inbox.js').InboxEntry[];
      next_offset: number | null;
    }>(this.client.socket, '/v1/inbox?offset=' + offset);
    if (!page.items.length) {
      this.client.report('Operator inbox is clear.');
      return;
    }
    this.choice(
      'Salaam · operator inbox',
      [
        ...page.items.map((item) => ({
          value: item.id,
          label: item.kind + ' · ' + item.source_key,
          description: item.session_id + ' · r' + item.revision,
        })),
        ...(page.next_offset !== null
          ? [{ value: 'next', label: 'Next page', description: 'More saved attention' }]
          : []),
      ],
      (id) => {
        if (id === 'next') {
          void this.execute(() => this.inbox(page.next_offset!));
          return;
        }
        const item = page.items.find((i) => i.id === id)!;
        this.choice(
          'Attention · ' + item.kind,
          [
            {
              value: 'inspect',
              label: 'Inspect saved attention',
              description: 'Source ' + item.source_key,
            },
            {
              value: 'ack',
              label: 'Acknowledge this revision',
              description: 'No approval or retry is issued',
            },
          ],
          (action) => {
            if (action === 'inspect')
              this.showModal(
                new TextModal(
                  'Inbox · ' + item.id,
                  JSON.stringify(item, null, 2),
                  this.view.theme,
                  () => this.view.rows() - 8,
                  () => this.tui.requestRender(),
                  () => this.closeModal(),
                ),
              );
            else if (this.client.snapshot?.id !== item.session_id)
              this.client.report(
                'Switch to session ' + item.session_id + ' to acknowledge its attention.',
              );
            else
              this.confirm(
                'Acknowledge attention',
                'This clears only the saved attention revision. It does not decide an approval or retry work.',
                'Acknowledge',
                async () => {
                  await this.client.ackInbox(item.id, item.revision);
                },
              );
          },
        );
      },
    );
  }
  private palette(): void {
    const snapshot = this.client.snapshot;
    const items = [
      ...SLASH_COMMANDS.filter((c) => c.kind !== 'unavailable').map((c) => ({
        value: 'slash:' + c.name,
        label: '/' + c.name,
        description: c.description,
      })),
      {
        value: 'schedules',
        label: 'Recurring jobs and schedules',
        description: 'Immutable templates · fresh bounded occurrences',
      },
      {
        value: 'inbox',
        label: 'Operator inbox',
        description: 'Shared durable attention and results',
      },
      {
        value: 'model',
        label: 'Choose model and provider',
        description: '/model · switches this session',
      },
      { value: 'help', label: 'Slash commands', description: '/help' },
      { value: 'new', label: 'New session', description: 'ctrl+n' },
      {
        value: 'coding',
        label: 'New local coding session',
        description: '/coding · reviewed edits and local commands',
      },
      { value: 'sessions', label: 'Switch session', description: 'ctrl+p' },
      { value: 'conversation', label: 'Conversation', description: 'Messages and live progress' },
      {
        value: 'task',
        label: 'Task actions',
        description: 'Saved plan, verification, bounded progression and checkpoints',
      },
      {
        value: 'jobs',
        label: 'Job actions',
        description: 'Bound one-shot admission and durable occurrence recovery',
      },
      { value: 'changes', label: 'Review changes', description: 'ctrl+g · guarded workspace diff' },
      { value: 'commands', label: 'Commands and output', description: 'ctrl+t' },
      {
        value: 'context',
        label: 'Session context',
        description: 'Identity, task facts, child results and usage',
      },
      {
        value: 'history',
        label: 'Browse full history',
        description: 'Older entries, including before compaction',
      },
      {
        value: 'artifact',
        label: 'Read artifact',
        description: 'Read saved evidence without acknowledging it',
      },
      {
        value: 'tool',
        label: 'Inspect tool activity',
        description: 'Review captured input and outcome',
      },
      {
        value: 'approvals',
        label: 'Review approvals',
        description: 'ctrl+o · exact bound decisions',
      },
      { value: 'control', label: 'Take control', description: 'Keep the same session and work' },
      {
        value: 'resume',
        label: 'Resume worker',
        description: 'Restore the same conversation; interrupted instructions stay explicit',
      },
      {
        value: 'continue',
        label: 'Continue interrupted work',
        description: 'Enter a new instruction for the saved interruption',
      },
      {
        value: 'logs',
        label: 'Command logs',
        description: 'Inspect captured output and exit status',
      },
      {
        value: 'cancel-command',
        label: 'Cancel a command',
        description: 'Remove its isolated process tree',
      },
      {
        value: 'cancel',
        label: 'Cancel current work',
        description: 'Explicitly cancel a running instruction',
      },
      { value: 'refresh', label: 'Refresh connection', description: 'ctrl+r' },
      {
        value: 'editor',
        label: 'Edit prompt externally',
        description: 'ctrl+e · VISUAL or EDITOR',
      },
      {
        value: 'theme',
        label:
          this.view.theme.name === 'night' ? 'Theme · switch to Paper' : 'Theme · switch to Night',
        description: 'Salaam’s two native terminal palettes',
      },
      {
        value: 'rail',
        label: 'Toggle workspace rail',
        description: 'ctrl+b · shown on wide terminals',
      },
      { value: 'help', label: 'Keyboard help', description: 'F1' },
      { value: 'stop', label: 'Stop service', description: 'Separate from detach and cancel' },
    ];
    this.choice('Salaam · actions', items, (value) => {
      if (value.startsWith('slash:')) {
        const name = value.slice(6);
        const definition = SLASH_COMMANDS.find((c) => c.name === name)!;
        if (definition.arguments?.startsWith('<')) {
          this.editor.setText('/' + name + ' ');
          this.tui.setFocus(this.editor);
        } else void this.execute(() => this.runSlashCommand(name));
        return;
      }
      if (['conversation', 'changes', 'commands', 'context'].includes(value)) {
        this.setTab(value as ViewTab);
        return;
      }
      if (value === 'model') this.modelPicker();
      else if (value === 'help') void this.execute(() => this.runSlashCommand('help'));
      else if (value === 'coding') void this.execute(() => this.newSession(true));
      else if (value === 'new') void this.execute(() => this.newSession());
      else if (value === 'task') this.taskActions();
      else if (value === 'jobs') this.jobActions();
      else if (value === 'schedules') void this.execute(() => this.schedules());
      else if (value === 'inbox') void this.execute(() => this.inbox());
      else if (value === 'sessions') void this.execute(() => this.sessions());
      else if (value === 'approvals') this.approvals();
      else if (value === 'history') void this.execute(() => this.history());
      else if (value === 'artifact')
        this.showModal(
          new FormModal(
            'Read artifact · paste its ID',
            '',
            this.view.theme,
            false,
            () => this.tui.requestRender(),
            () => this.closeModal(),
            (id) => {
              this.closeModal();
              void this.execute(() => this.evidence('artifact_id', id));
            },
          ),
        );
      else if (value === 'tool') this.tools();
      else if (value === 'control')
        this.confirm(
          'Take control',
          'Another operator may be controlling this session. Taking control preserves its running work and changes who may send instructions.',
          'Take control',
          () => this.client.takeControl(),
        );
      else if (value === 'resume') void this.execute(() => this.client.resume());
      else if (value === 'continue') {
        const interrupted = snapshot?.attempts.find(
          (a) => a.state === 'interrupted' && !a.resolved_by,
        );
        if (!interrupted) this.client.report('No unresolved interruption in this session.');
        else {
          this.view.continuation = interrupted.id;
          this.client.notice = 'Enter a new instruction to continue the interrupted attempt.';
          this.view.tab = 'conversation';
          this.tui.setFocus(this.editor);
          this.tui.requestRender();
        }
      } else if (value === 'logs') this.commandPicker(false);
      else if (value === 'cancel-command') this.commandPicker(true);
      else if (value === 'cancel') {
        const attempt = snapshot?.attempts.find((a) =>
          ['accepted', 'dispatching', 'running'].includes(a.state),
        );
        if (!attempt) this.client.report('No active instruction to cancel.');
        else
          this.confirm(
            'Cancel current work',
            'Cancel attempt ' + attempt.id + '? Detaching would leave it running.',
            'Cancel work',
            () => this.client.cancel(attempt.id),
          );
      } else if (value === 'refresh') void this.execute(() => this.refresh());
      else if (value === 'editor') void this.execute(() => this.editPrompt());
      else if (value === 'theme') {
        this.view.theme = new SalaamTheme(this.view.theme.name === 'night' ? 'paper' : 'night');
        this.document.invalidate();
        this.tui.requestRender(true);
      } else if (value === 'rail') {
        this.rail = !this.rail;
        this.tui.requestRender(true);
      } else if (value === 'help') this.help();
      else if (value === 'stop')
        this.confirm(
          'Stop Salaam service',
          'This interrupts model work in every session using this service. Running commands may require reconciliation after restart. Closing this terminal would simply detach.',
          'Stop service',
          async () => {
            await this.client.shutdown();
            this.finish();
          },
        );
    });
  }
  private commandPicker(cancel: boolean): void {
    const commands = this.client.commands.filter((run) => !cancel || !commandTerminal(run.state));
    if (!commands.length) {
      this.client.report(cancel ? 'No active commands to cancel.' : 'No command output yet.');
      return;
    }
    this.choice(
      cancel ? 'Cancel a command' : 'Command output',
      commands.map((run) => ({
        value: run.id,
        label: run.command,
        description: run.state + ' · ' + shortId(run.id) + ' · revision ' + run.workspace_revision,
      })),
      (id) => {
        if (cancel)
          this.confirm(
            'Cancel command',
            'Cancel command ' + id + ' and its owned descendants?',
            'Cancel command',
            () => this.client.cancelCommand(id),
          );
        else {
          this.view.log = { id, text: '', offset: 0, complete: false };
          this.logBytes = Buffer.alloc(0);
          this.setTab('commands');
          void this.execute(() => this.loadLogs());
        }
      },
    );
  }
  private async loadLogs(): Promise<void> {
    if (this.logBusy || !this.view.log) return;
    this.logBusy = true;
    const selected = this.view.log,
      id = this.client.snapshot?.id;
    try {
      for (let n = 0; n < 8; n++) {
        const page = await this.client.commandLogs(selected.id, selected.offset);
        if (this.client.snapshot?.id !== id || this.view.log !== selected) return;
        const data = Buffer.from(page.data, 'base64');
        if (page.next_offset !== selected.offset + data.length)
          throw new Error('Command output offset changed.');
        if (this.logBytes.length + data.length > 65536)
          throw new Error('Command output exceeds its capture limit.');
        this.logBytes = Buffer.concat([this.logBytes, data]);
        selected.offset = page.next_offset;
        selected.text = this.logBytes.toString('utf8');
        selected.complete = page.complete;
        if (page.complete || !data.length) break;
      }
      this.tui.requestRender();
    } catch (error) {
      this.client.report(error);
    } finally {
      this.logBusy = false;
    }
  }
  private async history(offset = 0): Promise<void> {
    const id = this.client.snapshot?.id;
    if (!id) return;
    const page = await call<{ entries: { entry_id: string }[]; next_offset: number | null }>(
      this.client.socket,
      `/v1/sessions/${id}/history?offset=${offset}`,
    );
    this.choice(
      'Session history · entries ' + (offset + 1) + '–' + (offset + page.entries.length),
      [
        ...page.entries.map((entry) => ({ value: entry.entry_id, label: entry.entry_id })),
        ...(page.next_offset === null ? [] : [{ value: 'next-page', label: 'Next page →' }]),
      ],
      (value) =>
        void this.execute(() =>
          value === 'next-page'
            ? this.history(page.next_offset!)
            : this.evidence('entry_id', value),
        ),
    );
  }
  private async evidence(
    kind: 'entry_id' | 'artifact_id',
    value: string,
    offset = 0,
  ): Promise<void> {
    const id = this.client.snapshot?.id;
    if (!id) return;
    const page = await call<{ text: string; next_offset: number | null }>(
      this.client.socket,
      `/v1/sessions/${id}/history?${kind}=${encodeURIComponent(value)}&offset=${offset}`,
    );
    if (this.client.snapshot?.id !== id) return;
    this.showModal(
      new TextModal(
        (kind === 'entry_id' ? 'History · ' : 'Artifact · ') + shortId(value),
        page.text,
        this.view.theme,
        () => this.terminal.rows,
        () => this.tui.requestRender(),
        () => this.closeModal(),
        page.next_offset === null
          ? undefined
          : () => void this.execute(() => this.evidence(kind, value, page.next_offset!)),
      ),
      100,
    );
  }
  private tools(): void {
    const events = this.client.activity.filter((event) => event.kind === 'tool.started');
    if (!events.length) {
      this.client.report('No recorded tool activity yet.');
      return;
    }
    this.choice(
      'Tool activity',
      events.map((event) => ({
        value: String(event.seq),
        label: event.payload.tool,
        description: shortId(event.payload.attempt_id) + ' · ' + event.payload.tool_call_id,
      })),
      (value) => {
        const event = events.find((event) => String(event.seq) === value)!;
        const p = event.payload;
        const outcome = this.client.activity.find(
          (other) =>
            other.kind === 'tool.finished' &&
            other.payload.attempt_id === p.attempt_id &&
            other.payload.tool_call_id === p.tool_call_id,
        );
        this.showModal(
          new TextModal(
            'Tool · ' + p.tool,
            `Attempt: ${p.attempt_id}\nTool call: ${p.tool_call_id}\nOutcome: ${outcome ? (outcome.payload.failed ? 'failed' : 'finished') : 'running or not captured'}\nInput${p.input_truncated ? ' (truncated; full digest recorded)' : ''}:\n${p.input ?? '(not captured)'}`,
            this.view.theme,
            () => this.terminal.rows,
            () => this.tui.requestRender(),
            () => this.closeModal(),
          ),
          100,
        );
      },
    );
  }
  private help(): void {
    this.choice(
      'Salaam · keyboard',
      [
        {
          value: 'close',
          label: 'Enter · send the exact prompt',
          description: 'The durable outbox saves it before delivery',
        },
        {
          value: 'close',
          label: 'Alt+Enter / Ctrl+J · new line',
          description: 'Shift+Enter also works with supported keyboard protocols',
        },
        {
          value: 'close',
          label: 'Ctrl+K · all actions',
          description: 'Ctrl+P sessions · Ctrl+N new session · Ctrl+O approvals',
        },
        {
          value: 'close',
          label: 'Tab · switch view',
          description: 'Conversation · Changes · Commands · Context',
        },
        {
          value: 'close',
          label: 'PageUp / PageDown · scroll',
          description: 'Mouse wheel also scrolls; Ctrl+Home/End jump to the top/bottom',
        },
        {
          value: 'close',
          label: 'Ctrl+E · external prompt editor',
          description: 'Runs VISUAL or EDITOR with terminal modes restored',
        },
        {
          value: 'close',
          label: 'Ctrl+C · detach',
          description: 'Work continues. Cancel and stop service are separate actions.',
        },
      ],
      () => {},
    );
  }
  private async editPrompt(): Promise<void> {
    const [command, ...args] = editorArguments(process.env.VISUAL ?? process.env.EDITOR ?? 'vi');
    const dir = mkdtempSync(join(tmpdir(), 'salaam-prompt-')),
      path = join(dir, 'prompt.md');
    writeFileSync(path, this.editor.getExpandedText(), { mode: 0o600 });
    this.tui.stop({ preserveScreen: true });
    try {
      const child = spawn(command!, [...args, path], { stdio: 'inherit' });
      this.editorProcess = child;
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? resolve() : reject(new Error('Editor exited with status ' + code)),
        );
      });
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error('Prompt editor result must be a regular file up to 64 KiB.');
        const data = Buffer.alloc(65537);
        const count = readSync(fd, data, 0, data.length, 0);
        if (count > 65536) throw new Error('Prompt editor result is too large.');
        this.editor.setText(safeText(data.subarray(0, count).toString('utf8')));
      } finally {
        closeSync(fd);
      }
    } finally {
      this.editorProcess = undefined;
      rmSync(dir, { recursive: true, force: true });
      if (this.running) {
        this.tui.start();
        this.terminal.setTitle('Salaam');
        this.tui.setFocus(this.editor);
        this.tui.requestRender(true);
      }
    }
  }
  private async initialize(): Promise<void> {
    await this.execute(async () => {
      if (this.options.start) return this.openHere(this.options.start);
      await this.client.list();
      if (this.options.session)
        await this.client.open(this.options.session, {
          observe: this.options.observe,
          takeover: this.options.takeover,
        });
      else if (this.client.sessions.length) await this.sessions();
      else if (this.client.connection === 'offline') {
        this.client.notice = 'Service is offline. Ctrl+n starts a new workspace.';
        this.tui.requestRender();
      }
    });
  }
  /** One command for this folder: start the service if needed, then continue the folder's
   * latest session, start a new coding session in it, or show the session list. */
  private async openHere(start: import('./session-pick.js').CodeStart): Promise<void> {
    const { latestSessionFor, deskUsesAnthropic } = await import('./session-pick.js');
    await this.startService();
    if (
      deskUsesAnthropic(
        !!this.selectedRoute,
        this.client.health?.provider_route.provider,
        existsSync(credentialPath()) || existsSync(credentialPath() + '.json'),
      )
    )
      this.selectedRoute = providerRoute('anthropic');
    if (start === 'resume') return this.sessions();
    const cwd = resolve(this.options.cwd ?? process.cwd());
    const existing = start === 'continue' ? latestSessionFor(this.client.sessions, cwd) : undefined;
    if (existing)
      await this.client.open(existing, {
        observe: this.options.observe,
        takeover: this.options.takeover,
      });
    else await this.client.create(cwd, false, this.selectedRoute, true);
    this.setTab('conversation');
  }
  async run(): Promise<void> {
    this.running = true;
    const close = () => {
      this.running = false;
      this.editorProcess?.kill('SIGTERM');
      this.tui.stop({ preserveScreen: true });
      this.finish();
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, close);
    process.stdin.once('end', close);
    process.stdout.once('error', close);
    try {
      process.stdout.write('\x1b[22;0t');
      this.tui.start();
      this.terminal.setTitle('Salaam');
      this.painter = setInterval(() => {
        if (
          this.client.preview ||
          this.client.snapshot?.approvals.some((a) => a.state === 'pending') ||
          this.client.commands.some((run) => !commandTerminal(run.state))
        )
          this.tui.requestRender();
      }, 1000);
      await this.initialize();
      await this.done;
    } finally {
      this.running = false;
      clearInterval(this.painter);
      this.removeInput();
      this.closeModal();
      this.tui.stop({ preserveScreen: true });
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, close);
      process.stdin.off('end', close);
      process.stdout.off('error', close);
      await this.terminal.drainInput(150, 25);
      process.stdin.pause();
      process.stdin.unref();
      process.stdout.write('\x1b[23;0t');
      const detachedSession = this.client.snapshot?.id;
      await this.client.close();
      process.stdout.write('Detached from Salaam. Work continues in the service.\n');
      if (detachedSession)
        process.stdout.write('Reattach with sal attach ' + detachedSession + '\n');
    }
  }
}
export async function tui(options: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'The Salaam TUI needs an interactive terminal. Use salaam --help for scriptable commands.',
    );
  if (process.env.TERM === 'dumb')
    throw new Error('Use sal attach SESSION_ID --plain in a terminal without cursor controls.');
  if (options.observe && options.takeover)
    throw new Error('Choose either --observe or --takeover.');
  if (options.session && !/^[a-f0-9-]{36}$/i.test(options.session))
    throw new Error('Use the saved session UUID.');
  await new SalaamApp(options).run();
}
