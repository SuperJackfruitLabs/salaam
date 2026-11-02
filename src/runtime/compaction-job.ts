// A granted managed compaction running on the worker: Pi compacts, Salaam imports its receipt, and
// a failure is settled as cancelled, failed or (when the outcome is ambiguous) interrupted.
import type { Store } from '../store/index.js';
import { PiCommandError } from './pi.js';
import type { TaskContext } from './task-context.js';
import type { Worker } from './worker.js';

export interface CompactionJobDeps {
  readonly store: Store;
  readonly tasks: TaskContext;
  sync(w: Worker): Promise<void>;
  invalidate(w: Worker, reason: string): void;
  /** The worker is free for its next turn. */
  idle(): void;
}

/** How long Pi may take to compact. */
const COMPACT_TIMEOUT = 30000;

export async function runCompaction(
  s: CompactionJobDeps,
  w: Worker,
  compaction: string,
): Promise<void> {
  try {
    await w.pi!.command('compact', {}, COMPACT_TIMEOUT);
    await s.sync(w);
    if (s.tasks.compaction(compaction).state !== 'completed')
      throw new Error('Pi compaction receipt missing');
  } catch (error) {
    try {
      // A pipe response can be lost after Pi persisted its receipt.
      if (!w.stopping && !w.invalid) await s.sync(w);
      const ambiguous = !(error instanceof PiCommandError);
      if (ambiguous && s.tasks.compaction(compaction).state !== 'completed')
        s.invalidate(w, 'Compaction outcome requires reconciliation');
      s.tasks.settle(
        compaction,
        ambiguous
          ? 'interrupted'
          : s.store.db.prepare('SELECT 1 FROM compaction_cancellations WHERE id=?').get(compaction)
            ? 'cancelled'
            : 'failed',
        (error as Error).message,
      );
    } catch {
      s.invalidate(w, 'Compaction reconciliation failed');
    }
  } finally {
    w.busy = false;
    delete w.compaction;
    s.idle();
  }
}
