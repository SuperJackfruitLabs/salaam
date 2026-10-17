import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ServiceError, object } from './protocol.js';

// The upstream client does not expose process identity/group ownership or the
// extension UI subprotocol. Keep this narrow transport behind the Pi adapter.
export class PiProcess extends EventEmitter {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private pending = new Map<
    string,
    {
      resolve: (x: Record<string, unknown>) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer = Buffer.alloc(0);
  private stderr = '';
  private failed: Error | null = null;
  constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.child.stdout.on('data', (chunk: Buffer) => this.parse(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16384);
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => {
      this.fail(new Error(`Pi exited (${signal ?? code})`));
      this.emit('exit', { code, signal });
    });
  }
  private parse(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const index = this.buffer.indexOf(10);
      if (index < 0) break;
      if (index > 4 * 1024 * 1024) {
        this.fail(new Error('Pi record exceeds 4 MiB'));
        return;
      }
      const bytes = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const record = object(JSON.parse(bytes.toString('utf8').replace(/\r$/, '')));
        if (typeof record.type !== 'string') throw new Error('Missing record type');
        if (record.type === 'response' && typeof record.id === 'string') {
          const pending = this.pending.get(record.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(record.id);
            if (record.success === true) pending.resolve(record);
            else pending.reject(new Error(String(record.error ?? 'Pi command rejected')));
          }
        } else this.emit('record', record);
      } catch (error) {
        this.fail(new Error(`Invalid Pi protocol: ${(error as Error).message}`));
        return;
      }
    }
    if (this.buffer.length > 4 * 1024 * 1024) this.fail(new Error('Pi record exceeds 4 MiB'));
  }
  private fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('fault', error);
  }
  command(
    type: string,
    data: Record<string, unknown> = {},
    timeout = 5000,
  ): Promise<Record<string, unknown>> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.pending.size >= 64)
      return Promise.reject(new ServiceError('backpressure', 'Too many pending Pi commands'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi ${type} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...data, type, id }) + '\n', (error) => {
        if (error) this.fail(error);
      });
    });
  }
  waitFor(type: string, timeout = 10_000): Promise<Record<string, unknown>> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.off('record', record);
        this.off('fault', fault);
      };
      const record = (value: Record<string, unknown>) => {
        if (value.type === type) {
          done();
          resolve(value);
        }
      };
      const fault = (error: Error) => {
        done();
        reject(error);
      };
      const timer =
        timeout > 0
          ? setTimeout(() => {
              done();
              reject(new Error(`Pi ${type} timed out`));
            }, timeout)
          : undefined;
      this.on('record', record);
      this.on('fault', fault);
    });
  }
  diagnostics(): string {
    return this.stderr;
  }
  replyUI(id: string, confirmed: boolean): void {
    if (this.failed) throw this.failed;
    this.child.stdin.write(
      JSON.stringify({ type: 'extension_ui_response', id, confirmed }) + '\n',
      (error) => {
        if (error) this.fail(error);
      },
    );
  }
  async stop(): Promise<void> {
    const pid = this.child.pid;
    if (!pid) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      this.closed.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 500);
      }),
    ]);
    clearTimeout(timer);
    if (!graceful) {
      kill('SIGTERM');
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 500);
        }),
      ]);
      clearTimeout(timer);
    }
    // The process group may still contain children after the Pi leader exits.
    kill('SIGKILL');
    await this.closed;
  }
}
