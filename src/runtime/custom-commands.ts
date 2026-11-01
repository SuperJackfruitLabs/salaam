import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { SLASH_COMMANDS } from '../tui/commands.js';

/** A saved prompt the person types as `/name args` (Phase 4b). It only ever produces a prompt:
 * it never runs a command, grants a tool or changes a mode or rule, so a repository's own commands
 * are safe to load without trusting the repository. */
export interface CustomCommand {
  name: string;
  scope: 'repo' | 'user';
  path: string;
  description: string;
  argumentHint?: string;
  /** Read for display; a command does not switch the session's model. */
  model?: string;
  body: string;
}

const MAX_FILE = 32 * 1024;
const MAX_FILES = 200;
const NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const builtIn = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...c.aliases]));

export function defaultUserCommandsDir(env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'salaam', 'commands');
}

/** Repository commands live in `<repo>/.salaam/commands`, yours in `~/.config/salaam/commands`.
 * A subdirectory becomes a namespace (`frontend/component.md` is `/frontend:component`), and your
 * command wins over a repository's of the same name. Built-in commands always win. */
export function loadCustomCommands(
  repo: string,
  userDir = defaultUserCommandsDir(),
): { commands: CustomCommand[]; problems: string[] } {
  const problems: string[] = [];
  const found = new Map<string, CustomCommand>();
  for (const [scope, dir] of [
    ['repo', join(repo, '.salaam', 'commands')],
    ['user', userDir],
  ] as const) {
    let root: string;
    try {
      root = realpathSync(dir);
    } catch {
      continue;
    }
    // A repository's command folder must itself stay inside the repository.
    if (scope === 'repo' && !inside(realpathSync(repo), root)) {
      problems.push(`${dir}: resolves outside the repository; ignored`);
      continue;
    }
    for (const file of walk(root, root, problems)) {
      const parts = relative(root, file).replace(/\.md$/, '').split(sep);
      if (!parts.every((p) => NAME.test(p))) {
        problems.push(`${file}: a name may use only letters, digits, - and _; ignored`);
        continue;
      }
      const name = parts.join(':').toLowerCase();
      if (builtIn.has(name)) {
        problems.push(`${file}: /${name} is a built-in command; ignored`);
        continue;
      }
      let text: string;
      try {
        const real = realpathSync(file);
        if (!inside(root, real)) {
          problems.push(`${file}: resolves outside its commands folder; ignored`);
          continue;
        }
        if (lstatSync(real).size > MAX_FILE) {
          problems.push(`${file}: larger than 32 KiB; ignored`);
          continue;
        }
        text = readFileSync(real, 'utf8');
      } catch (error) {
        problems.push(`${file}: ${(error as Error).message}`);
        continue;
      }
      const { fields, body } = frontmatter(text);
      for (const key of ['allowed-tools', 'disallowed-tools', 'hooks', 'permission-mode'])
        if (key in fields)
          problems.push(`${file}: ${key} is ignored; a command only writes a prompt`);
      found.set(name, {
        name,
        scope,
        path: file,
        description: fields.description || `Custom ${scope} command`,
        ...(fields['argument-hint'] ? { argumentHint: fields['argument-hint'] } : {}),
        ...(fields.model ? { model: fields.model } : {}),
        body: body.trim(),
      });
    }
  }
  return { commands: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

function inside(root: string, path: string): boolean {
  const r = relative(root, path);
  return !r.startsWith('..') && !r.startsWith(sep);
}

function walk(root: string, dir: string, problems: string[], depth = 0): string[] {
  const out: string[] = [];
  if (depth > 3) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_FILES) break;
    const path = join(dir, e.name);
    if (e.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(path);
      } catch {
        continue;
      }
      // Followed only to a file; whether it stays inside is checked when the file is read.
      if (e.name.endsWith('.md') && lstatSync(real).isFile()) out.push(path);
    } else if (e.isDirectory()) out.push(...walk(root, path, problems, depth + 1));
    else if (e.isFile() && e.name.endsWith('.md')) out.push(path);
  }
  return out.slice(0, MAX_FILES);
}

function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: text.slice(m[0].length) };
}

/** Shell-like splitting: whitespace separates, double or single quotes group. */
export function splitArguments(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(args); m; m = re.exec(args)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** Placeholders as in Claude Code: `$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` (0-based); `\$` is a
 * literal dollar. With no placeholder the arguments are appended, so they are never dropped. */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const list = splitArguments(args);
  let used = false;
  const body = command.body.replace(
    /\\\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)/g,
    (all: string, index?: string, short?: string) => {
      if (all === '\\$') return '$';
      used = true;
      if (all === '$ARGUMENTS') return args.trim();
      return list[Number(index ?? short)] ?? '';
    },
  );
  return !used && args.trim() ? `${body}\n\nARGUMENTS: ${args.trim()}` : body;
}

/** A typed `/name args` line that names a custom command, or null. */
export function matchCustomCommand(
  text: string,
  commands: readonly CustomCommand[],
): { command: CustomCommand; args: string } | null {
  const m = /^\/([a-z0-9][a-z0-9_:-]*)(?:[ \t]+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const command = commands.find((c) => c.name === m[1]!.toLowerCase());
  return command ? { command, args: (m[2] ?? '').trim() } : null;
}
