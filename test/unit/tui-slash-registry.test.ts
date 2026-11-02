import { expect, test } from 'vitest';
import { SLASH_COMMANDS } from '../../src/core/slash-commands.js';
import { SLASH_HANDLERS } from '../../src/tui/commands/registry.js';

// SLASH_COMMANDS owns every command's name, aliases and description (help, completion, the
// palette and the generated docs read it); SLASH_HANDLERS says what each name does. Each must
// name exactly the other's commands, once.
const handled = SLASH_HANDLERS.flatMap((h) => h.names);

test('every slash command has exactly one handler', () => {
  for (const command of SLASH_COMMANDS)
    expect(
      handled.filter((name) => name === command.name),
      `/${command.name}`,
    ).toHaveLength(1);
});

test('every handler serves a slash command by its name, never an alias', () => {
  const names = new Set(SLASH_COMMANDS.map((c) => c.name));
  expect(handled.filter((name) => !names.has(name))).toEqual([]);
  expect(handled).toHaveLength(SLASH_COMMANDS.length);
});

test('only these commands run without an open session', () => {
  const sessionless = SLASH_HANDLERS.filter((h) => !h.session).flatMap((h) => h.names);
  expect(sessionless.toSorted()).toEqual(
    [
      'coding',
      'exit',
      'help',
      'hooks',
      'keys',
      'model',
      'new',
      'provider',
      'sessions',
      'settings',
      'status',
    ].toSorted(),
  );
});
