// Reading a worker's Pi session entries since the stored cursor, and importing them.
import { object } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { Worker } from './worker.js';

export interface PiEntries {
  entries: { id: string }[];
  leaf: string | null;
}

export async function readPiEntries(store: Store, w: Worker): Promise<PiEntries> {
  const cursor = store.session(w.id).pi_cursor;
  const entries = object(
    (await w.pi!.command('get_entries', cursor ? { since: cursor } : {})).data,
  );
  if (
    !Array.isArray(entries.entries) ||
    entries.entries.some((entry) => typeof object(entry).id !== 'string')
  )
    throw new Error('Invalid Pi entries');
  return {
    entries: entries.entries as { id: string }[],
    leaf: typeof entries.leafId === 'string' ? entries.leafId : null,
  };
}

export async function syncPiEntries(store: Store, w: Worker): Promise<void> {
  const entries = await readPiEntries(store, w);
  store.importEntries(w.id, w.epoch, entries.entries, entries.leaf);
}
