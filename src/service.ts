import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdirSync, chmodSync, existsSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { acquireStateLock } from './state-lock.js';
import { Artifacts } from './artifacts.js';
import { Supervisor, type SupervisorOptions } from './supervisor.js';
import { integer, object, ServiceError, string } from './protocol.js';
import { readJson } from './transport.js';

export interface ServiceOptions extends Omit<SupervisorOptions, 'stateDir' | 'bridgeSocket'> {
  stateDir: string;
}
export class SalaamService {
  readonly stateDir: string;
  readonly socket: string;
  readonly bridgeSocket: string;
  readonly store: Store;
  readonly artifacts: Artifacts;
  readonly supervisor: Supervisor;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private operator: Server;
  private bridgeServer: Server;
  private release: () => void;
  private stopping = false;
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
        });
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
      void this.handle(req, res, false);
    });
    this.bridgeServer = createServer((req, res) => {
      void this.handle(req, res, true);
    });
    for (const server of [this.operator, this.bridgeServer]) {
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
    }
  }
  static async open(options: ServiceOptions): Promise<SalaamService> {
    const service = new SalaamService(options);
    try {
      await service.supervisor.recover();
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
        const value = this.supervisor.bridge(
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
          sessions: sessions.map((x) => ({
            id: x.id,
            state: x.state,
            error: x.error,
            capabilities: x.capabilities,
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
      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, this.supervisor.inspect(id));
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
          // M2 stores accepted work, but deliberately has no automatic prompt dispatcher (M3).
          const submission = this.store.accept(
            id,
            string(body.request_id, 'request_id', 128),
            integer(body.expected_revision, 'expected_revision'),
            string(body.text, 'text', 256 * 1024),
          );
          this.send(res, 202, submission);
          return;
        }
        if (parts[3] === 'probe' && req.method === 'POST') {
          const body = object(await readJson(req));
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
    const pump = () => {
      scheduled = false;
      if (!active) return;
      try {
        const events = this.store.events(id, cursor);
        for (const event of events) {
          if (
            !res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
          ) {
            res.destroy();
            return;
          }
          cursor = event.seq;
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
    schedule();
    const heartbeat = setInterval(() => {
      if (!res.write(': heartbeat\n\n')) res.destroy();
    }, 15000);
    heartbeat.unref();
    const cleanup = () => {
      active = false;
      clearInterval(heartbeat);
      this.store.changes.off('event', change);
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
    const errors: unknown[] = [];
    try {
      try {
        await this.supervisor.close();
      } catch (error) {
        errors.push(error);
      }
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
