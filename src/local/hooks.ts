import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { Store } from '../store/index.js';
import { ServiceError } from '../core/index.js';

/** Hooks for a person's own desk sessions (Phase 4b, operator 2026-10-31), in the Claude Code
 * format: `{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
 * "command": "...", "timeout": 30}]}]}}`. Yours live in `~/.config/salaam/hooks.json`; a
 * repository's `.salaam/hooks.json` is ignored until you trust that exact file, and any change to it
 * needs trusting again. A hook can block a tool call or a prompt; it can never approve anything. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'Notification',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export interface HookHandler {
  command: string;
  /** Seconds. */
  timeout?: number;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;
export interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** Set when the hook was not started, e.g. this host refuses unsandboxed commands. */
  refused?: string;
}
/** Runs one hook command under the session's sandbox with `input` on stdin. */
export type HookRunner = (
  session: string,
  command: string,
  input: string,
  timeoutMs: number,
) => Promise<HookRun>;
export interface HookSource {
  scope: 'user' | 'repo';
  path: string;
  digest: string | null;
  trusted: boolean;
  config: HookConfig;
  problems: string[];
}
export interface HookOutcome {
  /** The reason a blocking event was stopped. */
  blocked?: string;
  /** UserPromptSubmit output to add to the prompt. */
  context?: string;
  notices: string[];
}

const MAX_FILE = 64 * 1024;
const MAX_COMMAND = 4096;
const MAX_HANDLERS = 16;
const MAX_CONTEXT = 8192;
const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 600;
const BLOCKING = new Set<HookEvent>(['PreToolUse', 'UserPromptSubmit']);
const TOOL_EVENTS = new Set<HookEvent>(['PreToolUse', 'PostToolUse']);

export function defaultUserHooksFile(env = process.env): string {
  return (
    env.SALAAM_HOOKS_FILE ||
    join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'salaam', 'hooks.json')
  );
}

const sha = (data: string | Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');

export function parseHooks(text: string): { config: HookConfig; problems: string[] } {
  const problems: string[] = [];
  const config: HookConfig = {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { config, problems: ['not valid JSON: ' + (error as Error).message] };
  }
  const events = (raw as { hooks?: unknown })?.hooks;
  if (!events || typeof events !== 'object' || Array.isArray(events))
    return { config, problems: ['expected {"hooks": {...}}'] };
  let handlers = 0;
  for (const [event, groups] of Object.entries(events)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(`${event}: not supported; Salaam runs ${HOOK_EVENTS.join(', ')}`);
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push(`${event}: expected a list of matcher groups`);
      continue;
    }
    for (const group of groups as unknown[]) {
      const g = group as { matcher?: unknown; hooks?: unknown };
      if (g?.matcher !== undefined && typeof g.matcher !== 'string') {
        problems.push(`${event}: matcher must be a string`);
        continue;
      }
      if (typeof g.matcher === 'string' && !validMatcher(g.matcher)) {
        problems.push(`${event}: matcher ${JSON.stringify(g.matcher)} is not a valid pattern`);
        continue;
      }
      if (!Array.isArray(g.hooks)) {
        problems.push(`${event}: a group needs a hooks list`);
        continue;
      }
      const kept: HookHandler[] = [];
      for (const h of g.hooks as unknown[]) {
        const hook = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if (hook?.type !== 'command') {
          problems.push(
            `${event}: hook type ${JSON.stringify(hook?.type)} is not supported (command only)`,
          );
          continue;
        }
        if (typeof hook.command !== 'string' || !hook.command.trim()) {
          problems.push(`${event}: a command hook needs a command`);
          continue;
        }
        if (Buffer.byteLength(hook.command) > MAX_COMMAND) {
          problems.push(`${event}: a hook command is longer than 4 KiB`);
          continue;
        }
        if (
          hook.timeout !== undefined &&
          (typeof hook.timeout !== 'number' || !(hook.timeout > 0) || hook.timeout > MAX_TIMEOUT)
        ) {
          problems.push(`${event}: timeout must be 1–${MAX_TIMEOUT} seconds`);
          continue;
        }
        if (++handlers > MAX_HANDLERS * HOOK_EVENTS.length) {
          problems.push('too many hooks; the rest are ignored');
          break;
        }
        kept.push({
          command: hook.command,
          ...(hook.timeout !== undefined ? { timeout: hook.timeout as number } : {}),
        });
      }
      if (kept.length)
        (config[event as HookEvent] ??= []).push({
          ...(g.matcher !== undefined ? { matcher: g.matcher } : {}),
          hooks: kept.slice(0, MAX_HANDLERS),
        });
    }
  }
  return { config, problems };
}

function validMatcher(m: string): boolean {
  if (m === '' || m === '*' || /^[A-Za-z0-9_|,-]+$/.test(m)) return true;
  try {
    new RegExp(m);
    return true;
  } catch {
    return false;
  }
}

/** Claude Code's rule: empty or `*` matches everything, plain names (letters, digits, `_`, `-`,
 * separated by `|` or `,`) are exact, anything else is a regular expression. `names` holds the
 * Salaam tool name and its Claude Code alias (`Bash`, `Edit`, …). */
export function matchesTool(matcher: string | undefined, names: readonly string[]): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|,-]+$/.test(matcher)) {
    const wanted = matcher.split(/[|,]/);
    return names.some((n) => wanted.includes(n));
  }
  const re = new RegExp('^(?:' + matcher + ')$');
  return names.some((n) => re.test(n));
}

export class Hooks {
  constructor(
    readonly store: Store,
    readonly run: HookRunner,
    readonly userFile = defaultUserHooksFile(),
  ) {
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS hook_trust(root TEXT NOT NULL,path TEXT NOT NULL,digest TEXT NOT NULL,trusted_at TEXT NOT NULL,PRIMARY KEY(root,path))',
    );
  }
  private repoFile(session: string): string {
    return join(this.store.session(session).cwd, '.salaam', 'hooks.json');
  }
  /** Your hooks and this workspace's, read afresh, each with its trust state. */
  sources(session: string): HookSource[] {
    const root = this.store.session(session).cwd;
    const out: HookSource[] = [];
    for (const [scope, path] of [
      ['user', this.userFile],
      ['repo', this.repoFile(session)],
    ] as const) {
      if (!existsSync(path) && !isLink(path)) continue;
      const problems: string[] = [];
      let digest: string | null = null;
      let config: HookConfig = {};
      try {
        const real = realpathSync(path);
        if (scope === 'repo' && !inside(realpathSync(root), real))
          throw new Error('resolves outside the repository; ignored');
        if (lstatSync(real).size > MAX_FILE) throw new Error('larger than 64 KiB; ignored');
        const bytes = readFileSync(real);
        digest = sha(bytes);
        const parsed = parseHooks(bytes.toString('utf8'));
        config = parsed.config;
        problems.push(...parsed.problems);
      } catch (error) {
        problems.push((error as Error).message);
        digest = null;
      }
      const trusted =
        scope === 'user'
          ? digest !== null
          : digest !== null && this.trustedDigest(root, path) === digest;
      out.push({ scope, path, digest, trusted, config, problems });
    }
    return out;
  }
  private trustedDigest(root: string, path: string): string | undefined {
    const row = this.store.db
      .prepare('SELECT digest FROM hook_trust WHERE root=? AND path=?')
      .get(root, path) as { digest?: string } | undefined;
    return row?.digest;
  }
  /** Trust this workspace's hooks file as reviewed: `digest` must be the content shown to you. */
  trust(session: string, digest: string): HookSource {
    const source = this.sources(session).find((s) => s.scope === 'repo');
    if (!source || !source.digest)
      throw new ServiceError(
        'hooks_missing',
        'This workspace has no readable .salaam/hooks.json',
        404,
      );
    if (source.digest !== digest)
      throw new ServiceError(
        'hooks_changed',
        'The hooks file changed since you reviewed it; review it again',
        409,
      );
    const root = this.store.session(session).cwd;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO hook_trust VALUES (?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET digest=excluded.digest,trusted_at=excluded.trusted_at',
        )
        .run(root, source.path, digest, new Date().toISOString());
      this.store.event(session, 'hooks.trusted', { path: source.path, digest });
    });
    return { ...source, trusted: true };
  }
  revoke(session: string): void {
    const root = this.store.session(session).cwd;
    const path = this.repoFile(session);
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM hook_trust WHERE root=? AND path=?').run(root, path);
      this.store.event(session, 'hooks.revoked', { path });
    });
  }
  /** Run every trusted hook for `event`. Blocking events stop at the first block. */
  async fire(
    session: string,
    event: HookEvent,
    payload: Record<string, unknown>,
    names: readonly string[],
  ): Promise<HookOutcome> {
    const notices: string[] = [];
    const context: string[] = [];
    const cwd = this.store.session(session).cwd;
    const input = JSON.stringify({ session_id: session, cwd, hook_event_name: event, ...payload });
    for (const source of this.sources(session)) {
      if (!source.trusted) continue;
      for (const group of source.config[event] ?? []) {
        if (TOOL_EVENTS.has(event) && !matchesTool(group.matcher, names)) continue;
        for (const handler of group.hooks) {
          const started = Date.now();
          const r = await this.run(
            session,
            handler.command,
            input,
            (handler.timeout ?? DEFAULT_TIMEOUT) * 1000,
          );
          const decision = parseDecision(r.stdout);
          let blocked: string | undefined;
          if (BLOCKING.has(event) && !r.refused && !r.timedOut) {
            if (r.code === 2) blocked = r.stderr.trim() || `Blocked by a ${event} hook`;
            else if (r.code === 0 && decision.block)
              blocked = decision.reason || `Blocked by a ${event} hook`;
          }
          if (r.refused) notices.push(`${event} hook refused: ${r.refused}`);
          else if (r.timedOut) notices.push(`${event} hook timed out: ${short(handler.command)}`);
          else if (r.code !== 0 && r.code !== 2)
            notices.push(`${event} hook failed (exit ${r.code}): ${short(handler.command)}`);
          if (event === 'UserPromptSubmit' && r.code === 0 && !blocked) {
            const extra = decision.context ?? (decision.json ? '' : r.stdout.trim());
            if (extra) context.push(extra);
          }
          this.store.transaction(() =>
            this.store.event(session, 'hook.run', {
              event,
              scope: source.scope,
              path: source.path,
              file_digest: source.digest,
              command_digest: sha(handler.command),
              exit_code: r.code,
              timed_out: r.timedOut,
              refused: !!r.refused,
              blocked: !!blocked,
              ...(decision.ignored ? { ignored_decision: decision.ignored } : {}),
              duration_ms: Date.now() - started,
              stdout_digest: sha(r.stdout),
              stderr_digest: sha(r.stderr),
              output_bytes: Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr),
              truncated: r.truncated,
            }),
          );
          if (blocked) return { blocked, notices };
        }
      }
    }
    const joined = context.join('\n\n');
    return {
      notices,
      ...(joined ? { context: truncate(joined, MAX_CONTEXT) } : {}),
    };
  }
}

/** A JSON object on stdout, read the Claude Code way. "allow" and "ask" are recorded as ignored:
 * Salaam's own approval flow decides those. */
function parseDecision(stdout: string): {
  json: boolean;
  block?: boolean;
  reason?: string;
  context?: string;
  ignored?: string;
} {
  const text = stdout.trim();
  if (!text.startsWith('{')) return { json: false };
  let value: Record<string, any>;
  try {
    value = JSON.parse(text);
  } catch {
    return { json: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { json: false };
  const specific = (value.hookSpecificOutput ?? {}) as Record<string, unknown>;
  const decision = specific.permissionDecision;
  const reason =
    typeof specific.permissionDecisionReason === 'string'
      ? specific.permissionDecisionReason
      : typeof value.reason === 'string'
        ? value.reason
        : undefined;
  const context =
    typeof specific.additionalContext === 'string' ? specific.additionalContext : undefined;
  if (decision === 'deny' || value.decision === 'block')
    return { json: true, block: true, ...(reason ? { reason } : {}) };
  return {
    json: true,
    ...(context ? { context } : {}),
    ...(typeof decision === 'string' ? { ignored: decision } : {}),
    ...(value.decision === 'approve' ? { ignored: 'approve' } : {}),
  };
}

function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return !r.startsWith('..') && !r.startsWith(sep);
}
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
function short(command: string): string {
  const line = command.split('\n')[0]!;
  return line.length > 60 ? line.slice(0, 57) + '…' : line;
}
function truncate(text: string, max: number): string {
  const buf = Buffer.from(text);
  return buf.length <= max
    ? text
    : buf.subarray(0, max).toString('utf8') + '\n[hook output truncated]';
}

/** What `/hooks` shows, and what you review before trusting a workspace file: every command. */
export function describeHooks(sources: readonly HookSource[]): string {
  if (!sources.length)
    return "No hooks. Add your own in ~/.config/salaam/hooks.json, or a workspace's in .salaam/hooks.json (it runs only once you trust it with /hooks trust).";
  return sources
    .map((s) => {
      const state =
        s.scope === 'user'
          ? 'yours, runs'
          : s.trusted
            ? 'workspace, trusted (this exact content)'
            : s.digest
              ? 'workspace, NOT trusted, does not run (/hooks trust to review)'
              : 'workspace, unreadable';
      const lines = [`${s.path}  [${state}]`];
      for (const event of HOOK_EVENTS)
        for (const g of s.config[event] ?? [])
          for (const h of g.hooks)
            lines.push(
              `  ${event}${g.matcher ? ` (${g.matcher})` : ''}: ${h.command}${h.timeout ? `  [${h.timeout}s]` : ''}`,
            );
      for (const p of s.problems) lines.push(`  ! ${p}`);
      if (s.digest) lines.push(`  ${s.digest}`);
      return lines.join('\n');
    })
    .join('\n\n');
}
