import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  digest,
  ServiceError,
  type Session,
  type DurableEvent,
  type WorkerState,
  type Attempt,
  type Submission,
  type Controller,
  type ControlLease,
  type ControlView,
  type SessionSnapshot,
  textDigest,
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
    if (version > 2) {
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
    if (version < 2) {
      try {
        this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE submissions ADD COLUMN attempt_id TEXT;
        CREATE TABLE attempts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
          submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id), state TEXT NOT NULL,
          worker_epoch INTEGER, error TEXT, result TEXT, continues_attempt_id TEXT REFERENCES attempts(id), resolved_by TEXT);
        CREATE INDEX attempt_queue ON attempts(session_id,state);
        CREATE TABLE controls (session_id TEXT PRIMARY KEY REFERENCES sessions(id), client_id TEXT, token_hash TEXT,
          epoch INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL DEFAULT 0);`);
        for (const row of this.db.prepare('SELECT id,session_id FROM submissions').all() as {
          id: string;
          session_id: string;
        }[]) {
          const attempt = randomUUID();
          this.db
            .prepare(
              "INSERT INTO attempts(id,session_id,submission_id,state) VALUES (?,?,?,'accepted')",
            )
            .run(attempt, row.session_id, row.id);
          this.db.prepare('UPDATE submissions SET attempt_id=? WHERE id=?').run(attempt, row.id);
        }
        this.db.exec('PRAGMA user_version=2; COMMIT;');
      } catch (error) {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
        this.db.close();
        throw error;
      }
    }
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
    controller?: Controller,
    continuesAttempt: string | null = null,
  ): { id: string; attempt_id: string; state: 'accepted' } {
    return this.request(
      'local-operator',
      requestId,
      {
        kind: 'submit',
        session: id,
        expectedRevision,
        text,
        ...(continuesAttempt ? { continuesAttempt } : {}),
      },
      () => {
        if (controller) this.authorizeControl(id, controller);
        if (this.session(id).revision !== expectedRevision)
          throw new ServiceError('revision_conflict', 'Session revision changed');
        if (text.trimStart().startsWith('/'))
          throw new ServiceError(
            'reserved_command',
            'Pi slash commands cannot be submitted as prompts',
            400,
          );
        if (continuesAttempt) {
          const previous = this.db
            .prepare('SELECT * FROM attempts WHERE id=?')
            .get(continuesAttempt) as unknown as Attempt | undefined;
          if (
            !previous ||
            previous.session_id !== id ||
            previous.state !== 'interrupted' ||
            previous.resolved_by
          )
            throw new ServiceError(
              'invalid_continuation',
              'Attempt is not an unresolved interruption',
            );
        }
        const submission = randomUUID();
        const attempt = randomUUID();
        this.db
          .prepare('INSERT INTO submissions(id,session_id,text,attempt_id) VALUES (?,?,?,?)')
          .run(submission, id, text, attempt);
        this.db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state,continues_attempt_id) VALUES (?,?,?,'accepted',?)",
          )
          .run(attempt, id, submission, continuesAttempt);
        if (continuesAttempt)
          this.db
            .prepare('UPDATE attempts SET resolved_by=? WHERE id=?')
            .run(attempt, continuesAttempt);
        this.event(
          id,
          'submission.accepted',
          {
            submission_id: submission,
            attempt_id: attempt,
            continues_attempt_id: continuesAttempt,
          },
          requestId,
        );
        return { id: submission, attempt_id: attempt, state: 'accepted' };
      },
    );
  }
  controlView(id: string): ControlView {
    this.session(id);
    return (
      (this.db
        .prepare('SELECT client_id,epoch,expires_at FROM controls WHERE session_id=?')
        .get(id) as unknown as ControlView | undefined) ?? {
        client_id: null,
        epoch: 0,
        expires_at: 0,
      }
    );
  }
  authorizeControl(id: string, controller: Controller): void {
    const row = this.db
      .prepare('SELECT client_id,token_hash,expires_at FROM controls WHERE session_id=?')
      .get(id) as { client_id: string; token_hash: string; expires_at: number } | undefined;
    if (
      !row ||
      row.client_id !== controller.client_id ||
      row.token_hash !== textDigest(controller.token) ||
      row.expires_at <= Date.now()
    )
      throw new ServiceError('control_required', 'A current controller lease is required');
  }
  control(
    id: string,
    requestId: string,
    client: string,
    action: 'acquire' | 'renew' | 'release' | 'takeover',
    expectedEpoch: number,
    token?: string,
    ttl = 15000,
  ): ControlLease {
    return this.request(
      'local-operator',
      requestId,
      { kind: 'control', session: id, client, action, expectedEpoch },
      () => {
        const old = this.controlView(id);
        if (old.epoch !== expectedEpoch)
          throw new ServiceError('control_conflict', 'Controller epoch changed');
        if (action === 'renew' || action === 'release')
          this.authorizeControl(id, { client_id: client, token: token ?? '' });
        if (action === 'acquire' && old.expires_at > Date.now())
          throw new ServiceError('control_busy', 'Another terminal controls this session');
        const epoch = action === 'renew' ? old.epoch : old.epoch + 1;
        const nextToken = action === 'renew' ? token! : randomBytes(32).toString('hex');
        const expires = action === 'release' ? 0 : Date.now() + ttl;
        this.db
          .prepare(
            `INSERT INTO controls VALUES (?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        client_id=excluded.client_id,token_hash=excluded.token_hash,epoch=excluded.epoch,expires_at=excluded.expires_at`,
          )
          .run(id, action === 'release' ? null : client, textDigest(nextToken), epoch, expires);
        this.event(
          id,
          `control.${action}`,
          { client_id: action === 'release' ? null : client, epoch, expires_at: expires },
          requestId,
        );
        return {
          client_id: action === 'release' ? null : client,
          epoch,
          token: nextToken,
          expires_at: expires,
        };
      },
    );
  }
  attempt(id: string): Attempt {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as unknown as
      Attempt | undefined;
    if (!row) throw new ServiceError('not_found', 'Attempt not found', 404);
    return row;
  }
  claim(id: string, epoch: number): { attempt: Attempt; submission: Submission } | null {
    return this.transaction(() => {
      if (this.assertEpoch(id, epoch).state !== 'ready') return null;
      if (
        this.db
          .prepare(
            "SELECT 1 FROM attempts WHERE session_id=? AND (state IN ('dispatching','running') OR (state='interrupted' AND resolved_by IS NULL))",
          )
          .get(id)
      )
        return null;
      const next = this.db
        .prepare(
          "SELECT * FROM attempts WHERE session_id=? AND state='accepted' ORDER BY (continues_attempt_id IS NULL),rowid LIMIT 1",
        )
        .get(id) as unknown as Attempt | undefined;
      if (!next) return null;
      this.db
        .prepare("UPDATE attempts SET state='dispatching',worker_epoch=? WHERE id=?")
        .run(epoch, next.id);
      this.db
        .prepare("UPDATE submissions SET state='dispatching' WHERE id=?")
        .run(next.submission_id);
      this.event(id, 'attempt.dispatching', {
        attempt_id: next.id,
        submission_id: next.submission_id,
        epoch,
      });
      return {
        attempt: this.attempt(next.id),
        submission: this.db
          .prepare('SELECT * FROM submissions WHERE id=?')
          .get(next.submission_id) as unknown as Submission,
      };
    });
  }
  running(id: string): void {
    this.transaction(() => {
      const attempt = this.attempt(id);
      if (attempt.state !== 'dispatching') return;
      this.db.prepare("UPDATE attempts SET state='running' WHERE id=?").run(id);
      this.db
        .prepare("UPDATE submissions SET state='running' WHERE id=?")
        .run(attempt.submission_id);
      this.event(attempt.session_id, 'attempt.running', {
        attempt_id: id,
        submission_id: attempt.submission_id,
      });
    });
  }
  finish(
    id: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: string | null,
    error: string | null,
    transcript?: { epoch: number; entries: { id: string }[]; leaf: string | null },
  ): void {
    this.transaction(() => {
      const attempt = this.attempt(id);
      if (!['dispatching', 'running'].includes(attempt.state)) return;
      if (transcript)
        this.appendEntries(
          attempt.session_id,
          transcript.epoch,
          transcript.entries,
          transcript.leaf,
        );
      this.db
        .prepare('UPDATE attempts SET state=?,result=?,error=? WHERE id=?')
        .run(state, result, error, id);
      this.db
        .prepare('UPDATE submissions SET state=? WHERE id=?')
        .run(state, attempt.submission_id);
      this.event(attempt.session_id, `attempt.${state}`, {
        attempt_id: id,
        submission_id: attempt.submission_id,
        text: result?.slice(0, 65536) ?? null,
        truncated: (result?.length ?? 0) > 65536,
        error,
      });
    });
  }
  recoverWork(): void {
    const active = this.db
      .prepare("SELECT id FROM attempts WHERE state IN ('dispatching','running')")
      .all() as { id: string }[];
    for (const attempt of active)
      this.finish(
        attempt.id,
        'interrupted',
        null,
        'Service stopped before the attempt outcome committed; it will not be replayed',
      );
    this.transaction(() => {
      for (const row of this.db
        .prepare('SELECT session_id FROM controls WHERE expires_at>0')
        .all() as { session_id: string }[]) {
        this.db
          .prepare(
            'UPDATE controls SET client_id=NULL,token_hash=NULL,expires_at=0,epoch=epoch+1 WHERE session_id=?',
          )
          .run(row.session_id);
        this.event(row.session_id, 'control.revoked', { reason: 'service restart' });
      }
    });
  }
  snapshot(id: string): SessionSnapshot {
    const session = this.session(id);
    const attempts = this.db
      .prepare(
        "SELECT * FROM attempts WHERE session_id=? ORDER BY (state='interrupted' AND resolved_by IS NULL) DESC,rowid DESC LIMIT 100",
      )
      .all(id) as unknown as Attempt[];
    const submissions = this.db
      .prepare('SELECT * FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 100')
      .all(id) as unknown as Submission[];
    let resultBudget = 65536;
    let inputBudget = 65536;
    let errorBudget = 65536;
    const boundedAttempts = attempts.map((attempt) => {
      const cap = Math.min(resultBudget, 8192);
      const result = attempt.result?.slice(0, cap) ?? null;
      resultBudget -= result?.length ?? 0;
      const error = attempt.error?.slice(0, Math.min(4096, errorBudget)) ?? null;
      errorBudget -= error?.length ?? 0;
      return { ...attempt, result, error, result_truncated: (attempt.result?.length ?? 0) > cap };
    });
    const boundedSubmissions = submissions.map((submission) => {
      const cap = Math.min(inputBudget, 8192);
      inputBudget -= Math.min(submission.text.length, cap);
      return {
        ...submission,
        text: submission.text.slice(0, cap),
        text_truncated: submission.text.length > cap,
      };
    });
    let cursor = session.pi_leaf;
    const seen = new Set<string>();
    const lookup = this.db.prepare(
      'SELECT payload FROM pi_entries WHERE session_id=? AND entry_id=?',
    );
    let remaining = 256 * 1024;
    const messages: SessionSnapshot['messages'] = [];
    while (
      cursor &&
      !seen.has(cursor) &&
      seen.size < 10000 &&
      remaining > 0 &&
      messages.length < 100
    ) {
      seen.add(cursor);
      const row = lookup.get(id, cursor) as { payload: string } | undefined;
      if (!row) break;
      const entry = JSON.parse(row.payload);
      cursor = entry.parentId ?? null;
      const message = entry.message;
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .filter((part: { type: string }) => part.type === 'text')
              .map((part: { text: string }) => part.text)
              .join('');
      if (!text) continue;
      const cap = Math.min(65536, remaining);
      if (cap <= 0 || messages.length >= 100) break;
      messages.push({
        entry_id: entry.id,
        role: message.role,
        text: text.slice(0, cap),
        truncated: text.length > cap,
      });
      remaining -= Math.min(text.length, cap);
    }
    return {
      ...session,
      control: this.controlView(id),
      attempts: boundedAttempts,
      submissions: boundedSubmissions,
      messages: messages.reverse(),
      history_truncated: cursor !== null,
    };
  }
  importEntries(id: string, epoch: number, entries: { id: string }[], leaf: string | null): void {
    this.transaction(() => this.appendEntries(id, epoch, entries, leaf));
  }
  private appendEntries(
    id: string,
    epoch: number,
    entries: { id: string }[],
    leaf: string | null,
  ): void {
    this.assertEpoch(id, epoch);
    for (const entry of entries)
      this.db
        .prepare('INSERT OR IGNORE INTO pi_entries VALUES (?,?,?)')
        .run(id, entry.id, JSON.stringify(entry));
    this.db
      .prepare('UPDATE sessions SET pi_cursor=COALESCE(?,pi_cursor),pi_leaf=? WHERE id=?')
      .run(entries.at(-1)?.id ?? null, leaf, id);
    this.event(id, 'transcript.synced', { entries: entries.length, leaf });
  }
  close(): void {
    this.db.close();
  }
}
