import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { ServiceError } from '../core/index.js';

export type RpcObject = Record<string, unknown>;
export interface HarnessLaunch {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  dialect: 'acp' | 'codex';
}
export const HARNESS_RPC_LIMITS = {
  frame: 1024 * 1024,
  total: 4 * 1024 * 1024,
  pending: 16,
  timeout: 10000,
} as const;
export interface HarnessHandlers {
  request?: (method: string, params: RpcObject) => Promise<unknown>;
  notification?: (method: string, params: RpcObject) => void;
  failed?: (error: Error) => void;
}
/** Bounded stdio framing only. A launch is not a workspace or credential sandbox. */
export class HarnessRpc {
  readonly process: ChildProcessWithoutNullStreams;
  private serial = 0;
  private received = 0;
  private stderr = 0;
  private buffer = '';
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private pending = new Map<
    number,
    { resolve: (value: RpcObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private inbound = new Set<string>();
  private failure?: Error;
  private stopping = false;
  readonly exited: Promise<void>;
  constructor(
    readonly launch: HarnessLaunch,
    readonly handlers: HarnessHandlers = {},
  ) {
    this.process = spawn(launch.executable, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) =>
      this.process.once('close', () => {
        if (!this.stopping) this.fail(new Error('Harness exited before connection closed'));
        resolve();
      }),
    );
    this.process.on('error', (error) => this.fail(error));
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.stderr.on('data', (bytes: Buffer) => {
      this.stderr += bytes.length;
      if (this.stderr > HARNESS_RPC_LIMITS.total)
        this.fail(new Error('Harness stderr exceeded its bound'));
    });
    this.process.stdout.on('data', (bytes: Buffer) => {
      try {
        this.received += bytes.length;
        if (this.received > HARNESS_RPC_LIMITS.total)
          throw new Error('Harness output exceeded its bound');
        this.buffer += this.decoder.decode(bytes, { stream: true });
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > HARNESS_RPC_LIMITS.frame)
            throw new Error('Harness frame exceeded its bound');
          if (!line.trim()) throw new Error('Empty harness frame');
          this.message(JSON.parse(line));
        }
        if (Buffer.byteLength(this.buffer) > HARNESS_RPC_LIMITS.frame)
          throw new Error('Harness frame exceeded its bound');
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.process.stdout.on('end', () => {
      if (
        !this.stopping &&
        (this.buffer.length ||
          (() => {
            try {
              return Boolean(this.decoder.decode());
            } catch {
              return true;
            }
          })())
      )
        this.fail(new Error('Truncated harness frame'));
    });
  }
  private object(value: unknown): RpcObject {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid harness object');
    return value as RpcObject;
  }
  private message(value: unknown): void {
    if (this.failure || this.stopping) return;
    const message = this.object(value);
    if (this.launch.dialect === 'acp' ? message.jsonrpc !== '2.0' : message.jsonrpc !== undefined)
      throw new Error('Harness RPC dialect mismatch');
    if (typeof message.method === 'string') {
      if (
        message.method.length > 192 ||
        Object.hasOwn(message, 'result') ||
        Object.hasOwn(message, 'error')
      )
        throw new Error('Invalid harness request envelope');
      const params = message.params === undefined ? {} : this.object(message.params);
      if (message.id === undefined) {
        this.handlers.notification?.(message.method, params);
        return;
      }
      if (
        (typeof message.id !== 'string' && typeof message.id !== 'number') ||
        (typeof message.id === 'string' && message.id.length > 256) ||
        (typeof message.id === 'number' && !Number.isSafeInteger(message.id))
      )
        throw new Error('Invalid harness request ID');
      const key = JSON.stringify(message.id);
      if (this.inbound.has(key) || this.inbound.size >= HARNESS_RPC_LIMITS.pending)
        throw new Error('Duplicate or excessive harness requests');
      this.inbound.add(key);
      Promise.resolve()
        .then(() => {
          if (!this.handlers.request)
            throw new ServiceError(
              'harness_permission_denied',
              'Harness client authority is unavailable',
            );
          return this.handlers.request(message.method as string, params);
        })
        .then(
          (result) => this.send({ id: message.id, result: result ?? {} }),
          () =>
            this.send({
              id: message.id,
              error: { code: -32000, message: 'Harness request denied' },
            }),
        )
        .catch((error) => this.fail(error))
        .finally(() => this.inbound.delete(key));
      return;
    }
    if (
      !Number.isSafeInteger(message.id) ||
      Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')
    )
      throw new Error('Invalid harness reply');
    const waiter = this.pending.get(message.id as number);
    if (!waiter) throw new Error('Unowned or duplicate harness reply');
    this.pending.delete(message.id as number);
    clearTimeout(waiter.timer);
    if (Object.hasOwn(message, 'error'))
      waiter.reject(new ServiceError('harness_rpc_error', 'Harness rejected the request'));
    else {
      try {
        waiter.resolve(this.object(message.result));
      } catch (error) {
        waiter.reject(error as Error);
        throw error;
      }
    }
  }
  private send(value: RpcObject): void {
    if (this.failure || this.stopping) throw this.failure ?? new Error('Harness connection closed');
    const frame =
      JSON.stringify({ ...(this.launch.dialect === 'acp' ? { jsonrpc: '2.0' } : {}), ...value }) +
      '\n';
    if (Buffer.byteLength(frame) > HARNESS_RPC_LIMITS.frame)
      throw new Error('Outbound harness frame exceeded its bound');
    if (this.process.stdin.writableLength + Buffer.byteLength(frame) > HARNESS_RPC_LIMITS.total)
      throw new Error('Harness input backpressure exceeded its bound');
    this.process.stdin.write(frame);
  }
  request(
    method: string,
    params: RpcObject,
    timeout: number = HARNESS_RPC_LIMITS.timeout,
  ): Promise<RpcObject> {
    if (this.failure || this.stopping)
      return Promise.reject(this.failure ?? new Error('Harness connection closed'));
    if (
      this.pending.size >= HARNESS_RPC_LIMITS.pending ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 300000
    )
      return Promise.reject(new Error('Harness request bound exceeded'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.fail(
            new ServiceError(
              'harness_outcome_unknown',
              'Harness reply deadline reached; the request must not be replayed',
            ),
          ),
        timeout,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }
  notify(method: string, params: RpcObject): void {
    this.send({ method, params });
  }
  private fail(error: Error): void {
    if (this.failure || this.stopping) return;
    this.failure = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.process.kill('SIGKILL');
    // A failed persistence observer must not leave the transport usable or make a timer throw.
    // Pending callers already reject; the committed dispatch intent remains for recovery.
    try {
      this.handlers.failed?.(error);
    } catch {}
  }
  async close(): Promise<void> {
    this.stopping = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Harness connection closed'));
    }
    this.pending.clear();
    this.process.kill('SIGKILL');
    await this.exited;
  }
}
