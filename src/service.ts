import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdirSync, chmodSync, existsSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { acquireStateLock } from './state-lock.js';
import { Artifacts } from './artifacts.js';
import { Supervisor, type SupervisorOptions } from './supervisor.js';
import { canonical, integer, object, ServiceError, string } from './protocol.js';
import { readJson } from './transport.js';
import { Dispatcher } from './dispatcher.js';
import { ManagedWork } from './managed.js';
import { ChildWork } from './children.js';
import type { EffectConnector } from './effect-connector.js';

export interface ServiceOptions extends Omit<SupervisorOptions, 'stateDir' | 'bridgeSocket'> {
  stateDir: string;
  effectConnector?: EffectConnector;
  approvalTtlMs?: number;
}
export class SalaamService {
  readonly stateDir: string;
  readonly socket: string;
  readonly bridgeSocket: string;
  readonly store: Store;
  readonly artifacts: Artifacts;
  readonly supervisor: Supervisor;
  readonly dispatcher: Dispatcher;
  readonly managed: ManagedWork;
  readonly children: ChildWork;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private operator: Server;
  private bridgeServer: Server;
  private release: () => void;
  private stopping = false;
  private handlers = new Set<Promise<void>>();
  private constructor(options: ServiceOptions) {
    if (process.platform === 'win32') throw new Error('Windows transport is not implemented');
    this.stateDir = resolve(options.stateDir);
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(this.stateDir);
    this.socket = join(this.stateDir, 'operator.sock');
    this.bridgeSocket = join(this.stateDir, 'bridge.sock');
    if (Buffer.byteLength(this.bridgeSocket) > 100)
      throw new Error('State path is too long for a Unix socket; choose a shorter --state path');
    this.release = acquireStateLock(this.stateDir);
    try {
      this.store = new Store(join(this.stateDir, 'journal.sqlite'));
      try {
        this.artifacts = new Artifacts(join(this.stateDir, 'artifacts'), this.store);
        this.supervisor = new Supervisor(this.store, {
          ...options,
          stateDir: this.stateDir,
          bridgeSocket: this.bridgeSocket,
          effectsEnabled: !!options.effectConnector,
        });
        this.managed = new ManagedWork(this.store, {
          connector: options.effectConnector,
          approvalTtlMs: options.approvalTtlMs,
          assertActive: (id, epoch, attempt) => this.supervisor.assertActive(id, epoch, attempt),
          reply: (id, epoch, request, confirmed) =>
            this.supervisor.replyUI(id, epoch, request, confirmed),
          failed: (id, error) => this.supervisor.failControl(id, error),
        });
        this.supervisor.managed = this.managed;
        this.children = new ChildWork(this.store, this.artifacts, this.supervisor);
        this.supervisor.children = this.children;
        this.dispatcher = new Dispatcher(this.store, this.supervisor);
      } catch (error) {
        this.store.close();
        throw error;
      }
    } catch (error) {
      this.release();
      throw error;
    }
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.operator = createServer((req, res) => {
      this.serve(req, res, false);
    });
    this.bridgeServer = createServer((req, res) => {
      this.serve(req, res, true);
    });
    for (const server of [this.operator, this.bridgeServer]) {
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
    }
  }
  private serve(req: IncomingMessage, res: ServerResponse, bridge: boolean): void {
    const task = this.handle(req, res, bridge)
      .catch(() => res.destroy())
      .then(() => {});
    this.handlers.add(task);
    void task.finally(() => this.handlers.delete(task));
  }
  static async open(options: ServiceOptions): Promise<SalaamService> {
    const service = new SalaamService(options);
    try {
      await service.supervisor.recover();
      service.store.recoverWork();
      service.children.recover();
      service.managed.recover();
      await service.managed.reconcileAll();
      await service.listen(service.bridgeServer, service.bridgeSocket);
      await service.listen(service.operator, service.socket);
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private async listen(server: Server, path: string): Promise<void> {
    // The exclusive state lock is held before removing a stale socket.
    if (existsSync(path)) unlinkSync(path);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        chmodSync(path, 0o600);
        resolve();
      });
    });
  }
  private send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  private async handle(req: IncomingMessage, res: ServerResponse, bridge: boolean): Promise<void> {
    try {
      if (this.stopping) throw new ServiceError('stopping', 'Service is stopping', 503);
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      if (bridge) {
        if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'worker')
          throw new ServiceError('not_found', 'Bridge route not found', 404);
        const authorization = req.headers.authorization;
        const value = await this.supervisor.bridge(
          parts[1]!,
          parts[2]!,
          authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
          object(await readJson(req)),
        );
        this.send(res, 200, value);
        return;
      }
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        const sessions = this.store.sessions().map((x) => this.supervisor.inspect(x.id));
        this.send(res, 200, {
          service: 'healthy',
          provider_route: this.supervisor.route,
          effect_connector: this.managed.options.connector?.id ?? null,
          sessions: sessions.map((x) => ({
            id: x.id,
            state: x.state,
            error: x.error,
            capabilities: x.capabilities,
            pending_approvals: this.store
              .approvals(x.id)
              .filter((approval) => approval.state === 'pending').length,
            unresolved_operations: this.store.hasUnknown(x.id),
          })),
        });
        return;
      }
      if (url.pathname === '/v1/shutdown' && req.method === 'POST') {
        this.send(res, 200, { stopping: true });
        setImmediate(() => {
          void this.close().catch(() => {
            console.error('Salaam stopped with a persistence error');
            process.exitCode = 1;
          });
        });
        return;
      }
      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        this.send(
          res,
          200,
          this.store.sessions().map((x) => this.supervisor.inspect(x.id)),
        );
        return;
      }
      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        const body = object(await readJson(req));
        const cwd = realpathSync(string(body.cwd, 'cwd'));
        if (!statSync(cwd).isDirectory())
          throw new ServiceError('invalid_workspace', 'Workspace must be a directory', 400);
        const session = this.store.create(cwd, string(body.request_id, 'request_id', 128));
        if (this.store.session(session.id).state === 'stopped')
          void this.supervisor.start(session.id).catch(() => {});
        this.send(res, 201, session);
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'approvals') {
        if (parts.length === 2 && req.method === 'GET') {
          const id = url.searchParams.get('session');
          this.managed.expire();
          this.send(res, 200, id ? this.store.approvals(id) : this.managed.pending());
          return;
        }
        if (parts[2] && parts.length === 3 && req.method === 'GET') {
          this.managed.expire();
          this.send(res, 200, this.managed.approval(parts[2]));
          return;
        }
        if (parts[2] && parts[3] === 'decision' && req.method === 'POST') {
          const body = object(await readJson(req));
          const decision = string(body.decision, 'decision');
          if (decision !== 'approve' && decision !== 'deny')
            throw new ServiceError('invalid_field', 'Decision must be approve or deny', 400);
          this.send(
            res,
            200,
            this.managed.decide(
              parts[2],
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              string(body.operation_digest, 'operation_digest', 128),
              decision,
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'operations' && parts[2]) {
        const id = parts[2];
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, this.managed.operation(id));
          return;
        }
        if (parts[3] === 'reconcile' && req.method === 'POST') {
          const body = object(await readJson(req));
          const request = string(body.request_id, 'request_id', 128);
          const input = { kind: 'reconcile-operation', id };
          const saved = this.store.cachedRequest('local-operator', request, input);
          if (saved !== undefined) {
            this.send(res, 200, saved);
            return;
          }
          const result = await this.managed.reconcile(id);
          this.send(
            res,
            200,
            this.store.request('local-operator', request, input, () => result),
          );
          return;
        }
        if (parts[3] === 'resolution' && req.method === 'POST') {
          const body = object(await readJson(req));
          const outcome = string(body.outcome, 'outcome');
          if (outcome !== 'succeeded' && outcome !== 'failed_definite')
            throw new ServiceError('invalid_field', 'Invalid resolution outcome', 400);
          this.send(
            res,
            200,
            this.managed.resolve(
              id,
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              string(body.operation_digest, 'operation_digest', 128),
              outcome,
              string(body.evidence, 'evidence', 4096),
            ),
          );
          return;
        }
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'attempts' &&
        parts[2] &&
        parts[3] === 'cancel' &&
        req.method === 'POST'
      ) {
        const body = object(await readJson(req));
        const attempt = parts[2];
        const receipt = this.managed.cancel(
          attempt,
          string(body.request_id, 'request_id', 128),
          integer(body.expected_revision, 'expected_revision'),
          {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          },
        );
        void this.children
          .cancelOwned(attempt)
          .then(() => this.supervisor.cancelAttempt(attempt))
          .catch((error) =>
            this.supervisor.failControl(this.store.attempt(attempt).session_id, error),
          );
        this.send(res, 202, receipt);
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'children' && parts[2]) {
        const child = this.store.db
          .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
          .get(parts[2]) as { parent_session: string } | undefined;
        if (!child) throw new ServiceError('not_found', 'Child not found', 404);
        if (req.method === 'GET' && parts.length === 3) {
          this.send(res, 200, this.children.inspect(child.parent_session, parts[2]));
          return;
        }
        if (req.method === 'GET' && parts[3] === 'result') {
          const row = this.children.inspect(child.parent_session, parts[2]);
          this.send(
            res,
            200,
            this.children.consume(child.parent_session, row.id, row.result_id ?? ''),
          );
          return;
        }
        if (req.method === 'POST' && parts[3] === 'ack') {
          const body = object(await readJson(req));
          this.send(
            res,
            200,
            this.children.acknowledge(
              child.parent_session,
              parts[2],
              string(body.result_id, 'result_id', 128),
              string(body.request_id, 'request_id', 128),
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];
        if (parts[3] === 'children' && req.method === 'GET') {
          this.store.session(id);
          this.send(res, 200, this.children.list(id));
          return;
        }
        if (parts[3] === 'usage' && req.method === 'GET') {
          this.send(res, 200, this.store.usage.summary(id));
          return;
        }
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, this.supervisor.inspect(id));
          return;
        }
        if (parts[3] === 'snapshot' && req.method === 'GET') {
          this.send(res, 200, { ...this.store.snapshot(id), ...this.supervisor.inspect(id) });
          return;
        }
        if (parts[3] === 'control' && req.method === 'POST') {
          const body = object(await readJson(req));
          const action = string(body.action, 'action');
          if (!['acquire', 'renew', 'release', 'takeover'].includes(action))
            throw new ServiceError('invalid_field', 'Invalid control action', 400);
          this.send(
            res,
            200,
            this.store.control(
              id,
              string(body.request_id, 'request_id', 128),
              string(body.client_id, 'client_id', 128),
              action as 'acquire' | 'renew' | 'release' | 'takeover',
              integer(body.expected_epoch, 'expected_epoch'),
              body.token === undefined ? undefined : string(body.token, 'token', 128),
            ),
          );
          return;
        }
        if (parts[3] === 'resume' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          const session = this.supervisor.inspect(id);
          if (
            session.provider_route &&
            canonical(session.provider_route) !== canonical(this.supervisor.route)
          )
            throw new ServiceError(
              'provider_route_changed',
              'Restart the service with this session’s original provider route, or create a new session',
            );
          if (session.state !== 'ready' && session.state !== 'starting')
            void this.supervisor.start(id).catch(() => {});
          this.send(res, 202, this.supervisor.inspect(id));
          return;
        }
        if (parts[3] === 'events' && req.method === 'GET') {
          const raw = url.searchParams.get('after') ?? '0';
          if (!/^\d+$/.test(raw))
            throw new ServiceError('invalid_cursor', 'Invalid event cursor', 400);
          const after = integer(Number(raw), 'after');
          if (after > this.store.session(id).seq)
            throw new ServiceError('invalid_cursor', 'Cursor is ahead of session', 400);
          this.events(req, res, id, after);
          return;
        }
        if (parts[3] === 'submissions' && req.method === 'POST') {
          const body = object(await readJson(req));
          const submission = this.store.accept(
            id,
            string(body.request_id, 'request_id', 128),
            integer(body.expected_revision, 'expected_revision'),
            string(body.text, 'text', 256 * 1024),
            {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            body.continues_attempt_id === undefined
              ? null
              : string(body.continues_attempt_id, 'continues_attempt_id', 128),
          );
          this.send(res, 202, submission);
          return;
        }
        if (parts[3] === 'probe' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          if (body.nested !== undefined && typeof body.nested !== 'boolean')
            throw new ServiceError('invalid_field', 'Invalid nested flag', 400);
          this.send(res, 200, await this.supervisor.probe(id, body.nested === true));
          return;
        }
      }
      throw new ServiceError('not_found', 'Route not implemented', 404);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const value =
        error instanceof ServiceError
          ? error
          : new ServiceError('internal_error', 'Service operation failed', 500);
      this.send(res, value.status, { code: value.code, error: value.message });
    }
  }
  private events(req: IncomingMessage, res: ServerResponse, id: string, after: number): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    let cursor = after;
    let active = true;
    let scheduled = false;
    let blocked = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const write = (text: string) => {
      if (!res.write(text)) {
        blocked = true;
        drainTimer = setTimeout(() => res.destroy(), 10000);
        res.once('drain', () => {
          clearTimeout(drainTimer);
          blocked = false;
          schedule();
        });
      }
    };
    const pump = () => {
      scheduled = false;
      if (!active || blocked) return;
      try {
        const events = this.store.events(id, cursor);
        for (const event of events) {
          write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
          if (blocked) return;
        }
        if (events.length === 256) schedule();
      } catch {
        res.destroy();
      }
    };
    const schedule = () => {
      if (!scheduled && active) {
        scheduled = true;
        setImmediate(pump);
      }
    };
    const change = (event: { session_id: string }) => {
      if (event.session_id === id) schedule();
    };
    this.store.changes.on('event', change);
    const preview = (value: { session_id: string }) => {
      if (value.session_id === id && !blocked && active)
        write(`event: preview\ndata: ${JSON.stringify(value)}\n\n`);
    };
    this.supervisor.on('preview', preview);
    schedule();
    const heartbeat = setInterval(() => {
      if (!blocked) write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();
    const cleanup = () => {
      active = false;
      clearInterval(heartbeat);
      clearTimeout(drainTimer);
      this.store.changes.off('event', change);
      this.supervisor.off('preview', preview);
    };
    res.on('close', cleanup);
    req.on('error', cleanup);
  }
  async close(): Promise<void> {
    if (this.stopping) {
      await this.closed;
      return;
    }
    this.stopping = true;
    this.dispatcher.pause();
    this.managed.pause();
    this.children.pause();
    const errors: unknown[] = [];
    try {
      try {
        await this.children.close();
        await this.supervisor.close();
      } catch (error) {
        errors.push(error);
      }
      await this.dispatcher.drain();
      await this.managed.close();
      await Promise.all(
        [this.operator, this.bridgeServer].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
      await Promise.all(this.handlers);
      try {
        this.store.close();
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.release();
      this.resolveClosed();
    }
    if (errors.length)
      throw new AggregateError(errors, 'Service shutdown could not persist all final states');
  }
}
