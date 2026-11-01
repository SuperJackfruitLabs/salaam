import { randomUUID } from 'node:crypto';
import type { Store } from '../store/index.js';
import { ServiceError } from '../core/index.js';

/**
 * Board reads (operator ruling 2026-10-28, option iii). While it works, the agent may read its own
 * card, its card's runs, and search or open library items, the way an agent with board tools does.
 * Salaam holds no SuperPipeline or SuperLibrary credential: it records the read, the hub sees it in
 * work status, serves it with its own clients, and answers. A read names no card, board or
 * credential; the hub decides scope from the run it is serving. Read-only: nothing here asks for
 * approval, and nothing a read returns authorizes anything.
 */
export type BoardReadAction = 'card' | 'attempts' | 'library_search' | 'library_get';
export interface BoardRead {
  id: string;
  action: BoardReadAction;
  args: Record<string, string>;
  state: 'pending' | 'answered';
  ok?: boolean;
  text?: string;
  error?: string;
}
const ITEM = /^itm_[0-9a-f]{16}$/;
/** The most a hub answer may carry back to the agent. */
export const BOARD_READ_MAX_BYTES = 256 * 1024;

const bad = (message: string) => new ServiceError('invalid_board_read', message, 400);

/** Closed arguments per action; anything else is refused. */
export function boardReadArgs(input: Record<string, unknown>): {
  action: BoardReadAction;
  args: Record<string, string>;
} {
  const { action, ...rest } = input;
  const keys = Object.keys(rest).filter((k) => rest[k] !== undefined);
  if (action === 'card' || action === 'attempts') {
    if (keys.length) throw bad(`${action} takes no arguments: it is always this run's own card`);
    return { action, args: {} };
  }
  if (action === 'library_search') {
    const q = rest.query;
    if (keys.join() !== 'query' || typeof q !== 'string' || !q.trim() || q.length > 500)
      throw bad('library_search takes one query of 1 to 500 characters');
    return { action, args: { query: q.trim() } };
  }
  if (action === 'library_get') {
    const id = rest.item_id;
    if (keys.join() !== 'item_id' || typeof id !== 'string' || !ITEM.test(id))
      throw bad('library_get takes one item_id (itm_ and 16 hex characters)');
    return { action, args: { item_id: id } };
  }
  throw bad('Board reads are card, attempts, library_search or library_get');
}

export class BoardReads {
  constructor(private readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS board_reads(
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, action TEXT NOT NULL,
      args TEXT NOT NULL, state TEXT NOT NULL, ok INTEGER, text TEXT, error TEXT,
      created_at TEXT NOT NULL, answered_at TEXT, UNIQUE(session_id, tool_call_id))`);
  }
  private view(row: Record<string, unknown>): BoardRead {
    return {
      id: String(row.id),
      action: String(row.action) as BoardReadAction,
      args: JSON.parse(String(row.args)) as Record<string, string>,
      state: String(row.state) as BoardRead['state'],
      ...(row.state === 'answered'
        ? {
            ok: row.ok === 1,
            ...(row.text !== null ? { text: String(row.text) } : {}),
            ...(row.error !== null ? { error: String(row.error) } : {}),
          }
        : {}),
    };
  }
  /** Record a read for this session, once per tool call. */
  request(session: string, toolCallId: string, input: Record<string, unknown>): BoardRead {
    const { action, args } = boardReadArgs(input);
    const existing = this.store.db
      .prepare('SELECT * FROM board_reads WHERE session_id=? AND tool_call_id=?')
      .get(session, toolCallId);
    if (existing) return this.view(existing);
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO board_reads(id,session_id,tool_call_id,action,args,state,created_at) VALUES (?,?,?,?,?,'pending',?)",
      )
      .run(id, session, toolCallId, action, JSON.stringify(args), new Date().toISOString());
    return this.get(session, id);
  }
  get(session: string, id: string): BoardRead {
    const row = this.store.db
      .prepare('SELECT * FROM board_reads WHERE id=? AND session_id=?')
      .get(id, session);
    if (!row) throw new ServiceError('board_read_not_found', 'No such board read', 404);
    return this.view(row);
  }
  /** What the hub should serve for this session, oldest first. */
  pending(
    session: string,
  ): { id: string; action: BoardReadAction; args: Record<string, string> }[] {
    return this.store.db
      .prepare(
        "SELECT * FROM board_reads WHERE session_id=? AND state='pending' ORDER BY rowid LIMIT 8",
      )
      .all(session)
      .map((r) => {
        const v = this.view(r);
        return { id: v.id, action: v.action, args: v.args };
      });
  }
  /** The hub's answer: once, for a read of this session, bounded. */
  answer(session: string, value: unknown): BoardRead {
    const a = (value ?? {}) as Record<string, unknown>;
    const keys = Object.keys(a).sort().join();
    const ok = a.ok === true;
    if (
      typeof a.read_id !== 'string' ||
      (ok
        ? keys !== 'ok,read_id,text' || typeof a.text !== 'string'
        : keys !== 'error,ok,read_id' || a.ok !== false || typeof a.error !== 'string')
    )
      throw bad('Closed board read answer required');
    const body = ok ? (a.text as string) : (a.error as string);
    if (Buffer.byteLength(body) > (ok ? BOARD_READ_MAX_BYTES : 2048))
      throw bad('Board read answer too large');
    const done = this.store.db
      .prepare(
        "UPDATE board_reads SET state='answered',ok=?,text=?,error=?,answered_at=? WHERE id=? AND session_id=? AND state='pending'",
      )
      .run(
        ok ? 1 : 0,
        ok ? body : null,
        ok ? null : body,
        new Date().toISOString(),
        a.read_id,
        session,
      );
    if (done.changes !== 1)
      throw new ServiceError(
        'board_read_settled',
        'That board read is not pending for this run',
        409,
      );
    return this.get(session, a.read_id);
  }
}
