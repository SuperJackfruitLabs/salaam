import { expect, test } from 'vitest';
import { cancelChoices, turnKeyAction, queuedItems } from '../../src/tui-turn-keys.js';
import { ConfirmModal } from '../../src/tui-modals.js';

// Phase 2c (operator plan 2026-10-31). The tmux pass found Esc did nothing, typing during a turn only
// queued, and /cancel opened on the queued item with "Keep current state" as the default.
const coding = ['local-workspace-read', 'local-coding-reviewed'];
const snap = (states: string[], capabilities = coding) => ({
  capabilities,
  attempts: states.map((state, i) => ({ id: 'a' + i, submission_id: 's' + i, state })),
  submissions: states.map((state, i) => ({ id: 's' + i, text: 'text ' + i, state })),
});
const base = { modal: false, autocomplete: false };

test('Esc interrupts the running turn of an interactive coding session, and nothing else', () => {
  expect(turnKeyAction({ ...base, key: 'escape', text: '', snapshot: snap(['running']) })).toBe(
    'interrupt',
  );
  // Idle: Esc does nothing harmful.
  expect(turnKeyAction({ ...base, key: 'escape', text: '', snapshot: snap(['completed']) })).toBe(
    null,
  );
  // A modal or autocomplete owns Esc.
  expect(
    turnKeyAction({ ...base, modal: true, key: 'escape', text: '', snapshot: snap(['running']) }),
  ).toBe(null);
  expect(
    turnKeyAction({
      ...base,
      autocomplete: true,
      key: 'escape',
      text: '',
      snapshot: snap(['running']),
    }),
  ).toBe(null);
  // Not an interactive coding session (e.g. strict board work attached): unchanged.
  expect(turnKeyAction({ ...base, key: 'escape', text: '', snapshot: snap(['running'], []) })).toBe(
    null,
  );
});

test('Enter during a turn steers it; Tab queues; idle Enter submits as before', () => {
  const running = snap(['running']);
  expect(
    turnKeyAction({ ...base, key: 'enter', text: 'use the other file', snapshot: running }),
  ).toBe('steer');
  expect(turnKeyAction({ ...base, key: 'tab', text: 'then add a test', snapshot: running })).toBe(
    'queue',
  );
  // Slash commands still run as commands while a turn runs.
  expect(turnKeyAction({ ...base, key: 'enter', text: '/cancel', snapshot: running })).toBe(
    'submit',
  );
  // Empty text never steers or queues.
  expect(turnKeyAction({ ...base, key: 'enter', text: '  ', snapshot: running })).toBe('submit');
  expect(turnKeyAction({ ...base, key: 'tab', text: '', snapshot: running })).toBe(null);
  // Idle: Enter submits, Tab is left to the editor.
  const idle = snap(['completed']);
  expect(turnKeyAction({ ...base, key: 'enter', text: 'hello', snapshot: idle })).toBe('submit');
  expect(turnKeyAction({ ...base, key: 'tab', text: 'hello', snapshot: idle })).toBe(null);
  // Only a running turn is steered; a turn still dispatching queues instead.
  expect(turnKeyAction({ ...base, key: 'enter', text: 'x', snapshot: snap(['dispatching']) })).toBe(
    'submit',
  );
  // Strict sessions keep plain submit.
  expect(turnKeyAction({ ...base, key: 'enter', text: 'x', snapshot: snap(['running'], []) })).toBe(
    'submit',
  );
});

test('/cancel lists the running turn first, then queued work', () => {
  const choices = cancelChoices(snap(['accepted', 'running', 'completed', 'accepted']));
  expect(choices.map((c) => c.id)).toEqual(['a1', 'a0', 'a3']);
  expect(choices[0]!.label).toMatch(/running/);
  expect(choices[1]!.label).toMatch(/queued/);
});

test('queued items are listed with their text so they can be edited or removed', () => {
  expect(queuedItems(snap(['running', 'accepted', 'accepted']))).toEqual([
    { attempt: 'a1', submission: 's1', text: 'text 1' },
    { attempt: 'a2', submission: 's2', text: 'text 2' },
  ]);
});

test('a confirm can default to its action, so /cancel + Enter cancels', () => {
  let confirmed = 0,
    closed = 0;
  const theme = { ink: (s: string) => s, key: (k: string, l: string) => k + ' ' + l } as never;
  const modal = new ConfirmModal(
    'Cancel',
    'Cancel the running turn?',
    'Cancel work',
    theme,
    () => {},
    () => closed++,
    () => confirmed++,
    true,
  );
  modal.handleInput('\r');
  expect(confirmed).toBe(1);
  expect(closed).toBe(0);
  // The default stays "Keep current state" for every other confirm.
  const keep = new ConfirmModal(
    't',
    'd',
    'Go',
    theme,
    () => {},
    () => closed++,
    () => confirmed++,
  );
  keep.handleInput('\r');
  expect(confirmed).toBe(1);
  expect(closed).toBe(1);
});
