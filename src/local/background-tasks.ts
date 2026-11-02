// Background commands: an approved command that keeps running as a task of the session, not of
// the turn, until it exits, is stopped, outlives its lifetime or the session ends. Its operation
// settles once the process is owned; the last of its output is kept for the model to read.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { processStart, ServiceError } from '../core/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { Store } from '../store/index.js';
import { BrokerRelay, type CommandNetworkSummary } from './command-network.js';
import {
  brokerNetwork,
  commandEnv,
  isSandboxed,
  privateTmp,
  START_GATE,
  type LocalCall,
  type LocalSandbox,
} from './command-launch.js';
import type { ToolIdentity } from './tool-identity.js';

/** Bytes of a task's output kept for reading. */
export const TASK_TAIL = 65536;
/** Background commands one session may run at once. */
const TASK_LIMIT = 4;
/** The longest a background command runs before it is stopped. */
export const BACKGROUND_LIFETIME = 2 * 3600 * 1000;
/** Ended tasks whose output is still kept. */
const KEPT_TASKS = 32;
/** How often a task checks that its session still owns it. */
const WATCH_MS = 1000;

type TaskState = 'running' | 'exited' | 'stopped' | 'timed_out' | 'lost';
interface TaskRow {
  id: string;
  session_id: string;
  call_id: string;
  command: string;
  state: TaskState;
  pid: number | null;
  identity: string | null;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
}
interface BackgroundTask {
  id: string;
  session: string;
  done: Promise<void>;
  output: () => {
    output: string;
    bytes: number;
    truncated: boolean;
    network?: CommandNetworkSummary;
  };
  stop: (why: TaskState) => void;
}

/** What background tasks need from the desk controller that owns them. */
export interface TaskHost {
  readonly store: Store;
  readonly managed: ManagedWork;
  tools(): ToolIdentity;
  closed(): boolean;
  interactive(session: string): boolean;
  change(c: LocalCall, state: string, result: unknown): void;
  argv(
    root: string,
    script: string,
    tmp: string | undefined,
    relay: BrokerRelay | null,
    sb: LocalSandbox,
    listen: boolean,
  ): string[];
}

export class BackgroundTasks {
  /** Tasks this controller owns; they belong to the session, not to a turn. */
  private live = new Map<string, BackgroundTask>();
  /** Output of recently ended tasks, so the model can read why one stopped. */
  private kept = new Map<string, ReturnType<BackgroundTask['output']>>();
  constructor(private readonly host: TaskHost) {
    const { store } = host;
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS local_tasks(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,call_id TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER,identity TEXT,exit_code INTEGER,started_at TEXT NOT NULL,ended_at TEXT)',
    );
    // A background task never outlives its controller: kill what a restart left and say so.
    for (const raw of store.db.prepare("SELECT * FROM local_tasks WHERE state='running'").all()) {
      const t = raw as unknown as TaskRow;
      if (t.pid && t.identity && processStart(t.pid) === t.identity)
        try {
          process.kill(-t.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      this.endTask(t, 'lost', null);
    }
  }
  assertAllowed(session: string): void {
    if (!this.host.interactive(session))
      throw new ServiceError(
        'background_denied',
        'Background commands are only for an interactive local coding session',
      );
    if (this.host.tools().mode === 'tools-user')
      throw new ServiceError(
        'background_denied',
        'Background commands do not yet run as a separate tools user',
      );
    if ([...this.live.values()].filter((t) => t.session === session).length >= TASK_LIMIT)
      throw new ServiceError(
        'background_limit',
        `A session runs at most ${TASK_LIMIT} background commands; stop one first`,
      );
  }
  /** Launch an approved background command. Its operation settles once the process is owned;
   * the process then lives as a session task until it exits, is stopped, or the session ends. */
  start(c: LocalCall, command: string, sb: LocalSandbox): void {
    const settle = (ok: boolean, result: Record<string, unknown>) =>
      this.host.store.transaction(() => {
        this.host.change(c, ok ? 'succeeded' : 'failed', result);
        this.host.managed.localExecutionResultInTransaction(c.operation_id, ok, result);
      });
    try {
      this.assertAllowed(c.session_id);
    } catch (error) {
      settle(false, { error: (error as Error).message, background: true });
      return;
    }
    // Broker network, as for a foreground command, through a relay that lives as long as the task.
    const broker = brokerNetwork(sb);
    if (!broker) return this.launch(c, command, sb, settle, null, false);
    BrokerRelay.start(broker.socket, sb.kind === 'seatbelt' ? 'tcp' : 'unix').then(
      (relay) => this.launch(c, command, sb, settle, relay, false),
      () => this.launch(c, command, sb, settle, null, true),
    );
  }
  private launch(
    c: LocalCall,
    command: string,
    sb: LocalSandbox,
    settle: (ok: boolean, result: Record<string, unknown>) => void,
    relay: BrokerRelay | null,
    relayFailed: boolean,
  ): void {
    if (this.host.closed()) {
      void relay?.close();
      settle(false, { error: 'Command could not start', background: true });
      return;
    }
    const id = 'task_' + randomUUID().slice(0, 8);
    const tmp = privateTmp(sb, 'salaam-cmd-');
    const network = (): CommandNetworkSummary | undefined =>
      relay
        ? relay.summary()
        : relayFailed
          ? { broker: 'unavailable', connections: [] }
          : undefined;
    const script = START_GATE + command;
    const argv = this.host.argv(c.root, script, tmp, relay, sb, JSON.parse(c.args).listen === true);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: c.root,
      detached: true,
      env: commandEnv(c.root, sb, relay),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let tail = Buffer.alloc(0),
      bytes = 0,
      ended: TaskState | null = null,
      resolve = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
    };
    const task: BackgroundTask = {
      id,
      session: c.session_id,
      done,
      output: () => {
        const net = network();
        // What the broker refused, in its own words, after the output it explains.
        const refusals = (net?.connections ?? [])
          .filter((n) => n.refused && n.reason)
          .map((n) => `[network] refused ${n.target}: ${n.reason}\n`)
          .join('');
        const text = tail.toString('utf8');
        return {
          output: refusals ? text + (text.endsWith('\n') || !text ? '' : '\n') + refusals : text,
          bytes,
          truncated: bytes > tail.length,
          ...(net ? { network: net } : {}),
        };
      },
      stop: (why) => {
        ended ??= why;
        kill();
      },
    };
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TASK_TAIL) tail = tail.subarray(tail.length - TASK_TAIL);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    const lifetime = setTimeout(() => task.stop('timed_out'), BACKGROUND_LIFETIME);
    // The session, not the turn, owns the task: it ends when local coding or its root goes away.
    const watch = setInterval(() => {
      try {
        if (this.host.closed() || !this.host.store.localCoding(c.session_id)) throw Error('closed');
        if (this.host.store.session(c.session_id).cwd !== c.root) throw Error('moved');
      } catch {
        task.stop('stopped');
      }
    }, WATCH_MS);
    const finish = (code: number | null) => {
      clearTimeout(lifetime);
      clearInterval(watch);
      kill();
      this.live.delete(id);
      this.kept.set(id, task.output());
      if (this.kept.size > KEPT_TASKS) this.kept.delete(this.kept.keys().next().value!);
      void relay?.close();
      if (tmp) rmSync(tmp, { recursive: true, force: true });
      const row = this.host.store.db.prepare('SELECT * FROM local_tasks WHERE id=?').get(id) as
        TaskRow | undefined;
      if (row) this.endTask(row, ended ?? 'exited', code);
      else settle(false, { error: 'Command could not start', background: true });
      resolve();
    };
    child.once('error', () => finish(null));
    child.once('close', (code) => finish(code));
    child.once('spawn', () => {
      try {
        // The start time, not processIdentity: the gated shell execs into the command.
        const identity = processStart(child.pid!);
        if (!identity) throw Error('No process identity');
        this.host.store.transaction(() =>
          this.host.store.db
            .prepare(
              "INSERT INTO local_tasks(id,session_id,call_id,command,state,pid,identity,started_at) VALUES (?,?,?,?,'running',?,?,?)",
            )
            .run(id, c.session_id, c.id, command, child.pid!, identity, new Date().toISOString()),
        );
        this.live.set(id, task);
        settle(true, {
          background: true,
          task_id: id,
          state: 'running',
          isolation: 'local-user-' + (isSandboxed(sb) ? sb.kind + '-' + sb.level : 'no-os-sandbox'),
          sandbox: isSandboxed(sb) ? sb.kind : 'none',
          ...(relay
            ? { network: 'through the broker allowlist' }
            : relayFailed
              ? { network: 'none: the broker is unavailable' }
              : {}),
          note: 'Read its output with salaam_tasks; it keeps running after this turn.',
        });
        child.stdin.end('start\n');
      } catch {
        ended = 'lost';
        kill();
      }
    });
  }
  private endTask(t: TaskRow, state: TaskState, code: number | null): void {
    this.host.store.transaction(() => {
      this.host.store.db
        .prepare(
          "UPDATE local_tasks SET state=?,exit_code=?,ended_at=? WHERE id=? AND state='running'",
        )
        .run(state, code, new Date().toISOString(), t.id);
      this.host.store.event(t.session_id, 'local.task_finished', {
        task_id: t.id,
        command: t.command.slice(0, 200),
        state,
        exit_code: code,
      });
    });
  }
  /** The session's background tasks, newest first. */
  list(session: string) {
    return (
      this.host.store.db
        .prepare(
          'SELECT * FROM local_tasks WHERE session_id=? ORDER BY started_at DESC, rowid DESC',
        )
        .all(session) as unknown as TaskRow[]
    ).map((t) => ({
      id: t.id,
      command: t.command,
      state: t.state,
      exit_code: t.exit_code,
      pid: t.pid,
      started_at: t.started_at,
      ended_at: t.ended_at,
      bytes: this.live.get(t.id)?.output().bytes ?? null,
    }));
  }
  private task(session: string, id: string): TaskRow {
    const row = this.host.store.db
      .prepare('SELECT * FROM local_tasks WHERE id=? AND session_id=?')
      .get(id, session) as TaskRow | undefined;
    if (!row) throw new ServiceError('not_found', 'No such background task in this session', 404);
    return row;
  }
  /** The kept tail of a task's output. Output of a task this controller no longer owns is gone. */
  output(session: string, id: string) {
    const row = this.task(session, id);
    const live = this.live.get(id);
    return {
      task: { id: row.id, state: row.state, exit_code: row.exit_code },
      ...(live?.output() ?? this.kept.get(id) ?? { output: '', bytes: 0, truncated: false }),
    };
  }
  stop(session: string, id: string) {
    this.task(session, id);
    this.live.get(id)?.stop('stopped');
    return { stopping: this.live.has(id) };
  }
  /** Stop every task this controller owns; resolves once all have ended. */
  stopAll(): Promise<void>[] {
    const tasks = [...this.live.values()];
    for (const t of tasks) t.stop('stopped');
    return tasks.map((t) => t.done);
  }
}
