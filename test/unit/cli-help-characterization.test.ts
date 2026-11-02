import { expect, test } from 'vitest';
import { cliHelp, hasHelpFlag } from '../../src/cli/help.js';

// Phase 6 characterization: the CLI's help text, byte for byte, for every command group. The
// generated docs read it, and the refactor that moves each group's text beside its command must
// not change a character.
const GROUPS = [
  'a2a',
  'harness',
  'workers',
  'team',
  'agents',
  'code',
  'here',
  'tui',
  'remote',
  'workspace',
  'commands',
  'execution',
  'acp',
  'artifacts',
  'host',
  'schedules',
  'inbox',
  'jobs',
  'tasks',
  'task',
  'history',
  'compactions',
  'providers',
  'models',
  'auth',
  'service',
  'session',
  'attach',
  'approvals',
  'operations',
  'children',
];

test('the help for every group is unchanged', () => {
  expect(cliHelp()).toMatchSnapshot('salaam --help');
  expect(Object.fromEntries(GROUPS.map((g) => [g, cliHelp(g)]))).toMatchSnapshot('groups');
});

test('groups without their own help have none', () => {
  for (const group of ['mcp', 'nope', 'help']) expect(cliHelp(group)).toBeUndefined();
});

test('a prompt containing --help stays a prompt', () => {
  expect(hasHelpFlag(['session', 'submit', 'x', '--text', '--help'])).toBe(false);
  expect(hasHelpFlag(['session', 'submit', 'x', '--help'])).toBe(true);
  expect(hasHelpFlag(['tasks', 'create', 'x', '--plan', '-h'])).toBe(false);
});
