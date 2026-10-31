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
  command('model', 'Switch this session’s provider and model', ['models'], '[provider/model]'),
  command('provider', 'Switch this session’s provider', [], '[provider]'),
  command('thinking', 'Switch this session’s reasoning effort', [], '[level]'),
  command('coding', 'New local coding session with reviewed edits and commands', [], '[workspace]'),
  command('init', 'Draft an AGENTS.md for this repository; the edit asks for approval'),
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
  command('diff', 'Review workspace changes file by file'),
  command(
    'commit',
    'Draft a commit of the current work; staging and the commit each ask (uses provider credits)',
    [],
    undefined,
    'model',
  ),
  command('branch', 'Switch to a branch, creating it if needed', [], '<name>', 'model'),
  command(
    'pr',
    'Push this branch and open a pull request; both always ask, except in YOLO',
    [],
    '[base]',
    'model',
  ),
  command('tools', 'Inspect available capabilities and recorded tool activity'),
  command('permissions', 'Configure local permissions independently of task progression'),
  command('mode', 'Cycle review → accept edits → auto → plan (shift+tab)'),
  command(
    'full-access',
    'Turn full access on or off: commands run without the OS sandbox; dangerous ones still ask',
  ),
  command('yolo', 'Turn YOLO on (type yolo to confirm) or off: no sandbox and no approvals'),
  command('approvals', 'Review exact pending approval requests'),
  command('context', 'Inspect session context, facts and usage'),
  command('usage', 'Show recorded usage and unknown observations'),
  command('status', 'Show connection, model and session capabilities'),
  command('copy', 'Copy the last complete assistant response to the local clipboard'),
  command('export', 'Export full durable conversation as Markdown; never overwrite', [], '[path]'),
  command('settings', 'Choose terminal appearance and model settings'),
  command('fork', 'Fork an idle local conversation; keep the same workspace'),
  command('rewind', 'Rewind files, conversation or both to before an earlier turn', [], '[turn]'),
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
  command(
    'skills',
    'Inspect or review digest-bound context and skills',
    [],
    '[review <paths...>|clear]',
  ),
  command('mcp', 'Show admitted managed MCP capabilities'),
  command('agents', 'Inspect native/external worker profiles and child work'),
  command('progression', 'Choose manual or bounded task progression; permissions stay separate'),
  command('tasks', 'Open durable task actions'),
  command('jobs', 'Show background commands and their output, or stop one', ['bg'], '[stop <id>]'),
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

/** What /init asks the agent to do. The write goes through the session's normal edit approval. */
export const INIT_INSTRUCTION = [
  'Draft an AGENTS.md for this repository.',
  'First read the tree and the files that define how it is built and tested (package manifests, build and CI configuration, README, existing contributor docs, any CLAUDE.md).',
  'Then write AGENTS.md at the repository root: a short overview, the exact commands to build, test, lint and format, the code layout, and conventions a contributor must follow.',
  'Keep it under 150 lines, state only what the files show, and if AGENTS.md already exists, propose improvements to it instead of replacing it.',
].join(' ');
