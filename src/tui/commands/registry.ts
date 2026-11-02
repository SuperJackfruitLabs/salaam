import { SLASH_COMMANDS } from '../../core/index.js';
import { GIT_COMMANDS } from './git.js';
import { INSPECT_COMMANDS } from './inspect.js';
import { MODEL_COMMANDS } from './model.js';
import { PERMISSION_COMMANDS } from './permissions.js';
import { SESSION_COMMANDS } from './session.js';
import { TURN_COMMANDS } from './turn.js';
import type { CommandContext, SlashCommand } from './types.js';

/** Every slash command's handler. SLASH_COMMANDS names each command once; a test holds the two
 * lists to each other, so a command cannot lose its handler or a handler its command. */
export const SLASH_HANDLERS: readonly SlashCommand[] = [
  ...SESSION_COMMANDS,
  ...MODEL_COMMANDS,
  ...GIT_COMMANDS,
  ...TURN_COMMANDS,
  ...INSPECT_COMMANDS,
  ...PERMISSION_COMMANDS,
];

const byName = new Map(SLASH_HANDLERS.flatMap((h) => h.names.map((name) => [name, h] as const)));

/** Run a command by its SLASH_COMMANDS name (not an alias; parseSlashCommand resolves those). */
export async function runSlashCommand(
  ctx: CommandContext,
  command: string,
  args = '',
): Promise<void> {
  const snapshot = ctx.client.snapshot;
  const definition = SLASH_COMMANDS.find((c) => c.name === command);
  if (!definition) throw new Error('Unknown command. Use /help.');
  if (definition.kind === 'unavailable')
    throw new Error(definition.description + '. No session or files were changed.');
  const handler = byName.get(command);
  if (handler?.session === false) return handler.run(ctx, args, command);
  if (!snapshot) throw new Error('Choose a session with /sessions or /new first.');
  if (!handler) throw new Error('Command has no handler: ' + command);
  return handler.run(ctx, args, command, snapshot);
}
