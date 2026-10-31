import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Composer behaviour for the trial-polish batch (operator approval 2026-10-31): Ctrl+C in steps,
 * reverse history search, persisted history that never keeps secret-looking lines, and `!command`.
 */

/** What Ctrl+C does now: stop a running turn, else clear typed text, else arm, else leave. */
export type CtrlCAction = 'interrupt' | 'clear' | 'arm' | 'exit';
export const CTRL_C_WINDOW_MS = 2000;

export function ctrlCAction(input: {
  running: boolean;
  text: string;
  armedAt: number | undefined;
  now: number;
}): CtrlCAction {
  if (input.running) return 'interrupt';
  if (input.text !== '') return 'clear';
  if (input.armedAt !== undefined && input.now - input.armedAt <= CTRL_C_WINDOW_MS) return 'exit';
  return 'arm';
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*\S{6,}/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /[A-Za-z0-9+_-]{48,}={0,2}/,
];

/** True when the text looks like it carries a credential; such text is never written to history. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}

export const HISTORY_LIMIT = 500;
export const HISTORY_ENTRY_LIMIT = 8192;

/** Where this user's composer history lives: $XDG_STATE_HOME/salaam/history.json, or nowhere when
 * SALAAM_HISTORY=off (history then lasts only for this terminal). */
export function historyPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SALAAM_HISTORY === 'off') return undefined;
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(base, 'salaam', 'history.json');
}

/** Per-user composer history, newest last, bounded, and without secret-looking entries. */
export class ComposerHistory {
  entries: string[] = [];
  constructor(private readonly path: string | undefined) {
    try {
      if (path && existsSync(path)) {
        const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(raw))
          this.entries = raw
            .filter((e): e is string => typeof e === 'string')
            .filter((e) => keepable(e))
            .slice(-HISTORY_LIMIT);
      }
    } catch {
      this.entries = [];
    }
  }
  /** Adds a sent message. Returns false when it was not kept (blank, too long, or secret-looking). */
  add(text: string): boolean {
    if (!keepable(text)) return false;
    this.entries = this.entries.filter((e) => e !== text);
    this.entries.push(text);
    if (this.entries.length > HISTORY_LIMIT) this.entries = this.entries.slice(-HISTORY_LIMIT);
    this.save();
    return true;
  }
  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.entries), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch {
      // History is a convenience; failing to save never blocks sending.
    }
  }
}

function keepable(text: string): boolean {
  return text.trim() !== '' && text.length <= HISTORY_ENTRY_LIMIT && !looksSecret(text);
}

/**
 * Reverse-incremental search: the newest entry older than `before` (an index into `entries`,
 * newest last) that contains the query, case-insensitively. Returns its index or -1.
 */
export function searchHistory(entries: string[], query: string, before: number): number {
  const q = query.toLowerCase();
  for (let i = Math.min(before, entries.length) - 1; i >= 0; i--)
    if (entries[i]!.toLowerCase().includes(q)) return i;
  return -1;
}

/** The status-line text while searching, matching readline's wording. */
export function searchPrompt(query: string, match: string | undefined): string {
  const shown = match === undefined ? '' : match.replace(/\s+/g, ' ').slice(0, 120);
  return match === undefined && query !== ''
    ? `(failing reverse-i-search)\`${query}': · esc cancels`
    : `(reverse-i-search)\`${query}': ${shown} · enter keeps · ctrl+r older · esc cancels`;
}

/**
 * `!command` from the composer. The TUI never runs it itself: it becomes an instruction for the
 * model to run exactly this command through salaam_local, so it takes the same approval path,
 * session mode, sandbox and danger check as any model command. Returns undefined for other text.
 */
export function shellPassthrough(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('!') || t.startsWith('!!')) return undefined;
  const command = t.slice(1).trim();
  if (command === '' || command.includes('\n')) return undefined;
  return [
    'I want to run this shell command myself. Run exactly this command with salaam_local',
    '(action "command"), unchanged: no edits, no extra flags, no other commands. Then show me its',
    'output and exit status, and do nothing else unless I ask.',
    '',
    '```sh',
    command,
    '```',
  ].join('\n');
}
