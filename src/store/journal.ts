// What the store's query groups need from the store itself: its connection, its transactions and
// its event log. The Store satisfies it; the groups never import the Store, so they stay out of its
// import cycle.
import type { DatabaseSync } from 'node:sqlite';
import type { DurableEvent, Session } from '../core/index.js';

export interface Journal {
  readonly db: DatabaseSync;
  transaction<T>(fn: () => T): T;
  request<T>(actor: string, id: string, input: unknown, fn: () => T): T;
  event(id: string, kind: string, payload: unknown, cause?: string | null): DurableEvent;
  session(id: string): Session;
}
