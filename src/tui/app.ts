import {
  Editor,
  TuiAltScreen,
  ScrollView,
  VStack,
  HStack,
  matchesKey,
  type Component,
  type OverlayHandle,
  type KeyId,
} from '@earendil-works/pi-tui';
import {
  extractMentions,
  isSensitivePath,
  expandCustomCommand,
  loadCustomCommands,
  matchCustomCommand,
  type CustomCommand,
} from '../runtime/index.js';
import { MentionAutocompleteProvider } from './mentions.js';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  interactiveCoding,
  queuedItems,
  runningAttempt,
  turnKey,
  turnKeyAction,
} from './turn-keys.js';
import { join, basename } from 'node:path';
import {
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
import {
  type ProviderRoute,
  SLASH_COMPLETIONS,
  parseSlashCommand,
  call,
  commandTerminal,
} from '../core/index.js';
import { notificationFor, notify, notifyMode } from './notify.js';
import type { DurableEvent } from '../core/index.js';
import { OperatorClient } from './client.js';
import { SalaamTheme, safeText, shortId, type ThemeName } from './theme.js';
import {
  Dynamic,
  DocumentView,
  header,
  tabs,
  status,
  sidebar,
  type ViewModel,
  type ViewTab,
  type DiffPage,
} from './view.js';
import { ChoiceModal, FormModal, ConfirmModal, TextModal } from './modals.js';
import { GLOBAL_KEYS, keySheet, type GlobalAction } from './keymap.js';
import { imagesInPrompt, readClipboardImage, type PastedImage } from './clipboard-image.js';
import { HerdrReporter, statusEnabled, terminalState, titleFor } from './terminal-status.js';
import { ComposerHistory, ctrlCAction, historyPath, shellPassthrough } from './composer.js';
import { editorArguments, SalaamTerminal } from './terminal.js';
import { searchKey, startSearch, type SearchState } from './history-search.js';
import type { CodeStart } from './session-pick.js';
import { runSlashCommand } from './commands/registry.js';
import { approvals } from './panels/approvals.js';
import { loadReview, reviewKey } from './panels/changes.js';
import { applyRoute, modelPicker } from './panels/model.js';
import { palette, type PaletteContext } from './panels/palette.js';
import { cycleMode, loadMode } from './panels/permissions.js';
import { newSessionForm, openHere, sessionPicker, startService } from './panels/sessions.js';

export { editorArguments, SalaamTerminal } from './terminal.js';

export interface TuiOptions {
  state: string;
  session?: string;
  observe?: boolean;
  takeover?: boolean;
  theme?: ThemeName;
  cwd?: string;
  codingRoot?: string;
  codingSocket?: string;
  /** Your own custom commands folder; defaults to ~/.config/salaam/commands. */
  commandsDir?: string;
  /** `salaam code`: open this folder directly (step 0, 2026-10-31). */
  start?: CodeStart;
}
/** The terminal app: lifecycle, layout and render, input routing, and the modal flow that panels
 * and slash commands use (it is their context). */
export class SalaamApp implements PaletteContext {
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
  selectedRoute?: ProviderRoute;
  private modal?: OverlayHandle;
  finish!: () => void;
  private readonly done: Promise<void>;
  private running = false;
  private editorProcess?: ChildProcess;
  private painter?: NodeJS.Timeout;
  private logBusy = false;
  private diffBusy = false;
  private pendingAction?: () => void;
  private logBytes = Buffer.alloc(0);
  private readonly drafts = new Map<string, string>();
  /** Images pasted with Ctrl+V, by the number in their `[image #N]` marker. */
  private readonly pasted = new Map<number, PastedImage>();
  private pastes = 0;
  private lastSession?: string;
  private lastRevision?: number;
  private readonly historyKeys = new Set<string>();
  /** Messages this user sent, kept across sessions without secret-looking lines (Ctrl+R searches it). */
  readonly sent = new ComposerHistory(historyPath());
  /** When Ctrl+C was last pressed on an empty composer; a second press within 2 s leaves. */
  private ctrlCArmed?: number;
  /** Reverse history search in progress: the query, the matching entry and the draft it replaces. */
  search?: SearchState;
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
    for (const entry of this.sent.entries) this.editor.addToHistory(entry);
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
      // Starting a command reloads this workspace's custom commands into the completion list.
      if (clean === '/') this.refreshCommandCompletions();
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
    this.client.on('durable', (event: DurableEvent) => {
      const message = notificationFor(event);
      if (message) notify(message, notifyMode());
    });
  }
  private contentWidth(): number {
    return Math.max(
      1,
      this.terminal.columns - (this.rail && this.terminal.columns >= 104 ? 31 : 0),
    );
  }
  // Trial polish C: the window title and Herdr say working / needs you / idle.
  private readonly statusOn = statusEnabled();
  private herdr = new HerdrReporter();
  private lastTitle?: string;
  private reportStatus(): void {
    if (!this.statusOn) return;
    const snapshot = this.client.snapshot;
    const state = terminalState(snapshot);
    const name = snapshot
      ? (this.client.names[snapshot.id] ?? (snapshot.cwd ? basename(snapshot.cwd) : undefined))
      : undefined;
    const title = titleFor(state, name);
    if (title !== this.lastTitle) {
      this.lastTitle = title;
      this.terminal.setTitle(title);
    }
    this.herdr.report(state, snapshot?.id);
  }
  private changed(): void {
    const snapshot = this.client.snapshot;
    this.reportStatus();
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
      for (const submission of [...snapshot.submissions].toReversed())
        if (!this.historyKeys.has(submission.id)) {
          this.historyKeys.add(submission.id);
          this.editor.addToHistory(submission.text);
        }
      // Phase 2b: the status line shows this session's mode; reload it when the session changes.
      if (this.client.snapshot?.id !== this.modeSession) {
        this.modeSession = this.client.snapshot?.id;
        void loadMode(this).catch(() => {});
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
    if (this.search) {
      searchKey(this, this.search, data);
      this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.ctrlC();
      return { consume: true };
    }
    this.ctrlCArmed = undefined;
    if (matchesKey(data, 'ctrl+d') && !this.editor.getExpandedText()) {
      this.finish();
      return { consume: true };
    }
    if (this.modal) return;
    if (matchesKey(data, 'ctrl+r')) {
      startSearch(this);
      return { consume: true };
    }
    // The terminal pastes only text; Ctrl+V reads an image from the system clipboard.
    if (matchesKey(data, 'ctrl+v')) {
      void this.execute(() => this.pasteImage());
      return { consume: true };
    }
    if (
      this.editor.isShowingAutocomplete() &&
      (matchesKey(data, 'enter') || matchesKey(data, 'tab') || matchesKey(data, 'escape'))
    )
      return;
    if (data === '?' && this.editor.getExpandedText() === '') {
      this.help();
      return { consume: true };
    }
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
        const images = imagesInPrompt(text, this.pasted);
        if (action === 'steer') {
          if (images.length)
            throw new Error(
              'Steering carries text only. Press Tab to queue the message with its image.',
            );
          await this.client.steer(text);
        } else {
          await this.client.submit(text, undefined, false, images);
          this.sentImages(images);
          const waiting = this.client.snapshot ? queuedItems(this.client.snapshot).length : 0;
          this.client.report(
            'Queued for after this turn (' + waiting + ' waiting). /queue edits or removes them.',
          );
        }
        this.editor.addToHistory(text);
        this.sent.add(text);
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
    // Ctrl+K kills to the end of the line while the composer has text (readline); on an empty
    // composer it opens the actions palette. F2 always opens it.
    if (matchesKey(data, 'ctrl+k') && this.editor.getExpandedText() !== '') return;
    const actions = this.globalActions();
    const keys: [KeyId, () => void][] = GLOBAL_KEYS.map((k) => [k.key, () => actions[k.action]()]);
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
    if (this.view.tab === 'changes' && interactiveCoding(this.client.snapshot)) {
      const handled = reviewKey(this, data);
      if (handled) return handled;
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
  /** What each key in GLOBAL_KEYS does; the table owns the keys, this owns the actions. */
  private globalActions(): Record<GlobalAction, () => void> {
    return (this.actionTable ??= {
      palette: () => palette(this),
      sessions: () => void this.execute(() => this.sessions()),
      new: () => void this.execute(() => this.newSession()),
      approvals: () => approvals(this),
      changes: () => this.setTab('changes'),
      commands: () => this.setTab('commands'),
      rail: () => this.toggleRail(),
      transcript: () => {
        this.view.transcript = !this.view.transcript;
        this.setTab('conversation');
      },
      refresh: () => void this.execute(() => this.refresh()),
      editor: () => void this.execute(() => this.editPrompt()),
      mode: () => void this.execute(() => cycleMode(this)),
      help: () => this.help(),
    });
  }
  private actionTable?: Record<GlobalAction, () => void>;
  async execute(work: () => Promise<unknown>): Promise<void> {
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
  closeModal(): void {
    this.modal?.hide();
    this.modal = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }
  showModal(component: Component, width = 78): void {
    this.closeModal();
    this.modal = this.tui.showOverlay(component, {
      anchor: 'center',
      width: Math.max(20, Math.min(width, this.terminal.columns - 4)),
      maxHeight: Math.max(1, this.terminal.rows - 2),
    });
    this.tui.requestRender();
  }
  choice(
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
  confirm(
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
  startService(): Promise<void> {
    return startService(this);
  }
  /** Interactive sessions switch in place between turns; otherwise the choice opens a new session. */
  applyRoute(route: ProviderRoute): Promise<void> {
    return applyRoute(this, route);
  }
  modelPicker(): void {
    modelPicker(this);
  }
  private modeSession: string | undefined;
  showText(title: string, text: string): void {
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
  runSlashCommand(command: string, args = ''): Promise<void> {
    return runSlashCommand(this, command, args);
  }
  newSession(localCoding = false): Promise<void> {
    return newSessionForm(this, localCoding);
  }
  sessions(): Promise<void> {
    return sessionPicker(this);
  }
  private commandCache?: { root: string; at: number; commands: CustomCommand[] };
  customCommandProblems: string[] = [];
  /** This workspace's and your own custom commands, reread at most every two seconds. */
  customCommands(): CustomCommand[] {
    const root = this.client.snapshot?.cwd ?? this.options.cwd ?? process.cwd();
    const cached = this.commandCache;
    if (cached && cached.root === root && Date.now() - cached.at < 2000) return cached.commands;
    const { commands, problems } = loadCustomCommands(root, this.options.commandsDir);
    this.customCommandProblems = problems;
    this.commandCache = { root, at: Date.now(), commands };
    return commands;
  }
  private refreshCommandCompletions(): void {
    const root = this.client.snapshot?.cwd ?? this.options.cwd ?? process.cwd();
    this.editor.setAutocompleteProvider(
      new MentionAutocompleteProvider(
        [
          ...SLASH_COMPLETIONS,
          ...this.customCommands().map((c) => ({
            name: c.name,
            description: `${c.description} [${c.scope}]`,
          })),
        ],
        root,
      ),
    );
  }
  /** Put the clipboard's image in the message as an `[image #N]` marker. */
  private async pasteImage(): Promise<void> {
    const image = await readClipboardImage();
    if (!image) {
      this.client.report(
        'No image on the clipboard. Paste text with your terminal (Cmd+V, or Ctrl+Shift+V).',
      );
      return;
    }
    const n = ++this.pastes;
    this.pasted.set(n, image);
    this.editor.insertTextAtCursor(`[image #${n}] `);
    this.tui.requestRender();
  }
  /** A sent image is in the outbox now; the composer no longer holds it. */
  private sentImages(images: { label: string }[]): void {
    for (const i of images) this.pasted.delete(Number(i.label.slice('image #'.length)));
  }
  private async submit(): Promise<void> {
    const text = this.editor.getExpandedText(),
      session = this.client.snapshot?.id,
      continuation = this.view.continuation;
    if (!text.trim()) return;
    const shell = shellPassthrough(text);
    if (shell) {
      if (!session) throw new Error('Create or choose a session with ctrl+n or ctrl+p first.');
      if (!interactiveCoding(this.client.snapshot))
        throw new Error('!command works in local coding sessions (salaam code).');
      await this.deliver(shell, session, continuation, false, text);
      return;
    }
    // A custom command only writes a prompt; built-in names never reach here (they are refused at
    // load), and the expanded prompt goes through every check an ordinary message does.
    const custom = text.trim().startsWith('/')
      ? matchCustomCommand(text, this.customCommands())
      : null;
    if (custom) {
      if (!session) throw new Error('Create or choose a session with ctrl+n or ctrl+p first.');
      const prompt = expandCustomCommand(custom.command, custom.args);
      if (Buffer.byteLength(prompt) > 65536)
        throw new Error(`/${custom.command.name} expands past 64 KiB. Shorten the command file.`);
      const secrets = extractMentions(prompt).filter(isSensitivePath);
      const send = (sensitive: boolean) =>
        this.deliver(prompt, session, continuation, sensitive, text);
      if (secrets.length) {
        this.confirm(
          'Attach secret-looking files?',
          `/${custom.command.name} mentions ${secrets.map((s) => '@' + s).join(', ')}, which will be sent to the model in full.`,
          'Attach and send',
          () => send(true),
        );
        return;
      }
      await send(false);
      return;
    }
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
    /** What was typed, when it differs from what is sent (a custom command). */
    typed = text,
  ): Promise<void> {
    const images = imagesInPrompt(typed, this.pasted);
    await this.client.submit(text, continuation, confirmSensitive, images);
    this.sentImages(images);
    this.editor.addToHistory(typed);
    this.sent.add(typed);
    if (this.client.snapshot?.id === session && this.editor.getExpandedText() === typed) {
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
    if (tab === 'changes') void this.execute(() => this.loadChanges());
    this.tui.requestRender();
  }
  /** A local coding session reviews its folder against the review base; a coding workspace
   * keeps its guarded diff. */
  private loadChanges(): Promise<void> {
    return interactiveCoding(this.client.snapshot)
      ? loadReview(this)
      : this.loadDiff(this.view.diffOffset);
  }
  private resetScroll(): void {
    if (this.view.tab === 'conversation' || this.view.tab === 'commands') this.scroll.scrollToEnd();
    else this.scroll.scrollTo(0, { disableFollow: true });
  }
  async refresh(): Promise<void> {
    await this.client.refresh();
    if (this.view.tab === 'changes') await this.loadChanges();
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
  taskInput(
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
  /** Show a command's captured output in the Commands tab. */
  openLog(id: string): void {
    this.view.log = { id, text: '', offset: 0, complete: false };
    this.logBytes = Buffer.alloc(0);
    this.setTab('commands');
    void this.execute(() => this.loadLogs());
  }
  toggleTheme(): void {
    this.view.theme = new SalaamTheme(this.view.theme.name === 'night' ? 'paper' : 'night');
    this.document.invalidate();
    this.tui.requestRender(true);
  }
  toggleRail(): void {
    this.rail = !this.rail;
    this.tui.requestRender(true);
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
  /** The keys for where you are: `?` on an empty composer, or F1. Built from tui-keymap.ts. */
  help(): void {
    const snapshot = this.client.snapshot;
    const sheet = keySheet({
      tab: this.view.tab,
      coding: interactiveCoding(snapshot),
      running: interactiveCoding(snapshot) && runningAttempt(snapshot) !== undefined,
      custom: this.customCommands(),
    });
    this.choice(
      sheet.title,
      sheet.rows.map((row) => ({ value: 'close', ...row })),
      () => {},
    );
  }
  async editPrompt(): Promise<void> {
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
  /** Ctrl+C: stop a running coding turn, else clear the composer, else arm; twice within 2 s leaves. */
  private ctrlC(): void {
    const attempt = interactiveCoding(this.client.snapshot)
      ? runningAttempt(this.client.snapshot)
      : undefined;
    const action = this.modal
      ? 'exit'
      : ctrlCAction({
          running: attempt !== undefined,
          text: this.editor.getExpandedText(),
          armedAt: this.ctrlCArmed,
          now: Date.now(),
        });
    this.ctrlCArmed = undefined;
    if (action === 'exit') this.finish();
    else if (action === 'interrupt')
      void this.execute(async () => {
        await this.client.cancel(attempt!);
        this.client.report('Stopped the turn. Press ctrl+c twice to leave.');
      });
    else if (action === 'clear') {
      this.editor.setText('');
      this.client.report('Cleared. Press ctrl+c again to leave, or ctrl+- to undo.');
    } else {
      this.ctrlCArmed = Date.now();
      this.client.report('Press ctrl+c again to leave. Work continues in the service.');
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
  private openHere(start: CodeStart): Promise<void> {
    return openHere(this, start);
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
          this.client.commands.some((run) => !commandTerminal(run.state)) ||
          // The progress line counts seconds while a turn runs, so it never shows a stale state.
          this.client.snapshot?.attempts.some((a) =>
            ['accepted', 'dispatching', 'running'].includes(a.state),
          )
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
      if (this.statusOn) this.herdr.release();
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
