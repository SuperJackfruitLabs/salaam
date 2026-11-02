import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { resolvedToolkitCallSql } from './toolkit-resolution-sql.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { UsageLedger } from './usage.js';
import { WorkerBoundary } from './worker-boundary.js';
import { ExecutionAuthority } from './execution-authority.js';
import {
  OFFLINE_ROUTE,
  type ProviderRoute,
  canonical,
  verifyReadinessFingerprint,
  type ReadinessFingerprint,
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
  type Operation,
  type Approval,
  type WorkspaceTree,
} from '../core/index.js';
import type { AttemptOutcome } from '../core/index.js';
import { enableStationTaskChecks, migrate } from './schema.js';
import * as sessions from './sessions.js';
import * as control from './control.js';
import * as attempts from './attempts.js';
import * as snapshots from './snapshot.js';

/** The state database: its connection, transactions and event log. The schema, sessions, control
 * leases, attempts and snapshots each live in their own file; this class is their one API. */
export class Store {
  readonly db: DatabaseSync;
  readonly changes = new EventEmitter();
  readonly usage = new UsageLedger(this);
  readonly workerBoundary = new WorkerBoundary(this);
  readonly execution = new ExecutionAuthority(this);
  agentpodAuthorityCheck?: (session: string) => void;
  nativeResourceCheck?: (session: string) => void;
  requireAgentPodAuthority = false;
  reconcileCompactions?: (id: string) => void;
  finishChild?: (attempt: Attempt) => void;
  projectTaskAttempt?: (attempt: Attempt) => void;
  teamSnapshot?: (session: string) => unknown;
  guardTaskSubmission?: (session: string, step?: string) => void;
  cancelChildren?: (attempt: string) => void;
  recordTaskMutation?: (
    session: string,
    mutation: string,
    before: WorkspaceTree,
    after: WorkspaceTree,
  ) => void;
  taskGrantCheck?: (session: string) => void;
  /** Provenance: the OS identity that local tool effects run as. */
  toolExecution?: { mode: string; user: string; uid: number };
  jobGrantCheck?: (session: string) => void;
  taskModelAdmission?: (
    session: string,
    attempt: string | undefined,
    input: number,
    output: number,
  ) => void;
  taskBudgetDenied?: (session: string, error: unknown) => void;
  /** A durable task's own attempts are bounded by the task's request limit, not the attempt default. */
  taskAttemptRequestLimit?: (session: string) => number | undefined;
  taskChildReserve?: (session: string, attempt: string, count: number) => void;
  taskChildFinished?: (attempt: string) => void;
  taskCommandAdmission?: (session: string) => void;
  taskRemainingRuntime?: (session: string) => number;
  private committed: DurableEvent[] | null = null;
  private readonly activity = new Map<string, number>();
  readonly openedAt = Date.now();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(
      `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;`,
    );
    migrate(this.db, () => this.workerBoundary.migrate());
  }
  /** Startup-only migration: verification has task ownership, never a fabricated
   * model attempt. Rebuild with FK checks before commit; rollback retains v29. */
  enableStationTaskChecks(): void {
    enableStationTaskChecks(this.db);
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
    const now = Date.now();
    for (const event of events!) this.activity.set(event.session_id, now);
    for (const event of events!) this.changes.emit('event', event);
    return result!;
  }
  writable(): void {
    this.transaction(() => {
      this.db.prepare('UPDATE sessions SET revision=revision WHERE 0').run();
    });
  }
  request<T>(actor: string, id: string, input: unknown, fn: () => T): T {
    try {
      return this.transaction(() => this.requestInTransaction(actor, id, input, fn));
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'task_budget_exhausted') {
        const session = (error as ServiceError & { session_id?: unknown }).session_id;
        if (typeof session === 'string') this.taskBudgetDenied?.(session, error);
      }
      throw error;
    }
  }
  requestInTransaction<T>(actor: string, id: string, input: unknown, fn: () => T): T {
    if (!this.committed || !this.db.isTransaction)
      throw Error('Request admission requires an active journal transaction');
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
  }
  cachedRequest<T>(actor: string, id: string, input: unknown): T | undefined {
    const prior = this.db
      .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
      .get(actor, id) as { hash: string; response: string } | undefined;
    if (!prior) return undefined;
    if (prior.hash !== digest(input))
      throw new ServiceError(
        'request_conflict',
        'Request ID was already used with different input',
      );
    return JSON.parse(prior.response) as T;
  }
  create(
    cwd: string,
    requestId: string,
    coding = false,
    local?: {
      workspace: true;
      route: ProviderRoute;
      requestedRoute?: ProviderRoute;
      outputCap?: boolean;
      coding?: boolean;
    },
  ): Session {
    return sessions.create(this, cwd, requestId, coding, local);
  }
  localCoding(id: string): boolean {
    return sessions.localCoding(this, id);
  }
  localWorkspace(id: string): boolean {
    return sessions.localWorkspace(this, id);
  }
  localOutputCap(id: string): boolean | undefined {
    return sessions.localOutputCap(this, id);
  }
  session(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as
      (Omit<Session, 'capabilities'> & { capabilities: string }) | undefined;
    if (!row) throw new ServiceError('not_found', 'Session not found', 404);
    return { ...row, capabilities: JSON.parse(row.capabilities) };
  }
  forkLocal(
    id: string,
    request: string,
    expected: number,
    controller: Controller,
    clone: (source: Session, target: string) => string,
    /** A rewind forks from an earlier conversation leaf. */
    at?: { leaf: string | null },
  ): Session {
    return sessions.forkLocal(this, id, request, expected, controller, clone, at);
  }
  sessionName(id: string): string | undefined {
    this.session(id);
    const row = this.db
      .prepare(
        "SELECT json_extract(payload,'$.name') AS name FROM events WHERE session_id=? AND kind='session.named' ORDER BY seq DESC LIMIT 1",
      )
      .get(id) as { name: string } | undefined;
    return row?.name;
  }
  nameSession(id: string, request: string, name: string, controller: Controller): { name: string } {
    if (!name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name))
      throw new ServiceError('invalid_name', 'Use 1–120 printable characters');
    return this.request('local-operator', request, { kind: 'name', id, name }, () => {
      this.authorizeControl(id, controller);
      this.event(id, 'session.named', { name }, request);
      return { name };
    });
  }
  /** Wall-clock time of the last committed event for a session in this process, if any. */
  lastActivity(id: string): number | null {
    return this.activity.get(id) ?? null;
  }
  /** The newest committed event in this process, or the time the store opened. */
  lastActivityAny(): number {
    return Math.max(this.openedAt, ...this.activity.values());
  }
  /** The newest prompt submitted to a session, for the session picker. */
  lastPrompt(id: string): string | null {
    const row = this.db
      .prepare('SELECT text FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
      .get(id) as { text: string } | undefined;
    return row?.text ?? null;
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
  bindRoute(id: string, route: ProviderRoute): void {
    this.transaction(() => {
      const prior = this.db
        .prepare('SELECT route FROM session_routes WHERE session_id=?')
        .get(id) as { route: string } | undefined;
      const expected =
        prior?.route ?? (this.session(id).epoch > 0 ? canonical(OFFLINE_ROUTE) : null);
      if (expected && expected !== canonical(route))
        throw new ServiceError(
          'provider_route_changed',
          'Session provider route differs; restart with its original route or create a new session',
        );
      if (!prior) {
        this.db.prepare('INSERT INTO session_routes VALUES (?,?)').run(id, canonical(route));
        this.event(id, 'provider.bound', { route });
      }
    });
  }
  /**
   * The one sanctioned route change: an operator switching model or thinking level in an
   * interactive session between turns. Recorded as provider.route_changed; the worker restarts on
   * the same Pi transcript with the new route.
   */
  switchRoute(id: string, route: ProviderRoute): { from: ProviderRoute; to: ProviderRoute } {
    return this.transaction(() => {
      const from = this.providerRoute(id);
      if (!from || !this.localWorkspace(id))
        throw new ServiceError(
          'route_switch_unavailable',
          'Only interactive sessions can switch model mid-session',
          409,
        );
      this.db
        .prepare('UPDATE session_routes SET route=? WHERE session_id=?')
        .run(canonical(route), id);
      this.event(id, 'provider.route_changed', { from, to: route });
      return { from, to: route };
    });
  }
  providerRoute(id: string): ProviderRoute | null {
    const row = this.db.prepare('SELECT route FROM session_routes WHERE session_id=?').get(id) as
      { route: string } | undefined;
    return row ? JSON.parse(row.route) : null;
  }
  allocate(id: string, bootId: string): number {
    return this.transaction(() => {
      this.execution.assert(id);
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
    fingerprint?: ReadinessFingerprint,
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
      if (
        fingerprint &&
        (state !== 'ready' || fingerprint.session_id !== id || fingerprint.worker_epoch !== epoch)
      )
        throw Error('Fingerprint must belong to the exact ready worker');
      this.event(id, `worker.${state}`, {
        epoch,
        error,
        capabilities,
        ...(fingerprint ? { fingerprint: verifyReadinessFingerprint(fingerprint) } : {}),
      });
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
        return this.enqueue(id, requestId, text, controller, continuesAttempt);
      },
    );
  }
  /** Only inside a request transaction: acceptance and its task binding commit together. */
  enqueue(
    id: string,
    requestId: string,
    text: string,
    controller?: Controller,
    continuesAttempt: string | null = null,
    taskStep?: string,
  ): { id: string; attempt_id: string; state: 'accepted' } {
    return attempts.enqueue(this, id, requestId, text, controller, continuesAttempt, taskStep);
  }
  controlView(id: string): ControlView {
    return control.controlView(this, id);
  }
  authorizeControl(id: string, controller: Controller): void {
    control.authorizeControl(this, id, controller);
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
    return control.control(this, id, requestId, client, action, expectedEpoch, token, ttl);
  }
  attempt(id: string): Attempt {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(id) as unknown as
      Attempt | undefined;
    if (!row) throw new ServiceError('not_found', 'Attempt not found', 404);
    return {
      ...row,
      outcome: row.outcome ? (JSON.parse(String(row.outcome)) as AttemptOutcome) : null,
    };
  }
  toolMetadata(id: string, call: string): { kind: string; locations: unknown[] } | null {
    this.session(id);
    const row = this.db
      .prepare(
        "SELECT payload FROM events WHERE session_id=? AND kind='tool.started' AND json_extract(payload,'$.tool_call_id')=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id, call);
    if (!row) return null;
    const payload = JSON.parse(String(row.payload));
    return typeof payload.kind === 'string'
      ? { kind: payload.kind, locations: Array.isArray(payload.locations) ? payload.locations : [] }
      : null;
  }
  claim(id: string, epoch: number): { attempt: Attempt; submission: Submission } | null {
    return attempts.claim(this, id, epoch);
  }
  running(id: string): void {
    attempts.running(this, id);
  }
  finish(
    id: string,
    state: 'completed' | 'failed' | 'interrupted' | 'cancelled',
    result: string | null,
    error: string | null,
    transcript?: { epoch: number; entries: { id: string }[]; leaf: string | null },
    outcome?: AttemptOutcome,
  ): void {
    attempts.finish(this, id, state, result, error, transcript, outcome);
  }
  recoverWork(): void {
    attempts.recoverWork(this);
  }
  snapshot(id: string): SessionSnapshot {
    return snapshots.snapshot(this, id);
  }
  cancelled(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM cancellations WHERE attempt_id=?').get(id);
  }
  hasUnknown(id: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM operations WHERE session_id=? AND state='outcome_unknown' UNION ALL SELECT 1 FROM toolkit_calls c WHERE session_id=? AND state='outcome_unknown' AND NOT ${resolvedToolkitCallSql('c')} LIMIT 1`,
      )
      .get(id, id);
  }
  approvals(id: string): Approval[] {
    return snapshots.approvals(this, id);
  }
  operations(id: string): Operation[] {
    return snapshots.operations(this, id);
  }
  importEntries(id: string, epoch: number, entries: { id: string }[], leaf: string | null): void {
    this.transaction(() => attempts.appendEntries(this, id, epoch, entries, leaf));
  }
  close(): void {
    this.db.close();
  }
}
