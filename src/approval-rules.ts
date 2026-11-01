import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { object, ServiceError } from './protocol.js';

/**
 * Approval rules for desk sessions (operator plan 2026-10-31, phase 2a), in the manner of OpenCode:
 * allow, ask or deny by tool, command pattern and path glob. Deny beats ask, ask beats allow, and with
 * no matching rule the answer is ask.
 *
 * Commands are matched on their parsed words, never as text, so an `npm test` rule cannot carry
 * `npm test; rm -rf /`: anything a shell would reinterpret (chaining, pipes, redirection, expansion,
 * globs, assignments, quoting it cannot close) makes the command unreadable, and an unreadable command
 * can only be denied, never allowed.
 *
 * Rules live in Salaam's own state, not in the repository: the agent can write to its workspace, so
 * a rules file there would let it grant itself permissions. Session rules last for one session; repo
 * rules are kept against the repository's real path and apply to every desk session on it; user rules
 * come from a file in the user's config directory, which the default sandbox cannot write.
 */
export type RuleEffect = 'allow' | 'ask' | 'deny';
export type RuleTool = 'command' | 'edit' | 'any';
export type RuleSource = 'session' | 'repo' | 'user';
export interface ApprovalRule {
  effect: RuleEffect;
  tool: RuleTool;
  /** Command words; a word may contain `*`, and a final lone `*` takes any further words. */
  command?: string;
  /** Project-relative globs for edits: `*` within one path segment, `**` across segments. */
  paths?: string[];
}
export interface StoredRule extends ApprovalRule {
  id: string;
  source: RuleSource;
}
export type RuleRequest =
  { tool: 'command'; argv: string[] | null } | { tool: 'edit'; paths: string[] };

const SHELL_SPECIAL = /[;&|<>`$(){}\\\n\r*?[\]~!#]/;
const PRIVATE_PART = /^(\.|credentials$|secrets$)/;

/** The command's words, or null when a shell would read it as more than plain words. */
export function commandArgv(command: string): string[] | null {
  const words: string[] = [];
  let word = '',
    inWord = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      const end = command.indexOf('"', i + 1);
      if (end < 0) return null;
      const inner = command.slice(i + 1, end);
      if (/[$`\\]/.test(inner)) return null;
      word += inner;
      inWord = true;
      i = end;
    } else if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (SHELL_SPECIAL.test(ch)) return null;
    else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  // A leading NAME=value is an environment assignment, not a command word.
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return null;
  return words;
}
function patternWords(pattern: string): string[] {
  const words = pattern.trim().split(/\s+/);
  if (!pattern.trim() || words.some((w) => /[;&|<>`$(){}\\'"!#~?[\]]/.test(w)))
    throw new ServiceError(
      'invalid_rule',
      'A command rule is plain words; a word may use *, and a final * takes any further words',
    );
  return words;
}
const wordRe = (w: string) =>
  new RegExp(
    '^' +
      w
        .split('*')
        .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
function commandMatches(pattern: string, argv: string[]): boolean {
  const words = patternWords(pattern);
  const rest = words[words.length - 1] === '*';
  const fixed = rest ? words.slice(0, -1) : words;
  if (rest ? argv.length < fixed.length : argv.length !== fixed.length) return false;
  return fixed.every((w, i) => wordRe(w).test(argv[i]!));
}
/** A project-relative glob as a regex: `**` spans segments, `*` stays within one. */
function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      re += '(?:/.*)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (glob[i] === '*') re += '[^/]*';
    else re += glob[i]!.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const pathMatches = (globs: string[], path: string) => globs.some((g) => globRe(g).test(path));

export function validateRule(value: unknown): ApprovalRule {
  const input = object(value);
  if (Object.keys(input).some((k) => !['effect', 'tool', 'command', 'paths'].includes(k)))
    throw new ServiceError('invalid_rule', 'A rule has effect, tool, and command or paths only');
  if (!['allow', 'ask', 'deny'].includes(String(input.effect)))
    throw new ServiceError('invalid_rule', 'A rule effect is allow, ask or deny');
  if (!['command', 'edit', 'any'].includes(String(input.tool)))
    throw new ServiceError('invalid_rule', 'A rule tool is command, edit or any');
  const rule: ApprovalRule = { effect: input.effect as RuleEffect, tool: input.tool as RuleTool };
  if (input.command !== undefined) {
    if (typeof input.command !== 'string' || input.command.length > 512 || input.tool === 'edit')
      throw new ServiceError('invalid_rule', 'Only command rules take a command pattern');
    patternWords(input.command);
    rule.command = input.command.trim().split(/\s+/).join(' ');
  }
  if (input.paths !== undefined) {
    const paths = input.paths;
    if (
      input.tool === 'command' ||
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 32 ||
      paths.some(
        (p) =>
          typeof p !== 'string' ||
          p.length > 512 ||
          p.startsWith('/') ||
          /[\x00-\x1f\x7f\\]/.test(p) ||
          p.split('/').some((part) => !part || part === '..' || PRIVATE_PART.test(part)),
      )
    )
      throw new ServiceError(
        'invalid_rule',
        'Edit rules take up to 32 project-relative globs; no absolute paths, traversal or private paths',
      );
    rule.paths = [...(paths as string[])];
  }
  if (rule.tool === 'edit' && !rule.paths)
    throw new ServiceError('invalid_rule', 'An edit rule names the paths it covers');
  return rule;
}

/** The deciding rule for a request: deny beats ask beats allow; no match asks. */
export function evaluateRules(
  rules: StoredRule[],
  request: RuleRequest,
): { effect: RuleEffect; rule?: StoredRule } {
  const matching = rules.filter((r) => {
    if (r.tool !== 'any' && r.tool !== request.tool) return false;
    if (request.tool === 'command') {
      if (r.paths) return false;
      if (!r.command) return r.effect === 'deny' || request.argv !== null;
      return request.argv !== null && commandMatches(r.command, request.argv);
    }
    if (!r.paths) return r.tool === 'any' && !r.command;
    return r.effect === 'allow'
      ? request.paths.length > 0 && request.paths.every((p) => pathMatches(r.paths!, p))
      : request.paths.some((p) => pathMatches(r.paths!, p));
  });
  for (const effect of ['deny', 'ask', 'allow'] as const) {
    const rule = matching.find((r) => r.effect === effect);
    if (rule) return { effect, rule };
  }
  return { effect: 'ask' };
}

export function defaultUserRulesFile(env = process.env): string {
  return (
    env.SALAAM_PERMISSIONS_FILE ||
    join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'salaam', 'permissions.json')
  );
}

export class ApprovalRules {
  constructor(
    readonly store: Store,
    readonly userFile: string = defaultUserRulesFile(),
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS approval_rules(
      id TEXT PRIMARY KEY NOT NULL,
      scope TEXT NOT NULL CHECK(scope IN ('session','repo')),
      session_id TEXT,
      root TEXT NOT NULL,
      rule TEXT NOT NULL,
      created_at INTEGER NOT NULL)`);
  }
  /** Whether rules apply: only desk sessions, never host-managed (AgentPod) or child work. */
  applies(session: string): boolean {
    if (!this.store.localCoding(session)) return false;
    const has = (sql: string) => {
      try {
        return !!this.store.db.prepare(sql).get(session);
      } catch {
        return false;
      }
    };
    return (
      !has('SELECT 1 FROM agentpod_admissions WHERE session_id=?') &&
      !has('SELECT 1 FROM child_tasks WHERE child_session=?')
    );
  }
  private userRules(): { rules: StoredRule[]; problem?: string } {
    let text: string;
    try {
      text = readFileSync(this.userFile, 'utf8');
    } catch {
      return { rules: [] };
    }
    try {
      const doc = object(JSON.parse(text));
      if (doc.version !== 1 || !Array.isArray(doc.rules))
        throw new Error('expected {"version": 1, "rules": [...]}');
      return {
        rules: doc.rules.map((r, i) => ({
          ...validateRule(r),
          id: 'user:' + i,
          source: 'user' as const,
        })),
      };
    } catch (error) {
      return {
        rules: [],
        problem: `${this.userFile} is ignored: ${error instanceof Error ? error.message : 'unreadable'}`,
      };
    }
  }
  list(session: string): StoredRule[] {
    const root = this.store.session(session).cwd;
    const stored = this.store.db
      .prepare(
        "SELECT id,scope,rule FROM approval_rules WHERE (scope='session' AND session_id=?) OR (scope='repo' AND root=?) ORDER BY created_at,rowid",
      )
      .all(session, root) as { id: string; scope: RuleSource; rule: string }[];
    return [
      ...stored.map((r) => ({
        ...(JSON.parse(r.rule) as ApprovalRule),
        id: r.id,
        source: r.scope,
      })),
      ...this.userRules().rules,
    ];
  }
  problems(session: string): string[] {
    void session;
    const problem = this.userRules().problem;
    return problem ? [problem] : [];
  }
  add(session: string, scope: 'session' | 'repo', value: unknown, request: string): StoredRule {
    const rule = validateRule(value);
    if (!this.applies(session))
      throw new ServiceError(
        'rules_unavailable',
        'Approval rules apply only to desk coding sessions',
      );
    return this.store.request(
      'local-operator',
      request,
      { kind: 'approval-rule', session, scope, rule },
      () => {
        const id = randomUUID();
        this.store.db
          .prepare(
            'INSERT INTO approval_rules(id,scope,session_id,root,rule,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            id,
            scope,
            scope === 'session' ? session : null,
            this.store.session(session).cwd,
            JSON.stringify(rule),
            Date.now(),
          );
        this.store.event(session, 'approval_rule.added', { id, scope, rule });
        return { ...rule, id, source: scope };
      },
    );
  }
  remove(session: string, id: string): void {
    const root = this.store.session(session).cwd;
    const done = this.store.db
      .prepare(
        "DELETE FROM approval_rules WHERE id=? AND ((scope='session' AND session_id=?) OR (scope='repo' AND root=?))",
      )
      .run(id, session, root);
    if (!done.changes)
      throw new ServiceError('rule_not_found', 'No such rule for this session or repository');
    this.store.event(session, 'approval_rule.removed', { id });
  }
  /** The rule an approved operation stands for: the exact command words, or the exact edited paths. */
  ruleFor(args: { action: string; command?: string; edits?: { path: string }[] }): ApprovalRule {
    if (args.action === 'command') {
      const argv = commandArgv(args.command ?? '');
      if (!argv)
        throw new ServiceError(
          'invalid_rule',
          'This command uses shell features a rule cannot match safely; approve it once instead',
        );
      const quote = (w: string) =>
        /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) && !w.includes('*') ? w : null;
      if (argv.some((w) => quote(w) === null))
        throw new ServiceError(
          'invalid_rule',
          'This command has words a rule cannot spell exactly; approve it once instead',
        );
      return validateRule({ effect: 'allow', tool: 'command', command: argv.join(' ') });
    }
    if (args.action === 'edit' && args.edits?.length)
      return validateRule({ effect: 'allow', tool: 'edit', paths: args.edits.map((e) => e.path) });
    throw new ServiceError('invalid_rule', 'Only local commands and edits can become rules');
  }
  addFromOperation(
    session: string,
    operation: string,
    scope: 'session' | 'repo',
    request: string,
  ): StoredRule {
    const row = this.store.db
      .prepare('SELECT args,session_id FROM local_calls WHERE operation_id=?')
      .get(operation) as { args: string; session_id: string } | undefined;
    if (!row || row.session_id !== session)
      throw new ServiceError(
        'rule_not_found',
        'That request is not a local command or edit in this session',
      );
    return this.add(session, scope, this.ruleFor(JSON.parse(row.args)), request);
  }
}

/** Why a reviewed request can only be approved once: a command with shell features (pipes,
 * redirects, substitutions) can never become an approval rule. Undefined when a rule is possible. */
export function onceOnlyReason(value: string): string | undefined {
  const command = /\nCommand:\n([\s\S]*)$/.exec(value)?.[1];
  return command !== undefined && commandArgv(command) === null
    ? 'This command uses shell features (pipes, redirects, substitutions), so it cannot become a rule. Approve it once or deny it.'
    : undefined;
}
