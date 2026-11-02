import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { canonical, digest, object, ServiceError, processIdentity } from '../core/index.js';
import {
  verifyStdioProcessLaunch,
  type StdioLifecycle,
  type StdioProcessLaunch,
} from '../mcp/index.js';
import { toolkitControl, type ToolkitControl } from './protocol.js';

function failed(): never {
  throw new ServiceError(
    'toolkit_control_unconfirmed',
    'Native Toolkit recovery control is unconfirmed',
  );
}
function sync(check: () => unknown): void {
  const value = check();
  if (value !== undefined) {
    if (value instanceof Promise) void value.catch(() => {});
    failed();
  }
}
function exists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;
    // kill(0) EPERM proves presence, never absence or authority to signal.
    // Keep observing within the stop deadline (including an exiting macOS group).
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return true;
    failed();
  }
}
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** One owned, bounded, credential-free native recovery command. This primitive
 * supplies no cleanup authority: its supervisor must persist launch intent and
 * actual PID/start identity before stdin, and verify its separate owner callback.
 * It never replays a command. A received result is not verified product work. */
export class ToolkitControlProcess {
  readonly launch: Readonly<StdioProcessLaunch>;
  readonly control: ToolkitControl;
  private child?: ChildProcessWithoutNullStreams;
  private identity?: string;
  private started = false;
  private closing?: Promise<void>;
  private faulted = false;
  private confirmed = false;
  private abort?: () => void;
  get stopped(): boolean {
    return this.confirmed;
  }
  constructor(
    launch: StdioProcessLaunch,
    input: unknown,
    private readonly beforeSend: () => void,
    private readonly lifecycle: StdioLifecycle,
  ) {
    this.launch = Object.freeze({
      ...launch,
      args: Object.freeze([...launch.args]),
      env: Object.freeze({ ...launch.env }),
      limits: Object.freeze({ ...launch.limits }),
    });
    this.control = Object.freeze(toolkitControl(input));
    this.verify();
  }
  private verify(): void {
    try {
      const p = this.launch;
      verifyStdioProcessLaunch(p);
      if (
        p.args.length !== 5 ||
        p.args[0] !== 'managed-control-v1' ||
        p.args[1] !== '--manifest' ||
        p.args[3] !== '--sha256' ||
        !/^[a-f0-9]{64}$/.test(p.args[4]!) ||
        Object.keys(p.env).join(',') !== 'HOME' ||
        p.cwd !== p.env.HOME ||
        p.limits.request_bytes > 4096 ||
        p.limits.response_bytes > 2 * 1024 * 1024 ||
        p.limits.stderr_bytes > 4096 ||
        p.limits.timeout_ms > 10000 ||
        Buffer.byteLength(canonical(this.control)) > p.limits.request_bytes
      )
        failed();
    } catch {
      failed();
    }
  }
  private fault(): void {
    if (this.faulted) return;
    this.faulted = true;
    try {
      sync(() => this.lifecycle.failed?.());
    } catch {}
    this.abort?.();
  }
  async run(): Promise<Record<string, unknown>> {
    if (this.started || this.closing) failed();
    this.started = true;
    const deadline = performance.now() + this.launch.limits.timeout_ms;
    let timer: NodeJS.Timeout | undefined;
    try {
      this.verify();
      sync(this.lifecycle.starting);
      if (performance.now() >= deadline) failed();
      const p = this.launch,
        child = spawn(p.command, [...p.args], {
          cwd: p.cwd,
          env: { ...p.env },
          shell: false,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      this.child = child;
      const chunks: Buffer[] = [];
      let bytes = 0,
        stderr = 0;
      const output = await new Promise<Buffer>((resolve, reject) => {
        this.abort = () => reject(new Error('control failed'));
        timer = setTimeout(() => this.fault(), Math.max(1, deadline - performance.now()));
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > p.limits.response_bytes) this.fault();
          else chunks.push(Buffer.from(chunk));
        });
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.length;
          if (stderr > p.limits.stderr_bytes) this.fault();
        });
        for (const stream of [child.stdin, child.stdout, child.stderr])
          stream.on('error', () => this.fault());
        child.once('error', () => this.fault());
        child.once('spawn', () => {
          try {
            if (this.closing || !child.pid) failed();
            this.identity = processIdentity(child.pid) ?? undefined;
            if (!this.identity) failed();
            sync(() => this.lifecycle.spawned(child.pid!));
            this.verify();
            sync(this.beforeSend);
            if (this.closing || this.faulted || performance.now() >= deadline) failed();
            child.stdin.end(canonical(this.control));
          } catch {
            this.fault();
          }
        });
        child.once('close', (code, signal) => {
          if (code !== 0 || signal || this.faulted || this.closing) this.fault();
          else resolve(Buffer.concat(chunks));
        });
      });
      const result = object(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(output)));
      if (
        result.version !== 1 ||
        result.control_digest !== digest(this.control) ||
        typeof result.root_revoked !== 'boolean' ||
        Object.keys(result).some(
          (k) => !['version', 'control_digest', 'root_revoked', 'receipt'].includes(k),
        ) ||
        (this.control.action === 'revoke'
          ? result.root_revoked !== true || 'receipt' in result
          : !('receipt' in result))
      )
        failed();
      if (this.control.action !== 'revoke') {
        const receipt = object(result.receipt);
        if (
          receipt.id !==
            digest(['stk.managed-mcp.v1', this.control.root_digest, this.control.invocation_id]) ||
          receipt.request_digest !== this.control.request_digest ||
          ![
            'prepared',
            'awaiting_decision',
            'approved',
            'denied',
            'claiming',
            'dispatching',
            'returned',
            'outcome_unknown',
            'outcome_acknowledged',
            'cancelled',
          ].includes(String(receipt.state))
        )
          failed();
      }
      if (performance.now() >= deadline || this.faulted) failed();
      clearTimeout(timer);
      // Receipt state/effect interpretation belongs to the durable controller.
      // Never hand a result to it until the actual local process group is gone.
      await this.close();
      return result;
    } catch {
      this.fault();
      await this.close();
      failed();
    } finally {
      clearTimeout(timer);
      this.abort = undefined;
    }
  }
  close(): Promise<void> {
    return (this.closing ??= this.stop());
  }
  private async stop(): Promise<void> {
    this.abort?.();
    const child = this.child,
      pid = child?.pid;
    try {
      // A bounded command can exit between the last stdout chunk and our stop
      // observer. Give that actual group a short chance to disappear; never
      // substitute a stale leader identity for permission to signal a group.
      if (pid) for (let i = 0; i < 5 && exists(pid); i++) await wait(20);
      if (pid && exists(pid)) {
        const signal = (s: NodeJS.Signals) => {
          if (!exists(pid)) return;
          // A vanished/reused leader cannot authorize signalling a live group.
          if (!this.identity || processIdentity(pid) !== this.identity) failed();
          try {
            process.kill(-pid, s);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH') failed();
          }
        };
        signal('SIGTERM');
        for (let i = 0; i < 10 && exists(pid); i++) await wait(20);
        if (exists(pid)) signal('SIGKILL');
        for (let i = 0; i < 50 && exists(pid); i++) await wait(20);
        if (exists(pid)) failed();
      }
      this.confirmed = true;
    } finally {
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
    }
  }
}
