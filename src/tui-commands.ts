export const SLASH_COMMANDS = [
  { name: 'help', description: 'Show available commands' },
  { name: 'model', description: 'Choose provider and model for a new session' },
  {
    name: 'coding',
    description: 'New local coding session with reviewed edits and unsandboxed commands',
  },
  { name: 'new', description: 'Create a session in a workspace' },
  { name: 'sessions', description: 'Switch or resume a session' },
  { name: 'compact', description: 'Compact an idle session using its durable checkpoint' },
  { name: 'status', description: 'Show connection, model and session capabilities' },
] as const;
/** Slash input is always local; malformed or unknown commands never become prompts. */
export function slashCommand(text: string): string | null {
  const value = text.trim();
  if (!value.startsWith('/')) return null;
  const name = value.slice(1);
  if (!SLASH_COMMANDS.some((command) => command.name === name))
    throw new Error(
      'Unknown command or unsupported arguments. Use /help. To send literal slash-prefixed text, put it in a code block.',
    );
  return name;
}
