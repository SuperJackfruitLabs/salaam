import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliHelp } from './help.js';
import { MCP_HELP } from './mcp-commands.js';
import { SLASH_COMMANDS } from '../tui/commands.js';
import { keySheet } from '../tui/keymap.js';

/**
 * The docs' reference tables, rendered from the registries the program itself uses, and a lint
 * for the names the docs mention. `npm run docs:generate` writes the tables; the docs-reference
 * unit test fails when a table is stale or a page names a command, flag, variable or config
 * file the code does not have.
 */

const cell = (s: string) => s.replaceAll('|', '\\|');
const table = (head: string[], rows: string[][]) =>
  [
    '| ' + head.join(' | ') + ' |',
    '| ' + head.map(() => '---').join(' | ') + ' |',
    ...rows.map((r) => '| ' + r.map(cell).join(' | ') + ' |'),
  ].join('\n');

function slashCommands(): string {
  return table(
    ['Command', 'Also', 'What it does'],
    SLASH_COMMANDS.map((c) => [
      '`/' + c.name + (c.arguments ? ' ' + c.arguments : '') + '`',
      c.aliases.map((a) => '`/' + a + '`').join(', '),
      c.description,
    ]),
  );
}

function keys(): string {
  const sheet = (title: string, rows: { label: string; description?: string }[]) =>
    `**${title}**\n\n` +
    table(
      ['Key', 'Action'],
      rows
        .filter((r) => r.label.includes(' · '))
        .map((r) => {
          const [key, ...rest] = r.label.split(' · ');
          const action = rest.join(' · ');
          return ['`' + key + '`', r.description ? `${action}: ${r.description}` : action];
        }),
    );
  return [
    sheet(
      'In the conversation',
      keySheet({ tab: 'conversation', coding: true, running: false }).rows,
    ),
    sheet('While a turn runs', keySheet({ tab: 'conversation', coding: true, running: true }).rows),
    sheet('Reviewing changes', keySheet({ tab: 'changes', coding: true, running: false }).rows),
  ].join('\n\n');
}

/** The top-level command list, as `salaam --help` prints it. */
export function cliCommands(): { name: string; description: string }[] {
  const text = cliHelp()!;
  const block = text.slice(text.indexOf('Commands:\n') + 10, text.indexOf('\n\nGlobal options:'));
  return block.split('\n').map((line) => {
    const m = /^\s+(\S+)\s+(.+)$/.exec(line)!;
    return { name: m[1]!, description: m[2]! };
  });
}

export const GENERATED: Record<string, () => string> = {
  'slash-commands': slashCommands,
  keys,
  'cli-commands': () =>
    table(
      ['Command', 'What it does'],
      cliCommands().map((c) => ['`' + c.name + '`', c.description]),
    ),
};

const BLOCK = /<!-- generated:([\w-]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/g;

/** The page with every generated block rewritten from the code. */
export function regenerate(markdown: string): string {
  return markdown.replace(BLOCK, (_all, name: string) => {
    const render = GENERATED[name];
    if (!render) throw Error('Unknown generated block: ' + name);
    return `<!-- generated:${name} -->\n${render()}\n<!-- /generated:${name} -->`;
  });
}

/** `/word` spans that are not commands: placeholders, examples and URL or file paths. */
const NOT_SLASH_COMMANDS = new Set(['name', 'frontend:component', 'a2a', 'tmp']);
/** Files under ~/.config/salaam that pages use as examples of where you may keep your own. */
const EXAMPLE_FILES = new Set(['harness.json', 'kimi.env']);

export function lintDocs(
  pages: { file: string; text: string }[],
  sourceText: string,
): { file: string; problem: string }[] {
  const problems: { file: string; problem: string }[] = [];
  const slash = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...c.aliases]));
  const groups = new Set([...cliCommands().map((c) => c.name), 'here', 'help']);
  const global = cliHelp('code')!.split('Global options:')[1]!;
  for (const { file, text } of pages) {
    const add = (problem: string) => problems.push({ file, problem });
    // Inline code that starts with a slash command: `/rewind`, `/rewind N`.
    for (const m of text.matchAll(/`\/([a-z][a-z0-9:-]*)(?=[\s`])/g))
      if (!slash.has(m[1]!) && !NOT_SLASH_COMMANDS.has(m[1]!))
        add(`/${m[1]} is not a slash command`);
    // CLI invocations in code: `salaam GROUP … --flag`.
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(/(?:^|[\s`(])(?:salaam|sal) ([a-z][a-z0-9-]*)([^`|#]*)/g)) {
        const group = m[1]!;
        if (!groups.has(group)) {
          if (/^\s*(?:\$ )?(?:salaam|sal) /.test(line) || line.includes('`'))
            add(`salaam ${group} is not a command`);
          continue;
        }
        const help = (group === 'mcp' ? MCP_HELP : (cliHelp(group) ?? '')) + global;
        // Words after ` -- ` belong to the command being launched, not to Salaam.
        const own = m[2]!.split(' -- ')[0]!;
        for (const f of own.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g))
          if (!help.includes(f[1]!)) add(`salaam ${group} has no ${f[1]} option`);
      }
    }
    for (const m of text.matchAll(/\bSALAAM_[A-Z0-9_]+\b/g))
      if (!sourceText.includes(m[0])) add(`${m[0]} is not read by the code`);
    for (const m of text.matchAll(/~\/\.config\/salaam\/([\w.-]+)/g))
      if (!sourceText.includes(m[1]!) && !EXAMPLE_FILES.has(m[1]!))
        add(`~/.config/salaam/${m[1]} is not used by the code`);
  }
  return problems;
}

/** Every TypeScript source under `dir`, joined, for the lint's existence checks. */
export function sourceTextOf(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += sourceTextOf(path);
    else if (entry.name.endsWith('.ts')) out += readFileSync(path, 'utf8');
  }
  return out;
}
