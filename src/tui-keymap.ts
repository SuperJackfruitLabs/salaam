import type { KeyId } from '@earendil-works/pi-tui';

/**
 * The TUI's keys in one table (trial polish C, 2026-10-31). The global bindings in tui.ts and the
 * `?` key sheet both read this, so the sheet cannot drift from what the keys do.
 */
export type GlobalAction =
  | 'palette'
  | 'sessions'
  | 'new'
  | 'approvals'
  | 'changes'
  | 'commands'
  | 'rail'
  | 'transcript'
  | 'refresh'
  | 'editor'
  | 'mode'
  | 'help';

export const GLOBAL_KEYS: readonly { key: KeyId; action: GlobalAction; label: string }[] = [
  { key: 'ctrl+k', action: 'palette', label: 'all actions' },
  { key: 'f2', action: 'palette', label: 'all actions' },
  { key: 'ctrl+p', action: 'sessions', label: 'sessions' },
  { key: 'ctrl+n', action: 'new', label: 'new session' },
  { key: 'ctrl+o', action: 'approvals', label: 'approvals' },
  { key: 'alt+g', action: 'changes', label: 'changes' },
  { key: 'ctrl+t', action: 'commands', label: 'commands' },
  { key: 'ctrl+b', action: 'rail', label: 'show or hide the side panel' },
  { key: 'ctrl+x', action: 'transcript', label: 'full transcript on or off' },
  { key: 'f5', action: 'refresh', label: 'refresh' },
  { key: 'ctrl+g', action: 'editor', label: 'external prompt editor' },
  { key: 'shift+tab', action: 'mode', label: 'next mode' },
  { key: 'f1', action: 'help', label: 'these keys' },
];

/** The per-file review on the Changes tab of a desk session. */
export const REVIEW_KEYS = {
  nextFile: { key: 'alt+right', label: 'next file' },
  previousFile: { key: 'alt+left', label: 'previous file' },
  nextHunk: { key: 'alt+down', label: 'next hunk' },
  previousHunk: { key: 'alt+up', label: 'previous hunk' },
  accept: { key: 'a', label: 'accept the file or hunk' },
  revert: { key: 'r', label: 'revert it (asks first)' },
  instruct: { key: 'i', label: 'tell the model about it' },
} as const;

/** Keys while a desk turn runs (tui-turn-keys.ts decides them). */
export const TURN_KEYS = [
  { key: 'escape', label: 'stop the turn' },
  { key: 'enter', label: 'steer it' },
  { key: 'tab', label: 'queue for after' },
] as const;

const COMPOSER: { label: string; description?: string }[] = [
  { label: 'Enter · send', description: 'The durable outbox saves it before delivery' },
  { label: 'Alt+Enter / Ctrl+J · new line' },
  { label: 'Tab · switch view', description: 'Conversation · Changes · Commands · Context' },
  { label: 'PageUp / PageDown · scroll', description: 'Ctrl+Home/End jump to the top/bottom' },
  { label: '@ · attach a file or image' },
  { label: '/ · slash commands' },
  {
    label: 'Ctrl+R · search sent messages',
    description: 'Ctrl+R for older, Enter keeps, Esc restores',
  },
  {
    label: 'Ctrl+A/E · Ctrl+U/K/W · Ctrl+Y · Ctrl+-',
    description: 'Line start/end, kill to start/end/word, yank, undo; Alt+B/F words',
  },
  {
    label: '!command · run a shell command',
    description: 'Same approval, sandbox and danger check',
  },
  {
    label: 'Ctrl+C · stop, clear, then leave',
    description: 'Stops a running turn, else clears text; twice on empty leaves. Work continues.',
  },
];
const CODING_COMMANDS = [
  { label: '/rewind · go back to an earlier turn' },
  { label: '/jobs · background commands' },
  { label: '/undo · revert the last edit' },
];

export function keyLabel(key: string): string {
  const names: Record<string, string> = { escape: 'Esc', enter: 'Enter', tab: 'Tab' };
  if (names[key]) return names[key];
  if (key.length === 1) return key;
  return key
    .split('+')
    .map((part) =>
      part === 'right'
        ? '→'
        : part === 'left'
          ? '←'
          : part === 'up'
            ? '↑'
            : part === 'down'
              ? '↓'
              : part.length <= 2
                ? part.toUpperCase()
                : part[0]!.toUpperCase() + part.slice(1),
    )
    .join('+');
}

export interface KeyContext {
  tab: string;
  coding: boolean;
  running: boolean;
  /** Your own slash commands (Phase 4b), listed in the conversation sheet. */
  custom?: readonly { name: string; description: string; argumentHint?: string }[];
}

export function keySheet(c: KeyContext): {
  title: string;
  rows: { label: string; description?: string }[];
} {
  const global = GLOBAL_KEYS.map((k) => ({ label: keyLabel(k.key) + ' · ' + k.label }));
  const approvals = { label: 'Approvals show their own keys along the bottom' };
  if (c.tab === 'changes' && c.coding)
    return {
      title: 'Keys · Review changes',
      rows: [
        ...Object.values(REVIEW_KEYS).map((k) => ({ label: keyLabel(k.key) + ' · ' + k.label })),
        { label: 'a, r and i work while the composer is empty' },
        ...global,
      ],
    };
  if (c.coding && c.running)
    return {
      title: 'Keys · Turn running',
      rows: [
        ...TURN_KEYS.map((k) => ({ label: keyLabel(k.key) + ' · ' + k.label })),
        ...global,
        approvals,
      ],
    };
  return {
    title: 'Keys · Conversation',
    rows: [
      ...COMPOSER,
      ...(c.coding ? CODING_COMMANDS : []),
      ...(c.custom ?? []).map((k) => ({
        label: `/${k.name}${k.argumentHint ? ' ' + k.argumentHint : ''} · your command`,
        description: k.description,
      })),
      ...global,
      approvals,
    ],
  };
}
