// The protected station file helper: one short-lived process per request, owned by its station
// call (pid and identity journaled before anything is sent), its exit observed and recorded, and
// a stop that proves the process gone or leaves the call fenced as unconfirmed.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { processIdentity, canonical, object, ServiceError } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { StationCall } from '../runtime/index.js';
import { stationUnavailable, type StationConfig } from './station-config.js';
import { stationFileResult } from './station-files.js';

/** How long one helper request may run before it is killed. */
const HELPER_TIMEOUT_MS = 30000;
/** The most output a helper may write; more is a failure. */
const HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;
/** How often, and how many times, a stop checks that a killed helper has exited. */
const STOP_POLL_MS = 20;
const STOP_POLLS = 100;

export class StationFilesDefiniteFailure extends ServiceError {
  constructor(code: string) {
    super(code, 'Protected file primitive refused before mutation');
  }
}
/** A helper refusal that provably changed nothing, as the code recorded for it, or null. The
 * helper writes station_request_invalid as exactly {version, ok, code} and only while decoding,
 * before it executes anything; any other shape (an effect_state, extra fields) is not definite. */
export function definiteHelperRefusal(
  exitCode: number | null,
  transportFailed: boolean,
  result: Record<string, unknown>,
): string | null {
  if (transportFailed || exitCode !== 1 || result.version !== 1 || result.ok !== false) return null;
  if (result.code === 'station_files_unavailable' && result.effect_state === 'not_started')
    return 'station_files_changed';
  if (
    result.code === 'station_request_invalid' &&
    Object.keys(result).sort().join(',') === 'code,ok,version'
  )
    return 'station_request_invalid';
  return null;
}

/** What a helper run needs from the station: the journal, the configured helper and workspace,
 * the abort controllers of running helpers, and the call fence. */
export interface StationHelperDeps {
  readonly store: Store;
  readonly config: StationConfig;
  readonly files: Map<string, AbortController>;
  get(id: string): StationCall;
  guard(c: StationCall): void;
}

/** One helper process's state, shared by its event handlers. */
interface HelperRun {
  readonly controller: AbortController;
  readonly chunks: Buffer[];
  bytes: number;
  failed: boolean;
  spawned: boolean;
  settled: boolean;
}

/** Run one helper request. With a call id the process is owned by that call: its pid and identity
 * are journaled, the call is fenced before the request is sent, and its exit is recorded. */
export function runStationHelper(
  deps: StationHelperDeps,
  request: Record<string, unknown>,
  id?: string,
  verificationGuard?: () => void,
): Promise<Record<string, any>> {
  const controller = new AbortController();
  if (id) deps.files.set(id, controller);
  if (id)
    deps.store.transaction(() =>
      deps.store.db.prepare("UPDATE station_calls SET helper_state='launching' WHERE id=?").run(id),
    );
  return new Promise((accept, reject) => {
    const child = spawn(deps.config.files.path, ['salaam-station-files-v1'], {
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: controller.signal,
      killSignal: 'SIGKILL',
    });
    const run: HelperRun = {
      controller,
      chunks: [],
      bytes: 0,
      failed: false,
      spawned: false,
      settled: false,
    };
    const timeout = setTimeout(() => {
      run.failed = true;
      controller.abort();
    }, HELPER_TIMEOUT_MS);
    timeout.unref();
    const failure = () =>
      new ServiceError(
        'station_files_unavailable',
        'Station files changed or the protected file primitive failed',
      );
    child.once('spawn', () => helperSpawned(deps, run, child, request, id, verificationGuard));
    child.stdout.on('data', (chunk: Buffer) => {
      run.bytes += chunk.length;
      if (run.bytes > HELPER_OUTPUT_BYTES) {
        run.failed = true;
        controller.abort();
      } else run.chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {
      run.failed = true;
      controller.abort();
    });
    child.on('error', () => {
      run.failed = true;
    });
    child.once('close', (code) => {
      if (run.settled) return;
      run.settled = true;
      clearTimeout(timeout);
      if (id) deps.files.delete(id);
      try {
        accept(helperClosed(deps, run, code, request, id));
      } catch (error) {
        reject(error instanceof StationFilesDefiniteFailure ? error : failure());
      }
    });
  });
}

/** The process started: own it, fence the call, then send the request. */
function helperSpawned(
  deps: StationHelperDeps,
  run: HelperRun,
  child: ChildProcessWithoutNullStreams,
  request: Record<string, unknown>,
  id: string | undefined,
  verificationGuard: (() => void) | undefined,
): void {
  run.spawned = true;
  try {
    if (id) {
      // Own the process first: a guard that refuses below must still leave a pid and identity
      // that a stop can prove exited (staging card_06a619a3e2e94faf left a pid-less helper).
      const identity = processIdentity(child.pid!);
      if (!identity) stationUnavailable();
      deps.store.transaction(() =>
        deps.store.db
          .prepare(
            "UPDATE station_calls SET helper_pid=?,helper_identity=?,helper_state='running' WHERE id=? AND helper_state='launching'",
          )
          .run(child.pid!, identity, id),
      );
      const c = deps.get(id);
      if (verificationGuard) verificationGuard();
      else deps.guard(c);
      if (c.state !== 'dispatching') stationUnavailable();
    }
    child.stdin.end(
      JSON.stringify({
        version: 1,
        root: deps.config.workspace,
        root_identity: deps.config.workspace_identity,
        ...request,
      }),
    );
  } catch {
    run.failed = true;
    run.controller.abort();
  }
}

/** The process closed: record its observed exit, then read its one result. Throws when the
 * result is not a success (a definite refusal as StationFilesDefiniteFailure). */
function helperClosed(
  deps: StationHelperDeps,
  run: HelperRun,
  code: number | null,
  request: Record<string, unknown>,
  id: string | undefined,
): Record<string, any> {
  if (id) {
    const c = deps.get(id);
    const exited =
      !run.spawned ||
      (!!c.helper_pid && !processExists(c.helper_pid, true) && !processExists(c.helper_pid));
    deps.store.transaction(() =>
      deps.store.db
        .prepare('UPDATE station_calls SET helper_state=?,helper_stop_json=? WHERE id=?')
        .run(
          exited ? 'stopped' : 'unconfirmed',
          exited
            ? canonical({
                version: 1,
                scope: 'local_process_group',
                pid: c.helper_pid ?? null,
                identity: c.helper_identity ?? null,
                method: run.spawned ? 'observed_exit' : 'not_started',
              })
            : null,
          id,
        ),
    );
    if (!exited) stationUnavailable();
  }
  const result = object(JSON.parse(Buffer.concat(run.chunks).toString('utf8')));
  const refusal = definiteHelperRefusal(code, run.failed, result);
  if (refusal) throw new StationFilesDefiniteFailure(refusal);
  if (run.failed || code !== 0 || result.version !== 1 || result.ok !== true) stationUnavailable();
  return stationFileResult({ ...request, root_identity: deps.config.workspace_identity }, result);
}

export function processExists(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
/** Whether no process on this host runs the station file helper, proven from every /proc entry. */
export function noHelperProcess(): boolean {
  if (process.platform !== 'linux') return false;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try {
      argv = readFileSync(join('/proc', entry, 'cmdline'), 'utf8').split('\0');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return false;
    }
    if (argv.includes('salaam-station-files-v1')) return false;
  }
  return true;
}

/** Stop a call's helper: kill its owned process group and prove it exited, or, for a call that
 * recorded no pid, prove no helper runs on the host at all. Anything less leaves it unconfirmed. */
export async function stopStationHelper(deps: StationHelperDeps, id: string): Promise<void> {
  const c = deps.get(id);
  if (!c.helper_state || c.helper_state === 'none' || c.helper_state === 'stopped') return;
  deps.files.get(id)?.abort();
  try {
    if (!c.helper_pid || !c.helper_identity) {
      // Recorded before the fix above: no pid to prove. Settle only when the whole process table
      // holds no station helper; any live or unreadable process keeps the call fenced.
      if (!noHelperProcess()) stationUnavailable();
      deps.store.transaction(() =>
        deps.store.db
          .prepare("UPDATE station_calls SET helper_state='stopped',helper_stop_json=? WHERE id=?")
          .run(
            canonical({ version: 1, scope: 'host_process_table', method: 'no_helper_process' }),
            id,
          ),
      );
      return;
    }
    if (processExists(c.helper_pid) || processExists(c.helper_pid, true)) {
      if (processIdentity(c.helper_pid) !== c.helper_identity) stationUnavailable();
      process.kill(-c.helper_pid, 'SIGKILL');
      for (
        let i = 0;
        i < STOP_POLLS && (processExists(c.helper_pid) || processExists(c.helper_pid, true));
        i++
      )
        await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    }
    if (processExists(c.helper_pid) || processExists(c.helper_pid, true)) stationUnavailable();
    deps.store.transaction(() =>
      deps.store.db
        .prepare("UPDATE station_calls SET helper_state='stopped',helper_stop_json=? WHERE id=?")
        .run(
          canonical({
            version: 1,
            scope: 'local_process_group',
            pid: c.helper_pid,
            identity: c.helper_identity,
            method: 'observed_exit',
          }),
          id,
        ),
    );
  } catch {
    deps.store.transaction(() =>
      deps.store.db
        .prepare("UPDATE station_calls SET helper_state='unconfirmed' WHERE id=?")
        .run(id),
    );
    stationUnavailable();
  }
}
