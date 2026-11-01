import { test, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { readLocalWorkspace } from '../../src/local/workspace.js';
import { slashCommand, SLASH_COMMANDS } from '../../src/tui/commands.js';

test('local inspection reads actual files and excludes private paths, symlinks and hard links', () => {
  const root = realpathSync(mkdtempSync('/tmp/sal-local-'));
  try {
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'research.md'), '# Research\nEvidence: BLUEBIRD\n');
    writeFileSync(join(root, '.env'), 'SECRET');
    symlinkSync('/etc/passwd', join(root, 'outside'));
    linkSync(join(root, '.env'), join(root, 'alias'));
    expect(readLocalWorkspace(root, { action: 'read', path: 'notes/research.md' })).toMatchObject({
      text: '1: # Research\n2: Evidence: BLUEBIRD\n3: \n',
      next_offset: null,
    });
    expect(readLocalWorkspace(root, { action: 'search', query: 'BLUEBIRD' })).toMatchObject({
      matches: [{ path: 'notes/research.md', line: 2, text: 'Evidence: BLUEBIRD' }],
    });
    for (const path of ['../outside', '.env', 'outside', 'alias', '/etc/passwd'])
      expect(() => readLocalWorkspace(root, { action: 'read', path })).toThrow();
    expect(() =>
      readLocalWorkspace(root, { action: 'patch', path: 'notes/research.md' }),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('all advertised slash commands parse; unknown commands never become prompts', () => {
  for (const command of SLASH_COMMANDS) expect(slashCommand('/' + command.name)).toBe(command.name);
  for (const text of ['/bad', '/help\nmalicious'])
    expect(() => slashCommand(text)).toThrow('Unknown command');
  expect(slashCommand('explain /model')).toBeNull();
});
