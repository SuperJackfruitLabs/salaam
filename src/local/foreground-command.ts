// A foreground local command: spawned gated, released only once its process is durably owned,
// bounded in time and output, watched by its guard, and settled exactly once with what it did.
import { spawn } from 'node:child_process';
import { processIdentity } from '../core/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { Store } from '../store/index.js';
import type { BrokerRelay } from './command-network.js';
import {
  commandEnv,
  isSandboxed,
  START_GATE,
  type LocalCall,
  type LocalSandbox,
} from './command-launch.js';
import { killToolGroup, type ToolIdentity } from './tool-identity.js';

/** Most bytes of output a foreground command may produce; past it the command is stopped. */
const OUTPUT_LIMIT = 65536;
/** How long a killed command's close may take before its outcome is declared unknown. */
const REAP_MS = 1500;
/** How often a running command re-checks that it is still admitted. */
const GUARD_MS = 100;

/** What a foreground command needs from the desk controller that runs it. */
export interface CommandHost {
  readonly store: Store;
  readonly managed: ManagedWork;
  readonly tools: ToolIdentity;
  guard(c: LocalCall): void;
  change(c: LocalCall, state: string, result: unknown): void;
  argv(
    root: string,
    script: string,
    tmp: string | undefined,
    relay: BrokerRelay | null,
    sb: LocalSandbox,
    listen: boolean,
  ): string[];
  /** The command's job is over. */
  forget(id: string): void;
}

export function runCommand(
  host: CommandHost,
  c: LocalCall,
  command: string,
  timeout: number,
  tmp: string | undefined,
  relay: BrokerRelay | null,
  setStop: (stop: () => void) => void,
  relayFailed: boolean,
  sb: LocalSandbox,
): Promise<void> {
  let stop = () => {};
  return new Promise<void>((resolve) => {
    let output = '',
      bytes = 0,
      reason: string | null = null,
      finished = false;
    // Deliberately do not inherit the daemon's provider credentials or service tokens (commandEnv).
    // Hold the shell before any user instruction until its identity is durably owned (START_GATE).
    const tools = host.tools.mode === 'tools-user';
    const script = START_GATE + command;
    // As the tools user, setsid makes the shell its own group leader so it can be killed by group.
    const argv = host.argv(c.root, script, tmp, relay, sb, JSON.parse(c.args).listen === true);
    let toolGroup: number | null = null,
      marker = tools ? '' : null,
      spawned = false;
    // Release the gate only once the process is owned and, as the tools user, its group is
    // known: otherwise a kill before the marker could miss a command already running.
    const release = () => {
      if (spawned && (!tools || toolGroup) && !reason && !finished) child.stdin.end('start\n');
    };
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: c.root,
      detached: true,
      env: commandEnv(c.root, sb, relay),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let reap: NodeJS.Timeout | undefined;
    const kill = () => {
      if (toolGroup) killToolGroup(host.tools, toolGroup);
      if (tools) child.stdin.destroy();
      if (child.pid)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* close event or recovery retains uncertainty */
        }
      if (!finished && !reap)
        reap = setTimeout(() => {
          if (toolGroup) killToolGroup(host.tools, toolGroup);
          // A busy event loop runs timers before pending I/O: let an already delivered close
          // settle the outcome before declaring it unknown.
          setImmediate(() => {
            if (finished) return;
            reason = 'outcome_unknown';
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
            finish(null);
          });
        }, REAP_MS);
    };
    stop = () => {
      reason ??= 'cancelled';
      kill();
    };
    setStop(stop);
    const deadline = setTimeout(() => {
      reason = 'timed_out';
      kill();
    }, timeout);
    const guard = setInterval(() => {
      try {
        host.guard(c);
      } catch {
        stop();
      }
    }, GUARD_MS);
    const collect = (chunk: Buffer) => {
      const left = Math.max(0, OUTPUT_LIMIT - bytes);
      bytes += chunk.length;
      output += chunk.subarray(0, left).toString('utf8');
      if (bytes > OUTPUT_LIMIT) {
        reason = 'output_limited';
        kill();
      }
    };
    child.stdin.on('error', () => {
      reason ??= 'outcome_unknown';
      kill();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (marker === null) return collect(chunk);
      marker += chunk.toString('latin1');
      const end = marker.indexOf('\n');
      if (end < 0) {
        if (marker.length > 64) {
          reason = 'outcome_unknown';
          kill();
        }
        return;
      }
      const found = /^salaam-tool-pgid:(\d+)$/.exec(marker.slice(0, end));
      const rest = Buffer.from(marker.slice(end + 1), 'latin1');
      marker = null;
      if (!found) {
        reason = 'outcome_unknown';
        kill();
        return;
      }
      toolGroup = Number(found[1]);
      try {
        host.store.transaction(() => host.change(c, 'running', { tool_pgid: toolGroup }));
      } catch {
        reason = 'outcome_unknown';
        kill();
      }
      if (rest.length) collect(rest);
      release();
    });
    child.stderr.on('data', collect);
    child.once('spawn', () => {
      try {
        const identity = processIdentity(child.pid!);
        if (!identity) throw Error('No process identity');
        host.store.transaction(() =>
          host.store.db
            .prepare('UPDATE local_calls SET pid=?,identity=? WHERE id=?')
            .run(child.pid!, identity, c.id),
        );
        try {
          host.guard(c);
        } catch {
          stop();
          return;
        }
        spawned = true;
        release();
      } catch {
        reason = 'outcome_unknown';
        kill();
      }
    });
    const finish = (code: number | null, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (reap) clearTimeout(reap);
      clearInterval(guard);
      kill();
      host.forget(c.id);
      const state = reason ?? (error ? 'failed' : code === 0 ? 'succeeded' : 'failed');
      const network = relay
        ? relay.summary()
        : relayFailed
          ? { broker: 'unavailable' as const, connections: [] }
          : null;
      void relay?.close();
      // What the broker refused, in its own words, so the reason reaches the card.
      const refusals = (network?.connections ?? [])
        .filter((n) => n.refused && n.reason)
        .map((n) => `[network] refused ${n.target}: ${n.reason}`)
        .join('\n');
      const result = {
        exit_code: code,
        output: refusals
          ? output + (output.endsWith('\n') || !output ? '' : '\n') + refusals + '\n'
          : output,
        state,
        error: error ? 'Command could not start' : null,
        isolation:
          (tools ? 'tools-user-' : 'local-user-') +
          (isSandboxed(sb) ? sb.kind + '-' + sb.level : 'no-os-sandbox'),
        sandbox: isSandboxed(sb) ? sb.kind : 'none',
        tool_uid: host.tools.uid,
        ...(network ? { network } : {}),
      };
      host.store.transaction(() => {
        host.change(c, state, result);
        if (state === 'outcome_unknown') host.managed.workspaceUnknownInTransaction(c.operation_id);
        else
          host.managed.localExecutionResultInTransaction(
            c.operation_id,
            state === 'succeeded',
            result,
          );
      });
      resolve();
    };
    child.once('error', (e) => finish(null, e));
    child.once('close', (code) => finish(code));
  });
}
