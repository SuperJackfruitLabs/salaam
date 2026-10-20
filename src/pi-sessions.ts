import { SessionManager } from '@earendil-works/pi-coding-agent';
/** Session files are written only by Pi's pinned session manager, never edited as JSONL. */
export function forkPiSession(source: string, cwd: string, directory: string, id: string): string {
  const branch = SessionManager.forkFrom(source, cwd, directory, { id, parentSession: source });
  const file = branch.getSessionFile();
  if (!file || branch.getSessionId() !== id)
    throw new Error('Pi did not create the requested branch identity');
  return file;
}
