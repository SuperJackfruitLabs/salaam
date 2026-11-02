import { SessionManager } from '@earendil-works/pi-coding-agent';
/** Session files are written only by Pi's pinned session manager, never edited as JSONL. */
export function forkPiSession(
  source: string,
  cwd: string,
  directory: string,
  id: string,
  /** Continue from this earlier entry (a rewind) instead of the latest one. */
  at?: { leaf: string | null; summary: string },
): string {
  const branch = SessionManager.forkFrom(source, cwd, directory, { id, parentSession: source });
  const file = branch.getSessionFile();
  if (!file || branch.getSessionId() !== id)
    throw new Error('Pi did not create the requested branch identity');
  if (at) branch.branchWithSummary(at.leaf, at.summary);
  return file;
}
