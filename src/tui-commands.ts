export interface SlashDefinition {
  name: string;
  aliases: readonly string[];
  description: string;
  arguments?: string;
  kind: 'local' | 'model' | 'unavailable';
}
const command = (
  name: string,
  description: string,
  aliases: string[] = [],
  args?: string,
  kind: SlashDefinition['kind'] = 'local',
): SlashDefinition => ({ name, description, aliases, arguments: args, kind });
/** One registry for parsing, help, completion and the command palette. */
export const SLASH_COMMANDS: readonly SlashDefinition[] = [
  command('help', 'Show commands and their execution type', ['commands'], '[command]'),
  command('exit', 'Detach; preserve the session and running work', ['quit', 'q']),
  command('keys', 'Show keyboard shortcuts', ['hotkeys']),
  command('model', 'Choose provider and model for a new session', ['models'], '[provider/model]'),
  command('provider', 'Choose a provider for a new session', [], '[provider]'),
  command('thinking', 'Choose reasoning effort for a new session', [], '[level]'),
  command(
    'coding',
    'New local coding session with reviewed edits and unsandboxed commands',
    [],
    '[workspace]',
  ),
  command('new', 'Create a session in a workspace', [], '[workspace]'),
  command('sessions', 'Switch or resume a session', ['resume'], '[session-id]'),
  command('name', 'Set a durable session label', ['rename'], '<name>'),
  command('history', 'Browse complete durable session history'),
  command('compact', 'Compact an idle session using its durable checkpoint'),
  command('cancel', 'Cancel an instruction with explicit confirmation', ['stop']),
  command('queue', 'Save a durable next-turn instruction, or inspect the queue', [], '[text]'),
  command(
    'steer',
    'Send recorded guidance to an active local turn; uncertain delivery never replays',
    [],
    '<text>',
  ),
  command('diff', 'Review workspace changes'),
  command('tools', 'Inspect available capabilities and recorded tool activity'),
  command('permissions', 'Configure local permissions independently of task progression'),
  command('approvals', 'Review exact pending approval requests'),
  command('context', 'Inspect session context, facts and usage'),
  command('usage', 'Show recorded usage and unknown observations'),
  command('status', 'Show connection, model and session capabilities'),
  command('copy', 'Copy the last complete assistant response to the local clipboard'),
  command('export', 'Export full durable conversation as Markdown; never overwrite', [], '[path]'),
  command('settings', 'Choose terminal appearance and model settings'),
  command('fork', 'Fork an idle local conversation; keep the same workspace'),
  command(
    'undo',
    'Review and revert the last completed local edit; retain conversation history',
    [],
    '[reconcile]',
  ),
  command(
    'plan',
    'Ask the model for a plan (uses provider credits; not a permission mode)',
    [],
    '[request]',
    'model',
  ),
  command(
    'review',
    'Ask the model to review workspace changes (uses provider credits)',
    [],
    '[focus]',
    'model',
  ),
  command('skills', 'Show skill admission status'),
  command('mcp', 'Show admitted managed MCP capabilities'),
  command('agents', 'Inspect native/external worker profiles and child work'),
  command('progression', 'Choose manual or bounded task progression; permissions stay separate'),
  command('tasks', 'Open durable task actions'),
];
export const SLASH_COMPLETIONS = SLASH_COMMANDS.flatMap((c) =>
  [c.name, ...c.aliases].map((name) => ({ name, description: c.description })),
);
export interface ParsedSlashCommand {
  name: string;
  args: string;
  definition: SlashDefinition;
}
/** Slash input is always local; malformed or unknown commands never become prompts. */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const value = text.trim();
  if (!value.startsWith('/')) return null;
  const match = /^\/([a-z][a-z0-9-]*)(?:[ \t]+([\s\S]*))?$/i.exec(value);
  const definition =
    match &&
    SLASH_COMMANDS.find(
      (c) => c.name === match[1]!.toLowerCase() || c.aliases.includes(match[1]!.toLowerCase()),
    );
  if (!match || !definition)
    throw new Error(
      'Unknown command. Use /help. Literal slash-prefixed text can be sent in a code block.',
    );
  const args = (match[2] ?? '').trim();
  if (args && !definition.arguments)
    throw new Error(`/${definition.name} does not accept arguments. Use /help ${definition.name}.`);
  return { name: definition.name, args, definition };
}
export function slashCommand(text: string): string | null {
  return parseSlashCommand(text)?.name ?? null;
}
export function slashHelp(name?: string): string {
  const selected = name
    ? SLASH_COMMANDS.filter(
        (c) => c.name === name.replace(/^\//, '') || c.aliases.includes(name.replace(/^\//, '')),
      )
    : SLASH_COMMANDS;
  if (!selected.length) throw new Error('Unknown command. Use /help.');
  return selected
    .map(
      (c) =>
        `/${c.name}${c.arguments ? ' ' + c.arguments : ''} — ${c.description} [${c.kind}]${c.aliases.length ? '\n  Aliases: ' + c.aliases.map((a) => '/' + a).join(', ') : ''}`,
    )
    .join('\n');
}
