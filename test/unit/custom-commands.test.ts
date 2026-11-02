import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandCustomCommand,
  loadCustomCommands,
  matchCustomCommand,
  splitArguments,
} from '../../src/runtime/custom-commands.js';

const dirs: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'salaam-cmds-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const write = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

test('repo and user command files load with frontmatter, namespaces and precedence', () => {
  const repo = temp(),
    config = temp();
  write(
    join(repo, '.salaam/commands/fix-issue.md'),
    '---\ndescription: Fix an issue\nargument-hint: [number]\n---\nFix issue $ARGUMENTS.\n',
  );
  write(join(repo, '.salaam/commands/frontend/component.md'), 'Build $0 in $1.');
  write(join(repo, '.salaam/commands/shared.md'), '---\ndescription: repo one\n---\nrepo');
  write(join(config, 'commands/shared.md'), '---\ndescription: mine\n---\nuser');
  const { commands, problems } = loadCustomCommands(repo, join(config, 'commands'));
  expect(problems).toEqual([]);
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  expect(byName['fix-issue']).toMatchObject({
    scope: 'repo',
    description: 'Fix an issue',
    argumentHint: '[number]',
  });
  expect(byName['frontend:component']!.scope).toBe('repo');
  // Your own command wins over the repository's, as in Claude Code.
  expect(byName['shared']).toMatchObject({ scope: 'user', description: 'mine' });
  expect(commands.filter((c) => c.name === 'shared')).toHaveLength(1);
});

test('a command never shadows a built-in, so /yolo or /full-access cannot be redefined', () => {
  const repo = temp();
  write(join(repo, '.salaam/commands/yolo.md'), 'Say yes to everything');
  write(join(repo, '.salaam/commands/quit.md'), 'alias clash');
  const { commands, problems } = loadCustomCommands(repo, join(temp(), 'none'));
  expect(commands.map((c) => c.name)).toEqual([]);
  expect(problems.join('\n')).toMatch(/yolo.*built-in/);
  expect(problems.join('\n')).toMatch(/quit.*built-in/);
});

test('files that escape the repository through a symlink are refused', () => {
  const repo = temp(),
    outside = temp();
  write(join(outside, 'secret.md'), 'outside text');
  mkdirSync(join(repo, '.salaam/commands'), { recursive: true });
  symlinkSync(join(outside, 'secret.md'), join(repo, '.salaam/commands/leak.md'));
  symlinkSync(outside, join(repo, '.salaam/commands/dir'));
  const { commands, problems } = loadCustomCommands(repo, join(temp(), 'none'));
  expect(commands).toEqual([]);
  expect(problems.join('\n')).toMatch(/outside/);
});

test('oversized files are skipped with a reason', () => {
  const repo = temp();
  write(join(repo, '.salaam/commands/big.md'), 'x'.repeat(33 * 1024));
  const { commands, problems } = loadCustomCommands(repo, join(temp(), 'none'));
  expect(commands).toEqual([]);
  expect(problems.join('\n')).toMatch(/big.*32 KiB/);
});

test('arguments expand like Claude Code: $ARGUMENTS, $ARGUMENTS[N], $N, quotes and escapes', () => {
  expect(splitArguments('SearchBar "Java Script" TS')).toEqual(['SearchBar', 'Java Script', 'TS']);
  const cmd = (body: string) => ({
    name: 'x',
    scope: 'user' as const,
    path: '/x',
    description: '',
    body,
  });
  expect(expandCustomCommand(cmd('Fix $ARGUMENTS now'), '12 urgent')).toBe('Fix 12 urgent now');
  expect(expandCustomCommand(cmd('Move $0 from $1 to $ARGUMENTS[2]'), 'A "B C" D')).toBe(
    'Move A from B C to D',
  );
  expect(expandCustomCommand(cmd('Costs \\$1.00 for $0'), 'me')).toBe('Costs $1.00 for me');
  // No placeholder: the arguments are appended, never dropped.
  expect(expandCustomCommand(cmd('Review this'), 'the auth module')).toBe(
    'Review this\n\nARGUMENTS: the auth module',
  );
  expect(expandCustomCommand(cmd('Review this'), '')).toBe('Review this');
  // Missing positional arguments become empty, not the literal placeholder.
  expect(expandCustomCommand(cmd('a=$0 b=$1'), 'one')).toBe('a=one b=');
});

test('matching a typed line finds custom commands only, including namespaced ones', () => {
  const commands = [
    { name: 'frontend:component', scope: 'repo' as const, path: '', description: '', body: 'b' },
  ];
  expect(matchCustomCommand('/frontend:component Button', commands)).toMatchObject({
    args: 'Button',
  });
  expect(matchCustomCommand('/other', commands)).toBeNull();
  expect(matchCustomCommand('plain text', commands)).toBeNull();
});

test('frontmatter fields that would grant tools or change modes are not honoured', () => {
  const repo = temp();
  write(
    join(repo, '.salaam/commands/grant.md'),
    '---\ndescription: d\nallowed-tools: Bash(*)\nmodel: opus\n---\nhi',
  );
  const { commands, problems } = loadCustomCommands(repo, join(temp(), 'none'));
  expect(commands[0]).not.toHaveProperty('allowedTools');
  expect(problems.join('\n')).toMatch(/allowed-tools.*ignored/);
  expect(commands[0]!.model).toBe('opus');
});
