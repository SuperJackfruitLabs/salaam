import { matchesKey } from '@earendil-works/pi-tui';

/**
 * Stopping and steering a running turn in an interactive coding session (operator plan
 * 2026-10-31, Phase 2c). Esc interrupts the running turn, Enter steers it with what you typed, and
 * Tab queues the text for after the turn. Other sessions, such as strict board work, keep plain
 * submit and an explicit /cancel.
 */
export type TurnKeyAction = 'interrupt' | 'steer' | 'queue' | 'submit' | null;

interface TurnSnapshot {
  capabilities: string[];
  attempts: { id: string; submission_id: string; state: string }[];
  submissions: { id: string; text: string; state: string }[];
}

/** Interactive local coding: the desk-side mode, not admitted or strict work. */
export function interactiveCoding(snapshot: TurnSnapshot | undefined): boolean {
  return !!snapshot?.capabilities.includes('local-coding-reviewed');
}

/** The turn the model is working on now, if any. */
export function runningAttempt(snapshot: TurnSnapshot | undefined): string | undefined {
  return snapshot?.attempts.find((a) => a.state === 'running')?.id;
}

export function turnKeyAction(input: {
  key: 'escape' | 'enter' | 'tab';
  text: string;
  snapshot: TurnSnapshot | undefined;
  modal: boolean;
  autocomplete: boolean;
}): TurnKeyAction {
  const { key, text, snapshot } = input;
  if (input.modal || input.autocomplete) return key === 'enter' ? 'submit' : null;
  const live = interactiveCoding(snapshot) && runningAttempt(snapshot) !== undefined;
  const words = text.trim() !== '' && !text.trimStart().startsWith('/');
  if (key === 'escape') return live ? 'interrupt' : null;
  if (key === 'tab') return live && words ? 'queue' : null;
  return live && words ? 'steer' : 'submit';
}

/** The key the TUI saw, as one of the three this module decides, or undefined for any other. */
export function turnKey(data: string): 'escape' | 'enter' | 'tab' | undefined {
  return matchesKey(data, 'escape')
    ? 'escape'
    : matchesKey(data, 'enter')
      ? 'enter'
      : matchesKey(data, 'tab')
        ? 'tab'
        : undefined;
}

/** What /cancel offers, the running turn first, then work queued behind it. */
export function cancelChoices(snapshot: TurnSnapshot): { id: string; label: string }[] {
  const order = ['running', 'dispatching', 'accepted'];
  return snapshot.attempts
    .filter((a) => order.includes(a.state))
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
    .map((a) => ({
      id: a.id,
      label: (a.state === 'accepted' ? 'queued' : a.state) + ' · ' + a.id.slice(0, 8),
    }));
}

/** Instructions waiting behind the running turn, with their text, so they can be edited or removed. */
export function queuedItems(
  snapshot: TurnSnapshot,
): { attempt: string; submission: string; text: string }[] {
  return snapshot.attempts
    .filter((a) => a.state === 'accepted')
    .map((a) => ({
      attempt: a.id,
      submission: a.submission_id,
      text: snapshot.submissions.find((s) => s.id === a.submission_id)?.text ?? '',
    }));
}
