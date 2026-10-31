import { typedText } from './shell-passthrough.js';
import { statSync } from 'node:fs';
import { OFFLINE_ROUTE } from './provider-config.js';

/** How `salaam code` opens a folder: continue its latest session (the default), start a new
 * coding session, or pick one from the list. */
export type CodeStart = 'continue' | 'new' | 'resume';

export function parseCodeStart(flags: string[]): CodeStart {
  const chosen = (['continue', 'new', 'resume'] as const).filter((f) => flags.includes('--' + f));
  if (chosen.length > 1) throw new Error('Choose one of --continue, --new or --resume.');
  return chosen[0] ?? 'continue';
}

const folder = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The most recently created session in this folder; sessions come oldest first. */
export function latestSessionFor(
  sessions: readonly { id: string; cwd: string }[],
  cwd: string,
): string | undefined {
  const want = folder(cwd);
  return [...sessions].reverse().find((s) => folder(s.cwd) === want)?.id;
}

/** Whether a new `salaam code` session should use Anthropic: only when nothing was chosen, the
 * running service defaults to offline (as a TUI-started one does) and a key is stored. */
export function deskUsesAnthropic(
  chosen: boolean,
  serviceProvider: string | undefined,
  hasAnthropicKey: boolean,
): boolean {
  return (
    !chosen &&
    (serviceProvider ?? OFFLINE_ROUTE.provider) === OFFLINE_ROUTE.provider &&
    hasAnthropicKey
  );
}

/** `salaam -c` and `salaam --continue` are short for `salaam code --continue`. */
export function continueArgs(args: readonly string[]): string[] | undefined {
  if (args[0] !== '-c' && args[0] !== '--continue') return;
  return ['code', '--continue', ...args.slice(1)];
}

interface PickerSession {
  id: string;
  cwd: string;
  last_active_at?: string;
}
const activeAt = (s: { last_active_at?: string }) =>
  s.last_active_at ? Date.parse(s.last_active_at) : -Infinity;

/** This folder's sessions first, then every other one; newest first within each. */
export function pickerOrder<T extends PickerSession>(sessions: readonly T[], cwd: string): T[] {
  const want = folder(cwd);
  const newest = (a: T, b: T) => activeAt(b) - activeAt(a);
  const here = sessions.filter((s) => folder(s.cwd) === want).sort(newest);
  return [...here, ...sessions.filter((s) => folder(s.cwd) !== want).sort(newest)];
}

export function relativeTime(at: string | undefined, now = Date.now()): string {
  if (!at) return '';
  const s = Math.max(0, (now - Date.parse(at)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  return `${Math.floor(s / 86400)} days ago`;
}

/** One picker row: what you last asked (one short line), when, and where. */
export function sessionDescription(
  s: { cwd: string; state: string; last_prompt?: string; last_active_at?: string },
  now = Date.now(),
): string {
  const prompt = s.last_prompt?.replace(/\s+/g, ' ').trim();
  const quoted = prompt ? `“${prompt.length > 60 ? prompt.slice(0, 59) + '…' : prompt}”` : '';
  return [quoted || s.state, relativeTime(s.last_active_at, now), s.cwd]
    .filter(Boolean)
    .join(' · ');
}

/** What the picker shows for a desk session: its newest prompt (at most 200 characters) and when
 * its transcript last changed. Board and station sessions get nothing extra. */
export function pickerSummary(
  session: { id: string; capabilities: string[]; pi_session_file: string | null },
  store: { lastPrompt(id: string): string | null },
): { last_prompt?: string; last_active_at?: string } {
  if (!session.capabilities.includes('local-coding-reviewed')) return {};
  const prompt = store.lastPrompt(session.id);
  let at: string | undefined;
  try {
    if (session.pi_session_file) at = statSync(session.pi_session_file).mtime.toISOString();
  } catch {
    /* no transcript yet */
  }
  return {
    ...(prompt ? { last_prompt: typedText(prompt).slice(0, 200) } : {}),
    ...(at ? { last_active_at: at } : {}),
  };
}
