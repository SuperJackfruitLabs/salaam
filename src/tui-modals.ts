import {
  Input,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
} from '@earendil-works/pi-tui';
import type { Approval, Operation } from './protocol.js';
import { SalaamTheme, safeText } from './tui-theme.js';

function framed(theme: SalaamTheme, title: string, lines: string[], width: number): string[] {
  const inner = Math.max(1, width - 4);
  const edge = (line: string) =>
    theme.fill(
      theme.ink('│', 'border') +
        ' ' +
        line +
        ' '.repeat(Math.max(0, inner - visibleWidth(line))) +
        ' ' +
        theme.ink('│', 'border'),
      width,
      'panel',
    );
  return [
    theme.fill(theme.ink('╭' + '─'.repeat(Math.max(0, width - 2)) + '╮', 'border'), width, 'panel'),
    edge(theme.ink(title, 'jade', true)),
    edge(''),
    ...lines.map(edge),
    theme.fill(theme.ink('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯', 'border'), width, 'panel'),
  ];
}
export class ChoiceModal implements Component, Focusable {
  focused = false;
  readonly input = new Input({ placeholder: 'Type to filter…', prompt: '⌕ ' });
  list: SelectList;
  private readonly items: SelectItem[];
  constructor(
    readonly title: string,
    items: SelectItem[],
    readonly theme: SalaamTheme,
    readonly renderAgain: () => void,
    readonly close: () => void,
    readonly onSelect: (item: SelectItem) => void,
    readonly rows: () => number,
  ) {
    this.items = items.map((item) => ({
      ...item,
      label: safeText(item.label),
      description: item.description ? safeText(item.description) : undefined,
    }));
    this.list = this.filteredList('');
  }
  private filteredList(filter: string): SelectList {
    const words = filter.toLocaleLowerCase().trim().split(/\s+/);
    const items = this.items.filter((item) =>
      words.every((word) =>
        [item.value, item.label, item.description ?? '']
          .join(' ')
          .toLocaleLowerCase()
          .includes(word),
      ),
    );
    const list = new SelectList(items, Math.max(2, Math.min(10, this.rows() - 12)), {
      selectedPrefix: (s) => this.theme.ink(s, 'jade'),
      selectedText: (s) => this.theme.ink(s, 'jade', true),
      description: (s) => this.theme.ink(s, 'muted'),
      scrollInfo: (s) => this.theme.ink(s, 'muted'),
      noMatch: (s) => this.theme.ink(s, 'muted'),
    });
    list.onSelect = this.onSelect;
    list.onCancel = this.close;
    return list;
  }
  invalidate(): void {
    this.list.invalidate();
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return framed(
      this.theme,
      this.title,
      [
        ...this.input.render(Math.max(1, width - 4)).map((line) => this.theme.ink(line)),
        this.theme.ink('─'.repeat(Math.max(1, width - 4)), 'border'),
        ...this.list.render(Math.max(1, width - 4)),
        '',
        this.theme.key('↑↓', 'choose') +
          '   ' +
          this.theme.key('enter', 'open') +
          '   ' +
          this.theme.key('esc', 'close'),
      ],
      width,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.close();
      return;
    }
    if (
      matchesKey(data, 'up') ||
      matchesKey(data, 'down') ||
      matchesKey(data, 'enter') ||
      matchesKey(data, 'pageUp') ||
      matchesKey(data, 'pageDown')
    )
      this.list.handleInput(data);
    else {
      this.input.handleInput(data);
      this.input.setValue(safeText(this.input.getValue()));
      this.list = this.filteredList(this.input.getValue());
    }
    this.renderAgain();
  }
}
export class FormModal implements Component, Focusable {
  focused = false;
  readonly input: Input;
  coding: boolean;
  constructor(
    readonly title: string,
    initial: string,
    readonly theme: SalaamTheme,
    readonly allowCoding: boolean,
    readonly renderAgain: () => void,
    readonly close: () => void,
    readonly submit: (value: string, coding: boolean) => void,
    readonly labels?: { field: string; submit: string; hint: string },
  ) {
    this.input = new Input({
      placeholder: labels?.field ?? 'Absolute project directory',
      prompt: '› ',
    });
    this.input.setValue(initial);
    if (labels) this.input.handleInput('\x05');
    this.coding = allowCoding;
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    this.input.focused = this.focused;
    return framed(
      this.theme,
      this.title,
      [
        this.theme.ink(this.labels?.field ?? 'Project directory', 'muted'),
        ...this.input.render(Math.max(1, width - 4)).map((line) => this.theme.ink(line)),
        '',
        this.theme.ink(
          this.allowCoding
            ? this.coding
              ? '[✓] Coding workspace · guarded tools'
              : '[ ] Conversation session'
            : (this.labels?.hint ?? 'Conversation session · coding service is off'),
          this.coding ? 'jade' : 'muted',
        ),
        '',
        this.theme.key('enter', this.labels?.submit ?? 'create') +
          '   ' +
          (this.allowCoding ? this.theme.key('tab', 'coding tools') + '   ' : '') +
          this.theme.key('esc', 'back'),
      ],
      width,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.close();
    else if (matchesKey(data, 'tab') && this.allowCoding) this.coding = !this.coding;
    else if (matchesKey(data, 'enter')) this.submit(this.input.getValue(), this.coding);
    else {
      this.input.handleInput(data);
      this.input.setValue(safeText(this.input.getValue()));
    }
    this.renderAgain();
  }
}
export class ConfirmModal implements Component, Focusable {
  focused = false;
  selected = false;
  constructor(
    readonly title: string,
    readonly description: string,
    readonly confirmLabel: string,
    readonly theme: SalaamTheme,
    readonly renderAgain: () => void,
    readonly close: () => void,
    readonly confirm: () => void,
    /** Start on the action rather than on "Keep current state" (cancel a running turn). */
    confirmByDefault = false,
  ) {
    this.selected = confirmByDefault;
  }
  invalidate(): void {}
  render(width: number): string[] {
    return framed(
      this.theme,
      this.title,
      [
        ...wrapTextWithAnsi(this.theme.ink(safeText(this.description)), Math.max(1, width - 4)),
        '',
        this.theme.ink(
          (this.selected ? '  ' : '› ') + 'Keep current state',
          this.selected ? 'muted' : 'jade',
        ) +
          '   ' +
          this.theme.ink(
            (this.selected ? '› ' : '  ') + this.confirmLabel,
            this.selected ? 'amber' : 'muted',
          ),
        '',
        this.theme.key('←→', 'choose') +
          '   ' +
          this.theme.key('enter', 'confirm') +
          '   ' +
          this.theme.key('esc', 'back'),
      ],
      width,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.close();
    else if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab'))
      this.selected = !this.selected;
    else if (matchesKey(data, 'enter')) {
      if (this.selected) this.confirm();
      else this.close();
    }
    this.renderAgain();
  }
}
export type ApprovalDecision = 'approve' | 'approve-session' | 'always' | 'deny';
/**
 * The approval prompt (phase 2a): what will run, in plain words, with the exact binding (approval
 * id, digest, revision, expiry) one key away rather than in the way. Desk sessions can also approve
 * for the rest of the session or always for this repo; strict work only ever approves once. A
 * request longer than the screen must be read to the end before anything but Deny is possible, and
 * a request that changed or expired cannot be approved at all.
 */
export class ApprovalModal implements Component, Focusable {
  focused = false;
  offset = 0;
  reviewed = false;
  showDetails = false;
  choice = 0;
  private total = 0;
  private pageSize = 1;
  private stale = false;
  constructor(
    readonly approval: Approval,
    readonly operation: Operation,
    readonly theme: SalaamTheme,
    readonly rows: () => number,
    readonly current: () => Approval | undefined,
    readonly renderAgain: () => void,
    readonly close: () => void,
    readonly decide: (decision: ApprovalDecision) => void,
    readonly offerRules = false,
  ) {}
  private choices(): {
    decision: ApprovalDecision;
    key: string;
    label: string;
    colour: 'amber' | 'jade';
  }[] {
    return [
      { decision: 'deny', key: 'n', label: 'Deny', colour: 'amber' },
      { decision: 'approve', key: 'y', label: 'Approve once', colour: 'jade' },
      ...(this.offerRules
        ? [
            {
              decision: 'approve-session' as const,
              key: 's',
              label: 'Approve for this session',
              colour: 'jade' as const,
            },
            {
              decision: 'always' as const,
              key: 'a',
              label: 'Always allow in this repo',
              colour: 'jade' as const,
            },
          ]
        : []),
    ];
  }
  invalidate(): void {}
  render(width: number): string[] {
    const a = this.approval,
      op = this.operation,
      t = this.theme,
      inner = Math.max(1, width - 4);
    const body = [
      safeText(op.target),
      '',
      safeText(op.value),
      ...(this.showDetails
        ? [
            '',
            `Approval ${a.id} · revision ${a.revision} · worker epoch ${a.worker_epoch}`,
            `Digest ${a.operation_digest}`,
            `Target version ${safeText(op.target_version)} · expires ${new Date(a.expires_at).toISOString()}`,
          ]
        : []),
    ].flatMap((line) => wrapTextWithAnsi(t.ink(line), inner));
    const current = this.current();
    this.stale =
      !current ||
      current.state !== 'pending' ||
      current.operation_digest !== a.operation_digest ||
      current.revision !== a.revision ||
      Date.now() >= a.expires_at;
    this.total = body.length;
    this.pageSize = Math.max(1, Math.min(18, this.rows() - 11));
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - this.pageSize)));
    if (this.rows() >= 12 && this.offset + this.pageSize >= this.total) this.reviewed = true;
    const disabled = !this.reviewed || this.stale;
    const choices = this.choices();
    this.choice = Math.max(0, Math.min(this.choice, choices.length - 1));
    return framed(
      t,
      'Approve?',
      [
        ...body.slice(this.offset, this.offset + this.pageSize),
        '',
        ...(this.stale
          ? [t.ink('This request changed or expired. Close and refresh.', 'red')]
          : this.reviewed
            ? []
            : [
                t.ink(
                  `Read to the end to approve · ${this.offset + 1}–${Math.min(this.total, this.offset + this.pageSize)} of ${this.total}`,
                  'muted',
                ),
              ]),
        ...choices.map((c, i) =>
          t.ink(
            (i === this.choice ? '› ' : '  ') + `${c.key}  ${c.label}`,
            c.decision !== 'deny' && disabled ? 'muted' : i === this.choice ? c.colour : 'muted',
          ),
        ),
        '',
        t.key('←→', 'choose') +
          '   ' +
          t.key('enter', 'decide') +
          '   ' +
          t.key('d', this.showDetails ? 'hide details' : 'details') +
          '   ' +
          t.key('↑↓', 'scroll') +
          '   ' +
          t.key('esc', 'back'),
      ],
      width,
    );
  }
  private pick(decision: ApprovalDecision): void {
    if (decision !== 'deny' && (this.stale || !this.reviewed)) return;
    this.decide(decision);
  }
  handleInput(data: string): void {
    const current = this.current(),
      a = this.approval;
    this.stale =
      !current ||
      current.state !== 'pending' ||
      current.operation_digest !== a.operation_digest ||
      current.revision !== a.revision ||
      current.worker_epoch !== a.worker_epoch ||
      Date.now() >= a.expires_at;
    const choices = this.choices();
    const byKey = choices.find((c) => c.key === data);
    if (matchesKey(data, 'escape')) this.close();
    else if (byKey) this.pick(byKey.decision);
    else if (data === 'd') this.showDetails = !this.showDetails;
    else if (matchesKey(data, 'down')) this.offset++;
    else if (matchesKey(data, 'up')) this.offset--;
    else if (matchesKey(data, 'pageDown')) this.offset += this.pageSize;
    else if (matchesKey(data, 'pageUp')) this.offset -= this.pageSize;
    else if (matchesKey(data, 'end')) this.offset = this.total;
    else if (matchesKey(data, 'home')) this.offset = 0;
    else if (matchesKey(data, 'right') || matchesKey(data, 'tab'))
      this.choice = (this.choice + 1) % choices.length;
    else if (matchesKey(data, 'left'))
      this.choice = (this.choice + choices.length - 1) % choices.length;
    else if (matchesKey(data, 'enter')) this.pick(choices[this.choice]!.decision);
    this.renderAgain();
  }
}

/** Bounded read-only evidence page; opening it never acknowledges or changes work. */
export class TextModal implements Component, Focusable {
  focused = false;
  offset = 0;
  private total = 0;
  private reviewed = false;
  private page = 1;
  constructor(
    readonly title: string,
    readonly text: string,
    readonly theme: SalaamTheme,
    readonly rows: () => number,
    readonly renderAgain: () => void,
    readonly close: () => void,
    readonly next?: () => void,
    readonly confirmReview?: () => void,
    readonly confirmReviewLabel = 'apply reviewed inverse',
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const lines = wrapTextWithAnsi(this.theme.ink(safeText(this.text)), Math.max(1, width - 4));
    this.total = lines.length;
    this.page = Math.max(1, this.rows() - 9);
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.total - this.page)));
    if (this.offset + this.page >= this.total) this.reviewed = true;
    return framed(
      this.theme,
      this.title,
      [
        ...lines.slice(this.offset, this.offset + this.page),
        '',
        this.theme.ink(
          `Lines ${this.offset + 1}–${Math.min(this.total, this.offset + this.page)} of ${this.total}`,
          'muted',
        ),
        ...(this.confirmReview
          ? [
              this.reviewed
                ? this.theme.key('enter', this.confirmReviewLabel)
                : this.theme.ink('Read to the end before applying.', 'amber'),
            ]
          : []),
        this.theme.key('↑↓', 'scroll') +
          '   ' +
          (this.next ? this.theme.key('n', 'next page') + '   ' : '') +
          this.theme.key('esc', 'back'),
      ],
      width,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.close();
    else if (matchesKey(data, 'down')) this.offset++;
    else if (matchesKey(data, 'up')) this.offset--;
    else if (matchesKey(data, 'pageDown')) this.offset += this.page;
    else if (matchesKey(data, 'pageUp')) this.offset -= this.page;
    else if (matchesKey(data, 'home')) this.offset = 0;
    else if (matchesKey(data, 'end')) this.offset = this.total;
    else if (matchesKey(data, 'enter') && this.reviewed) this.confirmReview?.();
    else if (data === 'n') this.next?.();
    this.renderAgain();
  }
}
