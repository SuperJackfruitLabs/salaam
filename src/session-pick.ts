/** How `salaam code` opens a folder: continue its latest session (the default), start a new
 * coding session, or pick one from the list. */
export type CodeStart = 'continue' | 'new' | 'resume';

export function parseCodeStart(flags: string[]): CodeStart {
  const chosen = (['continue', 'new', 'resume'] as const).filter((f) => flags.includes('--' + f));
  if (chosen.length > 1) throw new Error('Choose one of --continue, --new or --resume.');
  return chosen[0] ?? 'continue';
}

const folder = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The most recently created session in this folder; sessions come oldest first. */
export function latestSessionFor(
  sessions: readonly { id: string; cwd: string }[],
  cwd: string,
): string | undefined {
  const want = folder(cwd);
  return [...sessions].reverse().find((s) => folder(s.cwd) === want)?.id;
}
