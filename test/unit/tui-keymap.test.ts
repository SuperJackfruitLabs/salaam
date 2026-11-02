import { test, expect } from 'vitest';
import { matchesKey } from '@earendil-works/pi-tui';
import { SalaamApp } from '../../src/tui/app.js';
import type { ChoiceModal } from '../../src/tui/modals.js';
import type { SessionSnapshot } from '../../src/core/protocol.js';
import { GLOBAL_KEYS, REVIEW_KEYS, keyLabel, keySheet } from '../../src/tui/keymap.js';

// Trial polish C (2026-10-31): `?` on an empty composer shows the keys for where you are, built
// from the same table the TUI binds, so the sheet cannot drift from the keys.
const KEY_BYTES: Record<string, string> = {
  'ctrl+k': '\x0b',
  'ctrl+p': '\x10',
  'ctrl+n': '\x0e',
  'ctrl+o': '\x0f',
  'ctrl+g': '\x07',
  'ctrl+t': '\x14',
  'ctrl+b': '\x02',
  'ctrl+r': '\x12',
  'ctrl+e': '\x05',
  'ctrl+x': '\x18',
  'shift+tab': '\x1b[Z',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f5: '\x1b[15~',
  'alt+g': '\x1bg',
};

function app(snapshot?: Partial<SessionSnapshot>) {
  const a = new SalaamApp({ state: '/tmp/salaam-keymap' });
  if (snapshot)
    a.client.snapshot = {
      id: 's1',
      capabilities: [],
      submissions: [],
      attempts: [],
      operations: [],
      messages: [],
      ...snapshot,
    } as unknown as SessionSnapshot;
  const shown: unknown[] = [];
  const internal = a as unknown as {
    showModal: (c: unknown) => void;
    input(data: string): unknown;
    globalActions(): Record<string, () => void>;
  };
  internal.showModal = (c) => void shown.push(c);
  return { a, internal, shown };
}
const rows = (m: ChoiceModal) =>
  (m as unknown as { items: { label: string; description?: string }[] }).items;

test('every bound global key is in the table, and its bytes reach that action', () => {
  const { internal } = app();
  const actions = internal.globalActions();
  expect(Object.keys(actions).sort()).toEqual(
    [...new Set(GLOBAL_KEYS.map((k) => k.action))].sort(),
  );
  for (const k of GLOBAL_KEYS) expect(matchesKey(KEY_BYTES[k.key]!, k.key)).toBe(true);
  let ran = '';
  for (const k of GLOBAL_KEYS) actions[k.action] = () => (ran = k.action);
  for (const k of GLOBAL_KEYS) {
    internal.input(KEY_BYTES[k.key]!);
    expect(ran).toBe(k.action);
  }
});

test('? on an empty composer opens the conversation key sheet, listing every global key', () => {
  const { a, internal, shown } = app();
  expect(internal.input('?')).toEqual({ consume: true });
  const modal = shown.at(-1) as ChoiceModal;
  expect(modal.title).toBe('Keys · Conversation');
  const text = rows(modal).map((r) => r.label + ' ' + (r.description ?? ''));
  for (const k of GLOBAL_KEYS) expect(text.join('\n')).toContain(keyLabel(k.key) + ' · ' + k.label);
  a.editor.setText('why');
  shown.length = 0;
  expect(internal.input('?')).toBeUndefined();
  expect(shown).toHaveLength(0);
});

test('the sheet follows the context: a running turn, the review, and the coding commands', () => {
  const running = keySheet({ tab: 'conversation', coding: true, running: true });
  expect(running.title).toBe('Keys · Turn running');
  expect(running.rows.map((r) => r.label)).toEqual(
    expect.arrayContaining(['Esc · stop the turn', 'Enter · steer it', 'Tab · queue for after']),
  );
  const review = keySheet({ tab: 'changes', coding: true, running: false });
  expect(review.title).toBe('Keys · Review changes');
  for (const k of Object.values(REVIEW_KEYS))
    expect(review.rows.map((r) => r.label)).toContain(keyLabel(k.key) + ' · ' + k.label);
  const desk = keySheet({ tab: 'conversation', coding: true, running: false });
  const all = desk.rows.map((r) => r.label).join('\n');
  expect(all).toContain('/rewind');
  expect(all).toContain('/jobs');
  expect(
    keySheet({ tab: 'conversation', coding: false, running: false })
      .rows.map((r) => r.label)
      .join('\n'),
  ).not.toContain('/rewind');
});

// Phase 4b + polish C: your own slash commands appear in the conversation key sheet.
test('the conversation sheet lists custom commands', () => {
  const sheet = keySheet({
    tab: 'conversation',
    coding: true,
    running: false,
    custom: [{ name: 'review-pr', description: 'Review the open PR', argumentHint: '<number>' }],
  });
  expect(sheet.rows).toContainEqual({
    label: '/review-pr <number> · your command',
    description: 'Review the open PR',
  });
});
