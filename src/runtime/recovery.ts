// What a restarted service does with the previous one's workers: a worker whose process identity
// still matches is stopped; one that cannot be proven stopped needs reconciliation.
import { groupExists, processIdentity } from '../core/index.js';
import type { Store } from '../store/index.js';

/** How long to wait for a stopped worker's process group to go: tries, and the pause between. */
const STOP_POLLS = 40;
const STOP_POLL_MS = 25;

export async function recoverWorkers(store: Store): Promise<void> {
  const rows = store.db.prepare("SELECT * FROM workers WHERE state!='exited'").all() as {
    session_id: string;
    epoch: number;
    pid: number | null;
    identity: string | null;
  }[];
  for (const row of rows) {
    let error: string | null = null;
    if (row.pid === null || row.identity === null)
      error = 'Previous worker identity was not recorded; manual reconciliation required';
    else {
      const actual = processIdentity(row.pid);
      if (actual === row.identity) {
        try {
          process.kill(-row.pid, 'SIGKILL');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
            error = 'Previous worker cannot be stopped';
        }
        for (let i = 0; i < STOP_POLLS && groupExists(row.pid); i++)
          await new Promise((r) => setTimeout(r, STOP_POLL_MS));
      }
      if (groupExists(row.pid)) error = 'Previous worker group cannot be proven stopped';
    }
    // A mismatched live PID is never signalled. Its group still blocks reuse.
    store.state(
      row.session_id,
      row.epoch,
      error ? 'unhealthy' : 'exited',
      error ?? 'Service restart interrupted this worker',
    );
  }
}
