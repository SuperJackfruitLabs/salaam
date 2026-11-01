import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSlashCommand,
  SLASH_COMMANDS,
  SLASH_COMPLETIONS,
  slashHelp,
} from '../../src/tui/commands.js';
import { writeConversationExport } from '../../src/tui/export.js';
import { providerRoute } from '../../src/providers/config.js';

test('all commands and aliases share argument parsing, help and completion', () => {
  const names = SLASH_COMPLETIONS.map((c) => c.name);
  expect(new Set(names).size).toBe(names.length);
  for (const command of SLASH_COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      expect(parseSlashCommand('/' + name)?.name).toBe(command.name);
      expect(names).toContain(name);
      expect(slashHelp(name)).toContain('/' + command.name);
    }
  }
  expect(parseSlashCommand('/queue first\nsecond')?.args).toBe('first\nsecond');
  expect(parseSlashCommand(' /QUIT ')).toMatchObject({ name: 'exit', args: '' });
  expect(parseSlashCommand('/model openrouter/vendor/model')).toMatchObject({
    args: 'openrouter/vendor/model',
  });
  for (const input of ['/unknown', '/exit extra', '/exit\n/queue surprise', '/ /exit'])
    expect(() => parseSlashCommand(input)).toThrow();
  expect(parseSlashCommand('ordinary /exit text')).toBeNull();
});
test('export never overwrites files and is private', () => {
  const dir = mkdtempSync('/tmp/sal-export-');
  try {
    const path = join(dir, 'history.md');
    writeConversationExport(path, 'original');
    expect(() => writeConversationExport(path, 'overwrite')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('original');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('reasoning is explicit durable routing configuration and rejects invalid levels or insufficient caps', () => {
  expect(
    providerRoute('anthropic', 'claude-sonnet-4-6', 4096, undefined, undefined, 'high').reasoning,
  ).toBe('high');
  expect(() =>
    providerRoute('anthropic', 'claude-sonnet-4-6', 1024, undefined, undefined, 'high'),
  ).toThrow();
  expect(() =>
    providerRoute(
      'anthropic',
      'claude-sonnet-4-6',
      4096,
      undefined,
      undefined,
      'surprise' as 'high',
    ),
  ).toThrow();
});
