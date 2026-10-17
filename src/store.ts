import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  digest,
  ServiceError,
  type Session,
  type DurableEvent,
  type WorkerState,
} from './protocol.js';

export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  private committed: DurableEvent[] | null = null;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;`,
    );
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 1) {
      this.db.close();
      throw new ServiceError('schema_too_new', 'Database schema is newer than this service');
    }
    if (version === 0)
      this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'stopped', epoch INTEGER NOT NULL DEFAULT 0, pi_session_id TEXT NOT NULL UNIQUE,
        pi_session_file TEXT, pi_cursor TEXT, pi_leaf TEXT, error TEXT, capabilities TEXT NOT NULL DEFAULT '[]', seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE requests (actor TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,id));
      CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL, id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, causation_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE workers (session_id TEXT NOT NULL REFERENCES sessions(id), epoch INTEGER NOT NULL, boot_id TEXT NOT NULL,
        pid INTEGER, identity TEXT, state TEXT NOT NULL, PRIMARY KEY(session_id,epoch));
      CREATE TABLE submissions (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'accepted');
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), digest TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE TABLE pi_entries (session_id TEXT NOT NULL REFERENCES sessions(id), entry_id TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(session_id,entry_id));
      PRAGMA user_version=1; COMMIT;`);
  }
  transaction<T>(fn: () => T): T {
    if (this.committed) throw new Error('Nested transaction');
    this.db.exec('BEGIN IMMEDIATE');
    this.committed = [];
    let result: T;
    let events: DurableEvent[];
    try {
      result = fn();
      this.db.exec('COMMIT');
      events = this.committed;
    } catch (error) {
      // SQLITE_FULL can roll the transaction back itself. Preserve its cause.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.committed = null;
    }
    for (const event of events!) this.changes.emit('event', event);
    return result!;
  }
  writable(): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sessions SET revision=revision WHERE 0').run();
    });
  }
  request<T>(actor: string, id: string, input: unknown, fn: () => T): T {
    return this.transaction(() => {
      const hash = digest(input);
      const prior = this.db
        .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
        .get(actor, id) as { hash: string; response: string } | undefined;
      if (prior) {
        if (prior.hash !== hash)
          throw new ServiceError(
            'request_conflict',
            'Request ID was already used with different input',
          );
        return JSON.parse(prior.response) as T;
      }
      const response = fn();
      this.db
        .prepare('INSERT INTO requests VALUES (?,?,?,?)')
        .run(actor, id, hash, JSON.stringify(response));
      return response;
    });
  }
  create(cwd: string, requestId: string): Session {
    return this.request('local-operator', requestId, { kind: 'create', cwd }, () => {
      const id = randomUUID();
      this.db.prepare('INSERT INTO sessions(id,cwd,pi_session_id) VALUES (?,?,?)').run(id, cwd, id);
      this.event(id, 'session.created', { cwd }, requestId);
      return this.session(id);
    });
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as
      (Omit<Session, 'capabilities'> & { capabilities: string }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Session not found', 404);
    return { ...row, capabilities: JSON.parse(row.capabilities) };
  }
  sessions(): Session[] {
    return (
      this.db.prepare('SELECT id FROM sessions ORDER BY rowid').all() as { id: string }[]
    ).map((x) => this.session(x.id));
  }
  event(id: string, kind: string, payload: unknown, cause: string | null = null): DurableEvent {
    if (!this.committed) throw new Error('Event must be part of a transaction');
    this.db.prepare('UPDATE sessions SET seq=seq+1,revision=revision+1 WHERE id=?').run(id);
    const seq = this.session(id).seq;
    const event_id = randomUUID();
    this.db
      .prepare('INSERT INTO events VALUES (?,?,?,?,?,?)')
      .run(id, seq, event_id, kind, cause, JSON.stringify(payload));
    const event: DurableEvent = {
      schema_version: 1,
      event_id,
      session_id: id,
      seq,
      kind,
      causation_id: cause,
      payload,
    };
    this.committed.push(event);
    return event;
  }
  events(id: string, after: number, limit = 256): DurableEvent[] {
    this.session(id);
    return (
      this.db
        .prepare('SELECT * FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?')
        .all(id, after, limit) as {
        id: string;
        seq: number;
        kind: string;
        causation_id: string | null;
        payload: string;
      }[]
    ).map((row) => ({
      schema_version: 1,
      event_id: row.id,
      session_id: id,
      seq: row.seq,
      kind: row.kind,
      causation_id: row.causation_id,
      payload: JSON.parse(row.payload),
    }));
  }
  allocate(id: string, bootId: string): number {
    return this.transaction(() => {
      const old = this.session(id);
      if (['starting', 'ready'].includes(old.state))
        throw new ServiceError('worker_exists', 'Worker already active');
      const epoch = old.epoch + 1;
      this.db
        .prepare(
          "UPDATE sessions SET epoch=?,state='starting',error=NULL,capabilities='[]' WHERE id=?",
        )
        .run(epoch, id);
      this.db
        .prepare("INSERT INTO workers(session_id,epoch,boot_id,state) VALUES (?,?,?,'starting')")
        .run(id, epoch, bootId);
      this.event(id, 'worker.starting', { epoch });
      return epoch;
    });
  }
  process(id: string, epoch: number, pid: number, identity: string): void {
    this.transaction(() => {
      this.assertEpoch(id, epoch);
      this.db
        .prepare('UPDATE workers SET pid=?,identity=? WHERE session_id=? AND epoch=?')
        .run(pid, identity, id, epoch);
    });
  }
  assertEpoch(id: string, epoch: number): Session {
    const session = this.session(id);
    if (session.epoch !== epoch)
      throw new ServiceError('stale_worker', 'Worker epoch is no longer current');
    return session;
  }
  state(
    id: string,
    epoch: number,
    state: WorkerState,
    error: string | null = null,
    capabilities: string[] = [],
    piFile?: string,
  ): void {
    this.transaction(() => {
      this.assertEpoch(id, epoch);
      this.db
        .prepare(
          'UPDATE sessions SET state=?,error=?,capabilities=?,pi_session_file=COALESCE(?,pi_session_file) WHERE id=?',
        )
        .run(state, error, JSON.stringify(capabilities), piFile ?? null, id);
      this.db
        .prepare('UPDATE workers SET state=? WHERE session_id=? AND epoch=?')
        .run(state, id, epoch);
      this.event(id, `worker.${state}`, { epoch, error, capabilities });
    });
  }
  accept(
    id: string,
    requestId: string,
    expectedRevision: number,
    text: string,
  ): { id: string; state: 'accepted' } {
    return this.request(
      'local-operator',
      requestId,
      { kind: 'submit', session: id, expectedRevision, text },
      () => {
        if (this.session(id).revision !== expectedRevision)
          throw new ServiceError('revision_conflict', 'Session revision changed');
        const submission = randomUUID();
        this.db
          .prepare('INSERT INTO submissions(id,session_id,text) VALUES (?,?,?)')
          .run(submission, id, text);
        this.event(id, 'submission.accepted', { submission_id: submission }, requestId);
        return { id: submission, state: 'accepted' };
      },
    );
  }
  importEntries(id: string, epoch: number, entries: { id: string }[], leaf: string | null): void {
    this.transaction(() => {
      this.assertEpoch(id, epoch);
      for (const entry of entries)
        this.db
          .prepare('INSERT OR IGNORE INTO pi_entries VALUES (?,?,?)')
          .run(id, entry.id, JSON.stringify(entry));
      this.db
        .prepare('UPDATE sessions SET pi_cursor=COALESCE(?,pi_cursor),pi_leaf=? WHERE id=?')
        .run(entries.at(-1)?.id ?? null, leaf, id);
      this.event(id, 'transcript.synced', { entries: entries.length, leaf });
    });
  }
  close(): void {
    this.db.close();
  }
}
