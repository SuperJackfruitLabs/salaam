import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface StdioLaunch {
  command: string;
  executable_digest: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  protocol_version: '2025-06-18' | '2025-11-25';
  limits: {
    request_bytes: number;
    response_bytes: number;
    stderr_bytes: number;
    timeout_ms: number;
  };
}

const allowedEnvironment = new Set([
  'HOME',
  'TMPDIR',
  'STK_HOME',
  'STK_CONFIG',
  'STK_SOCKET',
  'STK_PASSPHRASE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
const failed = () => new Error('Managed MCP stdio control failed');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw failed();
  }
}

/** Internal transport primitive. A trusted admission controller must select the complete
 * launch/configuration and enforce fresh authority. This class is not an ACP stdio feature,
 * a sandbox, or an authorization grant; no model-facing caller can construct it. */
export class ManagedStdioTransport implements Transport {
  readonly launch: Readonly<StdioLaunch>;
  readonly diagnostic = 'Managed MCP stdio control failed';
  onmessage?: Transport['onmessage'];
  onerror?: Transport['onerror'];
  onclose?: Transport['onclose'];
  private child?: ChildProcessWithoutNullStreams;
  private parentExited?: Promise<void>;
  private closing?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private incoming = 0;
  private stderrBytes = 0;
  private pending?: string | number;
  private responseDeadline?: NodeJS.Timeout;
  private faulted = false;
  private confirmed = false;
  private handedOff = 0;
  get toolCallsSent(): number {
    return this.handedOff;
  }
  get stopped(): boolean {
    return this.confirmed;
  }

  constructor(
    launch: StdioLaunch,
    private readonly beforeToolCall: () => void,
  ) {
    this.launch = Object.freeze({
      ...launch,
      args: Object.freeze([...launch.args]),
      env: Object.freeze({ ...launch.env }),
      limits: Object.freeze({ ...launch.limits }),
    });
    this.verify();
  }
  private verify(): void {
    try {
      const p = this.launch;
      if (
        !['darwin', 'linux'].includes(process.platform) ||
        !['2025-06-18', '2025-11-25'].includes(p.protocol_version) ||
        !/^[a-f0-9]{64}$/.test(p.executable_digest) ||
        !isAbsolute(p.command) ||
        resolve(p.command) !== p.command ||
        realpathSync(p.command) !== p.command ||
        !isAbsolute(p.cwd) ||
        resolve(p.cwd) !== p.cwd ||
        realpathSync(p.cwd) !== p.cwd ||
        p.args.length > 32 ||
        p.args.some((s) => typeof s !== 'string' || s.length > 4096 || s.includes('\0')) ||
        Object.entries(p.env).some(
          ([k, v]) =>
            !allowedEnvironment.has(k) ||
            typeof v !== 'string' ||
            v.length > 16384 ||
            v.includes('\0'),
        ) ||
        !p.env.HOME ||
        !isAbsolute(p.env.HOME) ||
        realpathSync(p.env.HOME) !== p.env.HOME ||
        Object.values(p.limits).some(
          (n) => !Number.isSafeInteger(n) || n < 256 || n > 4 * 1024 * 1024,
        ) ||
        Object.keys(p.limits).sort().join(',') !==
          'request_bytes,response_bytes,stderr_bytes,timeout_ms' ||
        p.limits.timeout_ms > 120000
      )
        throw failed();
      const fd = openSync(
        p.command,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const st = fstatSync(fd);
        if (
          !st.isFile() ||
          st.nlink !== 1 ||
          st.mode & 0o022 ||
          !(st.mode & 0o111) ||
          (st.uid !== 0 && st.uid !== process.getuid?.()) ||
          st.size > 256 * 1024 * 1024 ||
          createHash('sha256').update(readFileSync(fd)).digest('hex') !== p.executable_digest
        )
          throw failed();
        const after = fstatSync(fd);
        if (st.size !== after.size || st.mtimeMs !== after.mtimeMs || after.nlink !== 1)
          throw failed();
      } finally {
        closeSync(fd);
      }
    } catch {
      throw failed();
    }
  }
  async start(): Promise<void> {
    if (this.child || this.closing || this.faulted) throw failed();
    this.verify();
    const p = this.launch;
    const child = spawn(p.command, [...p.args], {
      cwd: p.cwd,
      env: { ...p.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    this.child = child;
    this.parentExited = new Promise((done) => {
      child.once('exit', () => done());
      child.once('error', () => done());
    });
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > p.limits.stderr_bytes) this.fail();
    });
    child.stdout.on('error', () => this.fail());
    child.stderr.on('error', () => this.fail());
    child.stdin.on('error', () => this.fail());
    child.once('error', () => this.fail());
    child.once('exit', () => {
      if (!this.closing) this.fail();
    });
    await new Promise<void>((done, reject) => {
      child.once('spawn', done);
      child.once('error', () => reject(failed()));
    });
  }
  setProtocolVersion(version: string): void {
    if (version !== this.launch.protocol_version) {
      this.fail();
      throw failed();
    }
  }
  private fail(): void {
    if (this.faulted || this.closing) return;
    this.faulted = true;
    this.onerror?.(failed());
    void this.close().catch(() => {});
  }
  private receive(chunk: Buffer): void {
    if (this.closing || this.faulted) return;
    this.incoming += chunk.length;
    if (this.incoming > this.launch.limits.response_bytes) {
      this.fail();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const index = this.buffer.indexOf(10);
        if (index < 0) break;
        const line = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + 1);
        const message = JSONRPCMessageSchema.parse(
          JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(line)),
        );
        // No peer-initiated requests, unsolicited replies or duplicate results.
        if ('id' in message) {
          if ('method' in message || message.id !== this.pending) throw failed();
          this.pending = undefined;
          clearTimeout(this.responseDeadline);
        }
        this.onmessage?.(message);
        if (this.closing || this.faulted) return;
      }
    } catch {
      this.fail();
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closing || this.faulted || !this.child) throw failed();
    const bytes = Buffer.from(JSON.stringify(message) + '\n');
    if (bytes.length > this.launch.limits.request_bytes) throw failed();
    if ('method' in message && 'id' in message) {
      if (this.pending !== undefined) throw failed();
      if (message.method === 'tools/call') {
        // The durable owner commits its one-time dispatch marker here, synchronously.
        try {
          this.beforeToolCall();
        } catch {
          throw failed();
        }
        this.handedOff++;
      }
      this.pending = message.id;
      this.incoming = 0;
      this.responseDeadline = setTimeout(() => this.fail(), this.launch.limits.timeout_ms);
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((done, reject) =>
          this.child!.stdin.write(bytes, (error) => (error ? reject(failed()) : done())),
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(failed()), this.launch.limits.timeout_ms);
        }),
      ]);
    } catch {
      this.fail();
      throw failed();
    } finally {
      clearTimeout(timer);
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.stop());
  }
  private async stop(): Promise<void> {
    clearTimeout(this.responseDeadline);
    const child = this.child,
      pid = child?.pid;
    try {
      child?.stdin.end();
      if (pid) {
        const signal = (s: NodeJS.Signals) => {
          try {
            process.kill(-pid, s);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw failed();
          }
        };
        await Promise.race([this.parentExited, delay(150)]);
        signal('SIGTERM');
        await Promise.race([this.parentExited, delay(350)]);
        signal('SIGKILL');
        await Promise.race([this.parentExited, delay(500)]);
        const deadline = Date.now() + 1000;
        while (groupExists(pid) && Date.now() < deadline) await delay(20);
        if (groupExists(pid) || (child.exitCode === null && child.signalCode === null))
          throw failed();
      }
      this.confirmed = true;
    } finally {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      this.buffer = Buffer.alloc(0);
      this.onclose?.();
    }
  }
}
