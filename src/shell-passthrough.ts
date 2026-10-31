/**
 * `!command` in a desk session (trial polish #12, 2026-10-31). The terminal never runs the command
 * itself: it asks the model to run exactly that text through salaam_local. The service reads the
 * same fixed prompt back from the turn's submission and binds the turn to the typed command, so a
 * model that runs anything else is refused, whatever the session's mode.
 */
const LEAD = 'I want to run this shell command myself. Run exactly this command with salaam_local';

export function shellPassthrough(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith('!') || t.startsWith('!!')) return undefined;
  const command = t.slice(1).trim();
  if (command === '' || command.includes('\n') || command.includes('```')) return undefined;
  return [
    LEAD,
    '(action "command"), unchanged: no edits, no extra flags, no other commands. Then show me its',
    'output and exit status, and do nothing else unless I ask.',
    '',
    '```sh',
    command,
    '```',
  ].join('\n');
}

/** The command a turn's prompt binds it to, when the prompt is exactly a `!command` request. */
export function boundShellCommand(prompt: string): string | undefined {
  if (!prompt.startsWith(LEAD + '\n')) return undefined;
  const lines = prompt.split('\n');
  if (lines.length !== 7 || lines[4] !== '```sh' || lines[6] !== '```') return undefined;
  const command = lines[5]!;
  return shellPassthrough('!' + command) === prompt ? command : undefined;
}
