import { spawn } from 'node:child_process';
import type { FileNow, LiveTree } from './station-checkpoints.js';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { processIdentity } from './supervisor.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { Artifacts } from './artifacts.js';
import type { ManagedWork } from './managed.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import {
  canonical,
  digest,
  object,
  string,
  integer,
  ServiceError,
  type Operation,
} from './protocol.js';
import {
  readStationConfig,
  stationUnavailable,
  stationHash,
  stationPrivateFile,
  stationWorkspaceIdentity,
  type StationConfig,
} from './station-config.js';
import { stationFileResult } from './station-files.js';
import { type RunGrants, runGrantCovers, runGrantPrefix } from './run-grants.js';
import { StationSystemd, type StationUnit } from './station-systemd.js';

export interface StationBinding {
  version: 1;
  root_digest: string;
  configuration_digest: string;
  runner: 'linux-systemd-station-v1';
  network: 'none';
  command_workspace: 'read-only-reviewed-snapshot';
}
export interface StationCall {
  id: string;
  session_id: string;
  worker_epoch: number;
  attempt_id: string | null;
  task_check_id?: string | null;
  tool_call_id: string;
  kind: 'patch' | 'check' | 'read';
  input_digest: string;
  root_digest: string;
  configuration_digest: string;
  args_json: string;
  operation_id: string | null;
  state: 'prepared' | 'dispatching' | 'returned' | 'failed' | 'outcome_unknown' | 'cancelled';
  revision: number;
  result_json: string | null;
  helper_pid?: number | null;
  helper_identity?: string | null;
  helper_state?: string;
  helper_stop_json?: string | null;
}
interface UnitRow {
  id: string;
  session_id: string | null;
  call_id: string | null;
  context_digest: string;
  config_json: string;
  snapshot_path: string;
  output_path: string;
  unit_json: string | null;
  state: 'prepared' | 'launching' | 'running' | 'unconfirmed' | 'stopped';
  stop_json: string | null;
}
const hashes = /^[a-f0-9]{64}$/;
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
const terminal = (s: string) => ['returned', 'failed', 'outcome_unknown', 'cancelled'].includes(s);

/** Root-only station controller. Writable source access stays behind the private
 * traversal-resistant node primitive; arbitrary checks get a separate OS identity,
 * mount/root/network boundary and bounded, owned systemd cgroup. */
export class StationWork {
  /** "Approve for this run" grants and the task each session's run belongs to (service wiring). */
  grants?: RunGrants;
  grantScope?: (
    session: string,
  ) => { task_id: string; plan_revision: number; task_state: string } | null;
  readonly config: StationConfig;
  readonly configurationDigest: string;
  private readonly directory: string;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly files = new Map<string, AbortController>();
  private readonly unitStops = new Map<string, Promise<unknown>>();
  private readonly unregister: () => void;
  taskCheckGuard?: (call: StationCall) => void;
  private closing = false;
  private proven = false;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly artifacts: Artifacts,
    readonly authority: AgentPodAuthority,
    readonly reference: { config: string; configuration_digest: string },
    state: string,
    readonly options: {
      assertActive(session: string, epoch: number, attempt: string): void;
      failed(session: string, error: Error): void;
    },
  ) {
    this.config = readStationConfig(
      reference.config,
      authority.pins.workspace,
      reference.configuration_digest,
    );
    this.configurationDigest = digest(this.config);
    this.directory = join(state, 'station');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.unregister = managed.registerMcpController('station-workspace-v1', {
      owns: (op) =>
        !!store.db.prepare('SELECT 1 FROM station_calls WHERE operation_id=?').get(op.id),
      assert: (op) => this.guard(this.operationCall(op)),
      assertSettled: (op) => {
        const c = this.operationCall(op);
        if (this.files.has(c.id) || !['none', 'stopped'].includes(c.helper_state ?? 'none'))
          stationUnavailable();
        if (
          this.store.db
            .prepare("SELECT 1 FROM station_units WHERE call_id=? AND state!='stopped'")
            .get(c.id)
        )
          stationUnavailable();
      },
    });
  }
  private operationCall(op: Operation): StationCall {
    const r = this.store.db
      .prepare('SELECT * FROM station_calls WHERE operation_id=?')
      .get(op.id) as unknown as StationCall | undefined;
    if (
      !r ||
      op.kind !== 'workspace' ||
      op.target_version !==
        digest({
          id: r.id,
          root: r.root_digest,
          configuration: r.configuration_digest,
          args: JSON.parse(r.args_json),
        })
    )
      stationUnavailable();
    return r;
  }
  private configCheck(): void {
    readStationConfig(
      this.reference.config,
      this.authority.pins.workspace,
      this.configurationDigest,
    );
  }
  private historical(c: StationCall): void {
    if (digest(JSON.parse(this.authority.bySession(c.session_id).binding)) !== c.root_digest)
      stationUnavailable();
  }
  private assertOwner(c: StationCall): void {
    if (c.task_check_id) {
      if (c.attempt_id !== null || !this.taskCheckGuard || !['read', 'check'].includes(c.kind))
        stationUnavailable();
      this.taskCheckGuard!(c);
    } else {
      if (!c.attempt_id) stationUnavailable();
      this.options.assertActive(c.session_id, c.worker_epoch, c.attempt_id!);
    }
  }
  private guard(c: StationCall): void {
    if (this.closing || !this.proven) stationUnavailable();
    this.historical(c);
    this.configCheck();
    this.assertOwner(c);
    this.store.taskGrantCheck?.(c.session_id);
    if (
      digest(this.authority.binding(c.session_id)) !== c.root_digest ||
      c.configuration_digest !== this.configurationDigest
    )
      stationUnavailable();
    this.assertResources(c.session_id);
    if (
      this.store.db
        .prepare("SELECT 1 FROM station_calls WHERE session_id=? AND state='dispatching' AND id!=?")
        .get(c.session_id, c.id ?? '')
    )
      stationUnavailable();
  }
  assertResources(session: string): void {
    if (
      this.store.db
        .prepare(
          "SELECT 1 FROM station_units u LEFT JOIN station_calls c ON c.id=u.call_id WHERE u.session_id=? AND (u.state='unconfirmed' OR (u.state!='stopped' AND c.state!='dispatching')) UNION ALL SELECT 1 FROM station_calls WHERE session_id=? AND (helper_state='unconfirmed' OR (state!='dispatching' AND helper_state NOT IN ('none','stopped')))",
        )
        .get(session, session)
    )
      stationUnavailable();
  }
  ready(session: string): StationBinding {
    if (!this.proven || this.closing) stationUnavailable();
    this.configCheck();
    this.assertResources(session);
    return {
      version: 1,
      root_digest: digest(this.authority.binding(session)),
      configuration_digest: this.configurationDigest,
      runner: 'linux-systemd-station-v1',
      network: 'none',
      command_workspace: 'read-only-reviewed-snapshot',
    };
  }
  assertBinding(session: string, binding: StationBinding): void {
    if (
      !this.proven ||
      this.closing ||
      binding.version !== 1 ||
      binding.configuration_digest !== this.configurationDigest ||
      binding.root_digest !== digest(this.authority.binding(session)) ||
      canonical(JSON.parse(stationPrivateFile(this.reference.config, 16384).toString('utf8'))) !==
        canonical(this.config) ||
      stationWorkspaceIdentity(this.config.workspace) !== this.config.workspace_identity
    )
      stationUnavailable();
    this.assertResources(session);
  }
  get(id: string): StationCall {
    const c = this.store.db.prepare('SELECT * FROM station_calls WHERE id=?').get(id) as unknown as
      StationCall | undefined;
    if (!c) throw new ServiceError('not_found', 'Station call not found', 404);
    this.historical(c);
    return c;
  }
  view(id: string): unknown {
    const c = this.get(id);
    return {
      call: c,
      result: c.result_json ? JSON.parse(c.result_json) : null,
      ...(c.operation_id
        ? {
            operation: this.managed.operation(c.operation_id),
            approval: this.managed.forOperation(c.operation_id),
          }
        : {}),
    };
  }
  private helper(
    request: Record<string, unknown>,
    id?: string,
    verificationGuard?: () => void,
  ): Promise<Record<string, any>> {
    const controller = new AbortController();
    if (id) this.files.set(id, controller);
    if (id)
      this.store.transaction(() =>
        this.store.db
          .prepare("UPDATE station_calls SET helper_state='launching' WHERE id=?")
          .run(id),
      );
    return new Promise((accept, reject) => {
      const child = spawn(this.config.files.path, ['salaam-station-files-v1'], {
        env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C' },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: controller.signal,
        killSignal: 'SIGKILL',
      });
      const chunks: Buffer[] = [];
      let bytes = 0,
        failed = false,
        spawned = false,
        settled = false;
      const timeout = setTimeout(() => {
        failed = true;
        controller.abort();
      }, 30000);
      timeout.unref();
      const failure = () =>
        new ServiceError(
          'station_files_unavailable',
          'Station files changed or the protected file primitive failed',
        );
      child.once('spawn', () => {
        spawned = true;
        try {
          if (id) {
            const c = this.get(id);
            if (verificationGuard) verificationGuard();
            else this.guard(c);
            if (c.state !== 'dispatching') stationUnavailable();
            const identity = processIdentity(child.pid!);
            if (!identity) stationUnavailable();
            this.store.transaction(() =>
              this.store.db
                .prepare(
                  "UPDATE station_calls SET helper_pid=?,helper_identity=?,helper_state='running' WHERE id=? AND helper_state='launching'",
                )
                .run(child.pid!, identity, id),
            );
          }
          child.stdin.end(
            JSON.stringify({
              version: 1,
              root: this.config.workspace,
              root_identity: this.config.workspace_identity,
              ...request,
            }),
          );
        } catch {
          failed = true;
          controller.abort();
        }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          failed = true;
          controller.abort();
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on('error', () => {
        failed = true;
        controller.abort();
      });
      child.on('error', () => {
        failed = true;
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (id) this.files.delete(id);
        try {
          if (id) {
            const c = this.get(id);
            const exited =
              !spawned ||
              (!!c.helper_pid &&
                !this.processExists(c.helper_pid, true) &&
                !this.processExists(c.helper_pid));
            this.store.transaction(() =>
              this.store.db
                .prepare('UPDATE station_calls SET helper_state=?,helper_stop_json=? WHERE id=?')
                .run(
                  exited ? 'stopped' : 'unconfirmed',
                  exited
                    ? canonical({
                        version: 1,
                        scope: 'local_process_group',
                        pid: c.helper_pid ?? null,
                        identity: c.helper_identity ?? null,
                        method: spawned ? 'observed_exit' : 'not_started',
                      })
                    : null,
                  id,
                ),
            );
            if (!exited) stationUnavailable();
          }
          const result = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const refusal = definiteHelperRefusal(code, failed, result);
          if (refusal) throw new StationFilesDefiniteFailure(refusal);
          if (failed || code !== 0 || result.version !== 1 || result.ok !== true)
            stationUnavailable();
          accept(
            stationFileResult(
              { ...request, root_identity: this.config.workspace_identity },
              result,
            ),
          );
        } catch (error) {
          reject(error instanceof StationFilesDefiniteFailure ? error : failure());
        }
      });
    });
  }
  private processExists(pid: number, group = false): boolean {
    try {
      process.kill(group ? -pid : pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }
  private async stopHelper(id: string): Promise<void> {
    const c = this.get(id);
    if (!c.helper_state || c.helper_state === 'none' || c.helper_state === 'stopped') return;
    this.files.get(id)?.abort();
    try {
      if (!c.helper_pid || !c.helper_identity) stationUnavailable();
      if (this.processExists(c.helper_pid) || this.processExists(c.helper_pid, true)) {
        if (processIdentity(c.helper_pid) !== c.helper_identity) stationUnavailable();
        process.kill(-c.helper_pid, 'SIGKILL');
        for (
          let i = 0;
          i < 100 && (this.processExists(c.helper_pid) || this.processExists(c.helper_pid, true));
          i++
        )
          await new Promise((r) => setTimeout(r, 20));
      }
      if (this.processExists(c.helper_pid) || this.processExists(c.helper_pid, true))
        stationUnavailable();
      this.store.transaction(() =>
        this.store.db
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
      this.store.transaction(() =>
        this.store.db
          .prepare("UPDATE station_calls SET helper_state='unconfirmed' WHERE id=?")
          .run(id),
      );
      stationUnavailable();
    }
  }
  /** A task verifier has no active model attempt. Its read still owns a durable
   * native helper and must revalidate its caller's task fence before/after I/O. */
  async verificationTree(
    sourceCall: string | { task_check_id: string },
    validate: (inspection: string) => void,
    request: Record<string, unknown> = { action: 'inspect' },
  ): Promise<Record<string, any>> {
    const check =
      typeof sourceCall === 'string'
        ? null
        : this.store.db
            .prepare(
              'SELECT t.session_id FROM task_checks c JOIN durable_tasks t ON t.id=c.task_id WHERE c.id=?',
            )
            .get(sourceCall.task_check_id);
    if (typeof sourceCall !== 'string' && !check) stationUnavailable();
    const source =
        typeof sourceCall === 'string'
          ? this.get(sourceCall)
          : {
              session_id: String(check!.session_id),
              worker_epoch: 0,
              attempt_id: null,
              task_check_id: sourceCall.task_check_id,
            },
      session = source.session_id;
    const binding = this.ready(session);
    if (!['inspect', 'read'].includes(String(request.action))) stationUnavailable();
    const id = digest(['station-verification-read-v1', sourceCall, randomUUID()]);
    let registered = false;
    const guard = () => {
      this.assertBinding(session, binding);
      if (registered && this.get(id).state !== 'dispatching') stationUnavailable();
      this.assertVerificationSettled(session, id);
      validate(id);
    };
    guard();
    this.store.transaction(() => {
      guard();
      this.store.db
        .prepare(
          "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,task_check_id) VALUES(?,?,?,?,?,'read',?,?,?,?,'dispatching',?)",
        )
        .run(
          id,
          session,
          source.worker_epoch,
          source.attempt_id,
          id,
          digest(request),
          binding.root_digest,
          binding.configuration_digest,
          canonical(request),
          source.task_check_id ?? null,
        );
    });
    registered = true;
    try {
      const result = await this.helper(request, id, guard);
      guard();
      this.store.transaction(() => {
        guard();
        this.change(this.get(id), 'returned');
        this.store.event(session, 'station.verification_observed', {
          source_call: sourceCall,
          inspection_call: id,
          tree_digest: result.tree_digest,
        });
      });
      return result;
    } catch (error) {
      this.store.transaction(() => {
        const current = this.get(id);
        if (current.state === 'dispatching') this.change(current, 'failed');
      });
      throw error;
    }
  }
  assertVerificationSettled(session: string, inspection?: string): void {
    this.ready(session);
    if (
      this.store.hasUnknown(session) ||
      this.store.db
        .prepare(
          "SELECT 1 FROM station_calls WHERE session_id=? AND NOT(id=? AND kind='read' AND tool_call_id=id AND json_extract(args_json,'$.action') IN ('inspect','read')) AND (state IN ('prepared','dispatching','outcome_unknown') OR helper_state NOT IN ('none','stopped'))",
        )
        .get(session, inspection ?? '') ||
      this.store.db
        .prepare("SELECT 1 FROM station_units WHERE session_id=? AND state!='stopped'")
        .get(session)
    )
      stationUnavailable();
  }

  async read(
    session: string,
    epoch: number,
    attempt: string,
    key: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const action = string(args.action, 'action', 16);
    if (
      !['inspect', 'list', 'search', 'read'].includes(action) ||
      Object.keys(args).some((k) => !['action', 'path', 'offset', 'query'].includes(k))
    )
      throw new ServiceError('invalid_field', 'Unsupported station read');
    const actor = 'station-read:' + session + ':' + epoch,
      input = { attempt, args },
      old = this.store.db
        .prepare('SELECT hash,response FROM requests WHERE actor=? AND id=?')
        .get(actor, key);
    if (old) {
      if (old.hash !== digest(input))
        throw new ServiceError('request_conflict', 'Station read ID changed');
      this.authority.bySession(session);
      return JSON.parse(String(old.response));
    }
    const row = {
      session_id: session,
      worker_epoch: epoch,
      attempt_id: attempt,
      root_digest: digest(this.authority.binding(session)),
      configuration_digest: this.configurationDigest,
    } as StationCall;
    this.guard(row);
    const id = digest(['station-read-resource-v1', session, epoch, key]);
    if (this.store.db.prepare('SELECT 1 FROM station_calls WHERE id=?').get(id))
      throw new ServiceError(
        'station_files_changed',
        'Previous station read was interrupted; use a new read ID',
      );
    this.store.transaction(() =>
      this.store.db
        .prepare(
          "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES(?,?,?,?,?,'read',?,?,?,?,'dispatching')",
        )
        .run(
          id,
          session,
          epoch,
          attempt,
          key,
          digest(args),
          row.root_digest,
          this.configurationDigest,
          canonical(args),
        ),
    );
    try {
      const result = await this.helper(
        {
          action,
          ...(action === 'read' ? { path: string(args.path, 'path', 512) } : {}),
          ...(action === 'search' ? { query: string(args.query, 'query', 256) } : {}),
          ...(['list', 'search'].includes(action)
            ? { offset: args.offset === undefined ? 0 : integer(args.offset, 'offset') }
            : {}),
        },
        id,
      );
      this.guard(this.get(id));
      if (action === 'read') {
        const offset = args.offset === undefined ? 0 : integer(args.offset, 'offset'),
          data = Array.from(String(result.content));
        result.content = data.slice(offset, offset + 2048).join('');
        result.offset = offset;
        result.next_offset = offset + 2048 < data.length ? offset + 2048 : null;
      }
      return this.store.request(actor, key, input, () => {
        const current = this.get(id);
        if (current.state !== 'dispatching') stationUnavailable();
        this.change(current, 'returned');
        this.store.event(session, 'station.read', {
          attempt_id: attempt,
          tool_call_id: key,
          action,
          tree_digest: result.tree_digest,
        });
        return result;
      });
    } catch (error) {
      const current = this.get(id);
      if (current.state === 'dispatching')
        this.store.transaction(() => this.change(current, 'failed'));
      throw error;
    }
  }

  prepareTaskCheck(check: string, command: string, tree: string): StationCall {
    const r = this.store.db
      .prepare(
        'SELECT c.*,t.session_id FROM task_checks c JOIN durable_tasks t ON t.id=c.task_id WHERE c.id=?',
      )
      .get(check);
    if (!r || r.state !== 'accepted') stationUnavailable();
    const session = String(r.session_id),
      binding = this.ready(session);
    if (!hashes.test(tree)) stationUnavailable();
    const id = digest(['station-task-check-v1', check]);
    const args = { action: 'check', command, expected_tree: tree };
    const prior = this.store.db.prepare('SELECT id FROM station_calls WHERE id=?').get(id);
    if (prior) return this.get(id);
    this.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,task_check_id) VALUES(?,?,0,NULL,?,'check',?,?,?,?,'prepared',?)",
      )
      .run(
        id,
        session,
        'task-check:' + check,
        digest(args),
        binding.root_digest,
        binding.configuration_digest,
        canonical(args),
        check,
      );
    return this.get(id);
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    key: string,
    args: Record<string, unknown>,
  ): unknown {
    const kind = string(args.action, 'action', 16);
    if (!['patch', 'check'].includes(kind))
      throw new ServiceError('invalid_field', 'Unsupported station mutation');
    const allowed =
      kind === 'patch'
        ? ['action', 'path', 'expected_tree', 'expected_hash', 'content', 'reason']
        : ['action', 'expected_tree', 'command'];
    if (
      Object.keys(args).some((k) => !allowed.includes(k)) ||
      typeof args.expected_tree !== 'string' ||
      !hashes.test(args.expected_tree)
    )
      throw new ServiceError('invalid_field', 'Use the exact observed station tree');
    if (kind === 'patch') {
      string(args.path, 'path', 512);
      if (
        args.expected_hash !== null &&
        (typeof args.expected_hash !== 'string' || !hashes.test(args.expected_hash))
      )
        throw new ServiceError('invalid_field', 'Use the exact observed file hash');
      if (
        args.content !== null &&
        (typeof args.content !== 'string' ||
          Buffer.byteLength(args.content) > 16384 ||
          Buffer.from(args.content).toString('utf8') !== args.content)
      )
        throw new ServiceError('invalid_field', 'Patch content exceeds the reviewed edit bound');
    } else string(args.command, 'command', 8192);
    const id = digest(['station-work-v1', session, epoch, key]),
      prior = this.store.db.prepare('SELECT id FROM station_calls WHERE id=?').get(id);
    if (prior) {
      const c = this.get(id);
      if (c.input_digest !== digest(args) || c.attempt_id !== attempt)
        throw new ServiceError('request_conflict', 'Station call ID changed');
      return this.view(id);
    }
    const row: StationCall = {
      id,
      session_id: session,
      worker_epoch: epoch,
      attempt_id: attempt,
      tool_call_id: key,
      kind: kind as 'patch' | 'check',
      input_digest: digest(args),
      root_digest: digest(this.authority.binding(session)),
      configuration_digest: this.configurationDigest,
      args_json: canonical(args),
      operation_id: null,
      state: 'prepared',
      revision: 1,
      result_json: null,
    };
    this.guard(row);
    if (this.store.hasUnknown(session)) stationUnavailable();
    if (
      Number(
        this.store.db
          .prepare("SELECT count(*) AS n FROM station_calls WHERE attempt_id=? AND kind!='read'")
          .get(attempt)!.n,
      ) >= 32
    )
      throw new ServiceError('station_call_limit', 'Station attempt call bound reached');
    if (
      kind === 'check' &&
      Number(
        this.store.db
          .prepare(
            "SELECT count(*) AS n FROM station_calls WHERE kind='check' AND state='dispatching'",
          )
          .get()!.n,
      ) >= 2
    )
      throw new ServiceError('station_busy', 'Station command concurrency bound reached');
    this.store.transaction(() => {
      this.store.db
        .prepare(
          'INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          session,
          epoch,
          attempt,
          key,
          kind,
          row.input_digest,
          row.root_digest,
          row.configuration_digest,
          row.args_json,
          'prepared',
        );
      if (kind === 'patch') {
        const context = digest({
          id,
          root: row.root_digest,
          configuration: this.configurationDigest,
          args,
        });
        const permission = this.managed.prepareWorkspaceInTransaction(
          session,
          epoch,
          attempt,
          key,
          'station:' + args.path,
          canonical(args),
          context,
        );
        this.store.db
          .prepare('UPDATE station_calls SET operation_id=? WHERE id=?')
          .run(permission.operation.id, id);
      }
      this.store.event(session, 'station.call.prepared', {
        call_id: id,
        attempt_id: attempt,
        kind,
        input_digest: row.input_digest,
      });
    });
    const prepared = this.get(id);
    if (kind === 'patch' && prepared.operation_id)
      this.answerFromGrant(prepared.operation_id, session, args);
    return this.view(id);
  }
  /** A write the run's grant covers is answered by it, checked again at decision time. The
   * operation is still prepared, digest-bound and journaled on its own; deletes always ask. */
  /** An agent's standing "Always allow" rule (pinned at admission or added by a renewal, dropped at the renewal that no
   * longer lists it) answers a workspace write anywhere in the workspace, never a delete or a
   * hidden path. Checked again at decision time, so a rule revoked meanwhile answers nothing. */
  private answerFromRule(operation: string, session: string, args: Record<string, unknown>): void {
    if (!runGrantCovers('', args)) return;
    const live = () =>
      this.authority.approvalRules(session).find((r) => r.scope === 'workspace-write');
    const rule = live();
    if (!rule) return;
    const approval = this.managed.forOperation(operation);
    if (approval.state !== 'pending') return;
    this.managed.decide(
      approval.id,
      'rule:' + operation,
      approval.revision,
      approval.operation_digest,
      'approve',
      {
        decidedBy: 'rule:' + rule.id,
        receipt: { rule: 'agent-rule', rule_id: rule.id, set_by: rule.set_by },
        authorize: () => {
          if (live()?.id !== rule.id)
            throw new ServiceError(
              'permission_changed',
              'The approval rule no longer covers this write',
            );
        },
      },
    );
  }
  private answerFromGrant(operation: string, session: string, args: Record<string, unknown>): void {
    if (!this.grants || !this.grantScope) return;
    const binding = this.authority.binding(session) as { run?: { id?: unknown } } | null;
    const prefix = runGrantPrefix(typeof binding?.run?.id === 'string' ? binding.run.id : '');
    const live = () => {
      const scope = this.grantScope!(session);
      if (!scope || !prefix || !runGrantCovers(prefix, args)) return null;
      const g = this.grants!.active({
        session_id: session,
        binding_digest: digest(binding),
        ...scope,
      });
      return g;
    };
    const grant = live();
    if (!grant) return this.answerFromRule(operation, session, args);
    const approval = this.managed.forOperation(operation);
    if (approval.state !== 'pending') return;
    this.managed.decide(
      approval.id,
      'run-grant:' + operation,
      approval.revision,
      approval.operation_digest,
      'approve',
      {
        decidedBy: 'run-grant:' + grant.id,
        receipt: {
          rule: 'run-grant',
          grant_id: grant.id,
          granted_by: grant.granted_by,
          granted_on: grant.approval_id,
        },
        authorize: () => {
          if (live()?.id !== grant.id)
            throw new ServiceError(
              'permission_changed',
              'The run grant no longer covers this write',
            );
        },
      },
    );
  }
  /** Item 11b: the restore journal. Each write is recorded before it is sent, so a daemon stop
   * mid-restore leaves an honest unknown, never a silent effect. */
  private restoreTables(): void {
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS station_restores(
      id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
      restore_digest TEXT NOT NULL, approved_by TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);
    CREATE TABLE IF NOT EXISTS station_restore_writes(
      restore_id TEXT NOT NULL REFERENCES station_restores(id), n INTEGER NOT NULL, path TEXT NOT NULL,
      args_json TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT, artifact_id TEXT,
      PRIMARY KEY(restore_id, n));`);
  }
  /** Item 11b: the live workspace through the helper's closed verbs (inspect, search, read). A
   * path is absent only when an exact search finds no entry for it; a file the helper refuses to
   * read (too large, not text) is unreadable, never guessed. */
  async live(): Promise<LiveTree> {
    const inspected = await this.helper({ action: 'inspect' });
    return {
      tree: String(inspected.tree_digest),
      file: async (path: string): Promise<FileNow> => {
        let offset: number | null = 0,
          found = false;
        while (offset !== null && !found) {
          const page: Record<string, any> = await this.helper({
            action: 'search',
            query: path,
            offset,
          });
          found = (page.entries as { path: string }[]).some((e) => e.path === path);
          offset = page.next_offset ?? null;
        }
        if (!found) return { state: 'absent' };
        try {
          const read = await this.helper({ action: 'read', path });
          return { state: 'content', content: String(read.content), sha256: String(read.sha256) };
        } catch {
          return { state: 'unreadable' };
        }
      },
    };
  }
  /** Item 11b: the journal's answer for a restore request already seen, or null for a new one.
   * A replay returns the saved receipt exactly; the same request for another restore is a
   * conflict; an unfinished one says so. Checked before any plan is recomputed. */
  replayed(session: string, request: string, restoreDigest: string): unknown | null {
    this.restoreTables();
    const saved = this.store.db
      .prepare('SELECT * FROM station_restores WHERE request_id=?')
      .get(request);
    if (!saved) return null;
    if (saved.restore_digest !== restoreDigest || saved.session_id !== session)
      throw new ServiceError(
        'request_conflict',
        'This restore request was used for another restore',
      );
    if (saved.receipt) return JSON.parse(String(saved.receipt));
    throw new ServiceError('restore_unconfirmed', 'This restore did not finish; review it again');
  }
  /** At start: a restore write that was in flight has an unknown outcome; its restore is partial. */
  recoverRestores(): void {
    this.restoreTables();
    this.store.transaction(() => {
      for (const w of this.store.db
        .prepare("SELECT restore_id,n FROM station_restore_writes WHERE state='dispatching'")
        .all()) {
        this.store.db
          .prepare(
            "UPDATE station_restore_writes SET state='outcome_unknown' WHERE restore_id=? AND n=?",
          )
          .run(String(w.restore_id), Number(w.n));
        this.store.db
          .prepare("UPDATE station_restores SET state='partial' WHERE id=?")
          .run(String(w.restore_id));
      }
    });
  }
  /**
   * Item 11b: restore files exactly as planned and approved, after the run has ended. The caller
   * checks the ended run and the approval; this writes. It refuses a workspace whose live tree is
   * not the reviewed one, then sends each write through the protected helper in order, chaining
   * the expected tree and each file's current hash, with a receipt per file. The same request
   * replays its receipt. A failure stops the restore; nothing is retried.
   */
  async restore(
    session: string,
    rootDigest: string,
    plan: {
      restore_digest: string;
      current_tree: string;
      writes: { path: string; content: string | null; expected_hash: string | null }[];
    },
    request: string,
    approvedBy: string,
  ): Promise<unknown> {
    this.restoreTables();
    const saved = this.store.db
      .prepare('SELECT * FROM station_restores WHERE request_id=?')
      .get(request);
    if (saved) {
      if (saved.restore_digest !== plan.restore_digest || saved.session_id !== session)
        throw new ServiceError(
          'request_conflict',
          'This restore request was used for another restore',
        );
      if (saved.receipt) return JSON.parse(String(saved.receipt));
      throw new ServiceError('restore_unconfirmed', 'This restore did not finish; review it again');
    }
    const live = (await this.helper({ action: 'inspect' })) as { tree_digest?: unknown };
    if (live.tree_digest !== plan.current_tree)
      throw new ServiceError(
        'restore_changed',
        'The workspace changed since this restore was reviewed',
      );
    const id = randomUUID();
    this.store.transaction(() =>
      this.store.db
        .prepare("INSERT INTO station_restores VALUES (?,?,?,?,?,'running',NULL)")
        .run(id, session, request, plan.restore_digest, approvedBy),
    );
    let tree = plan.current_tree;
    const done: { path: string; artifact_id: string }[] = [];
    let stopped: string | null = null;
    for (const [n, w] of plan.writes.entries()) {
      const args = {
        action: 'patch',
        path: w.path,
        expected_tree: tree,
        expected_hash: w.expected_hash,
        content: w.content,
        // The helper accepts only a 64-hex request id: one per restore write, stable on replay.
        request_id: digest({ restore: id, write: n }),
        deadline_ms: Date.now() + 5000,
      };
      this.store.transaction(() =>
        this.store.db
          .prepare("INSERT INTO station_restore_writes VALUES (?,?,?,?,'dispatching',NULL,NULL)")
          .run(id, n, w.path, canonical(args)),
      );
      let result: Record<string, unknown>;
      try {
        result = (await this.helper(args)) as Record<string, unknown>;
      } catch (error) {
        const definite = error instanceof StationFilesDefiniteFailure;
        this.store.transaction(() =>
          this.store.db
            .prepare(
              'UPDATE station_restore_writes SET state=?,result_json=? WHERE restore_id=? AND n=?',
            )
            .run(
              definite ? 'failed' : 'outcome_unknown',
              canonical({
                code: definite ? (error as ServiceError).code : 'station_execution_unconfirmed',
              }),
              id,
              n,
            ),
        );
        stopped = w.path;
        break;
      }
      const artifact = this.artifacts.prepare(
        session,
        canonical({
          version: 1,
          kind: 'station-restore-receipt',
          restore_id: id,
          request_id: request,
          restore_digest: plan.restore_digest,
          approved_by: approvedBy,
          session_id: session,
          root_digest: rootDigest,
          configuration_digest: this.configurationDigest,
          path: w.path,
          patch: {
            content: w.content,
            expected_tree: args.expected_tree,
            expected_hash: w.expected_hash,
          },
          result,
        }),
      );
      this.store.transaction(() => {
        artifact.commit();
        this.store.db
          .prepare(
            "UPDATE station_restore_writes SET state='returned',result_json=?,artifact_id=? WHERE restore_id=? AND n=?",
          )
          .run(canonical(result), artifact.id, id, n);
      });
      done.push({ path: w.path, artifact_id: artifact.id });
      tree = String(result.tree_digest);
    }
    const receipt = {
      version: 1 as const,
      state: stopped ? ('partial' as const) : ('restored' as const),
      restore_id: id,
      restore_digest: plan.restore_digest,
      tree_digest: tree,
      writes: done,
      ...(stopped ? { stopped_at: stopped } : {}),
    };
    this.store.transaction(() => {
      this.store.db
        .prepare('UPDATE station_restores SET state=?,receipt=? WHERE id=?')
        .run(receipt.state, canonical(receipt), id);
      this.store.event(session, 'station.restored', {
        restore_id: id,
        restore_digest: plan.restore_digest,
        approved_by: approvedBy,
        state: receipt.state,
      });
    });
    return receipt;
  }
  run(id: string): unknown {
    const c = this.get(id);
    if (terminal(c.state) || this.jobs.has(id)) return this.view(id);
    if (c.state !== 'prepared') stationUnavailable();
    this.guard(c);
    this.store.transaction(() => {
      if (c.operation_id && !this.managed.takePermissionInTransaction(c.operation_id)) return;
      this.change(c, 'dispatching');
    });
    if (this.get(id).state !== 'dispatching') return this.view(id);
    const job = this.perform(id)
      .catch(async (error) => {
        for (const u of this.store.db
          .prepare("SELECT id FROM station_units WHERE call_id=? AND state!='stopped'")
          .all(id)) {
          try {
            await this.stopUnit(String(u.id));
          } catch {
            /* persistent unconfirmed unit remains fenced */
          }
        }
        const current = this.get(id);
        if (current.state === 'dispatching')
          this.store.transaction(() => {
            const definite = error instanceof StationFilesDefiniteFailure;
            this.change(
              current,
              current.kind === 'patch' && !definite ? 'outcome_unknown' : 'failed',
              { code: definite ? error.code : 'station_execution_unconfirmed' },
            );
            if (current.operation_id) {
              if (definite)
                this.managed.workspaceDefiniteFailureInTransaction(current.operation_id);
              else this.managed.workspaceUnknownInTransaction(current.operation_id);
            }
          });
        if (this.unconfirmed(c.session_id).length)
          this.options.failed(c.session_id, error as Error);
      })
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return this.view(id);
  }
  private change(c: StationCall, state: StationCall['state'], result?: unknown): void {
    this.store.db
      .prepare('UPDATE station_calls SET state=?,result_json=?,revision=revision+1 WHERE id=?')
      .run(state, result === undefined ? c.result_json : canonical(result), c.id);
    this.store.event(c.session_id, 'station.call.' + state, {
      call_id: c.id,
      attempt_id: c.attempt_id,
      kind: c.kind,
    });
  }
  private async perform(id: string): Promise<void> {
    const c = this.get(id),
      args = JSON.parse(c.args_json);
    this.guard(c);
    if (c.kind === 'patch') {
      const result = await this.helper(
        {
          // Only the helper's own fields: it refuses any field it does not know (the agent's
          // reason is for the approval detail and stays in the operation's arguments).
          action: args.action,
          path: args.path,
          expected_tree: args.expected_tree,
          expected_hash: args.expected_hash,
          content: args.content,
          request_id: id,
          deadline_ms: Date.now() + this.authority.leaseWindow(c.session_id, c.root_digest, 5000),
        },
        id,
      );
      // Completion records actual file bytes; a subsequent grant still needs a
      // fresh execution lease. A model final answer supplies no receipt.
      const artifact = this.artifacts.prepare(
        c.session_id,
        canonical({
          version: 1,
          kind: 'station-applied-patch-receipt',
          call_id: id,
          operation_id: c.operation_id,
          session_id: c.session_id,
          attempt_id: c.attempt_id,
          root_digest: c.root_digest,
          configuration_digest: c.configuration_digest,
          input_digest: c.input_digest,
          patch: {
            path: args.path,
            content: args.content,
            expected_tree: args.expected_tree,
            expected_hash: args.expected_hash,
          },
          result,
        }),
      );
      this.store.transaction(() => {
        const current = this.get(id);
        if (current.state !== 'dispatching') stationUnavailable();
        artifact.commit();
        this.change(current, 'returned', result);
        this.managed.workspaceResultInTransaction(c.operation_id!, {
          version: 1,
          scope: 'station-workspace',
          artifact_id: artifact.id,
          call_id: id,
          root_digest: c.root_digest,
          configuration_digest: c.configuration_digest,
          input_digest: c.input_digest,
          result,
        });
      });
      return;
    }
    const unit = this.createUnit(
      c.session_id,
      id,
      digest({
        id,
        root: c.root_digest,
        configuration: c.configuration_digest,
        input: c.input_digest,
      }),
    );
    await this.helper(
      {
        action: 'snapshot',
        expected_tree: args.expected_tree,
        snapshot: unit.snapshot_path,
        request_id: id,
      },
      id,
    );
    this.guard(c);
    const outcome = await this.executeUnit(unit, args.command, () => {
      const current = this.get(id);
      if (current.state !== 'dispatching' || this.closing) stationUnavailable();
      this.assertOwner(c);
      this.store.taskGrantCheck?.(c.session_id);
      this.assertResources(c.session_id);
    });
    const observed = await this.helper({ action: 'inspect' });
    const current = this.get(id);
    if (current.state !== 'dispatching') return;
    this.guard(current);
    const success = outcome.exit_code === 0 && observed.tree_digest === args.expected_tree;
    this.store.transaction(() =>
      this.change(current, success ? 'returned' : 'failed', {
        ...outcome,
        expected_tree: args.expected_tree,
        observed_tree: observed.tree_digest,
        verified_check: success,
        network: 'none',
        workspace: 'read-only-reviewed-snapshot',
      }),
    );
  }
  private unit(id: string): UnitRow {
    const row = this.store.db
      .prepare('SELECT * FROM station_units WHERE id=?')
      .get(id) as unknown as UnitRow | undefined;
    if (!row) stationUnavailable();
    return row;
  }
  private createUnit(session: string | null, call: string | null, context: string): UnitRow {
    const id = digest(['station-unit-v1', call ?? randomUUID(), context]),
      base = mkdtempSync(join(this.directory, 'unit-'));
    const row: UnitRow = {
      id,
      session_id: session,
      call_id: call,
      context_digest: context,
      config_json: canonical(this.config),
      snapshot_path: join(base, 'source'),
      output_path: join(base, 'output'),
      unit_json: null,
      state: 'prepared',
      stop_json: null,
    };
    writeFileSync(row.output_path, '', { mode: 0o600 });
    this.store.transaction(() =>
      this.store.db
        .prepare('INSERT INTO station_units VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          row.id,
          row.session_id,
          row.call_id,
          row.context_digest,
          row.config_json,
          row.snapshot_path,
          row.output_path,
          null,
          'prepared',
          null,
        ),
    );
    return row;
  }
  private async executeUnit(
    row: UnitRow,
    command: string,
    grant: () => void,
  ): Promise<{ exit_code: number | null; output: string; cleanup: unknown }> {
    const runtime = new StationSystemd(JSON.parse(row.config_json));
    grant();
    this.store.transaction(() =>
      this.store.db
        .prepare("UPDATE station_units SET state='launching' WHERE id=? AND state='prepared'")
        .run(row.id),
    );
    try {
      await runtime.launch(row.id, row.context_digest, row.snapshot_path, row.output_path, command);
      let observed = await runtime.inspect(row.id, row.context_digest);
      if (!observed) stationUnavailable();
      this.store.transaction(() =>
        this.store.db
          .prepare(
            "UPDATE station_units SET state='running',unit_json=? WHERE id=? AND state='launching'",
          )
          .run(canonical(observed), row.id),
      );
      const until = Date.now() + 35000;
      while (
        observed.sub === 'running' ||
        observed.sub === 'start' ||
        observed.sub === 'start-pre'
      ) {
        grant();
        if (Date.now() > until) stationUnavailable();
        await new Promise((r) => setTimeout(r, 100));
        const next = await runtime.inspect(row.id, row.context_digest);
        if (!next || next.invocation !== observed.invocation) stationUnavailable();
        observed = next;
      }
      const exit = observed.code === 1 ? observed.status : null,
        cleanup = await this.stopUnit(row.id);
      const st = lstatSync(row.output_path);
      if (!st.isFile() || st.nlink !== 1 || st.size >= 65536) stationUnavailable();
      return { exit_code: exit, output: readFileSync(row.output_path, 'utf8'), cleanup };
    } catch (error) {
      await this.stopUnit(row.id);
      throw error;
    }
  }
  private stopUnit(id: string): Promise<unknown> {
    const pending = this.unitStops.get(id);
    if (pending) return pending;
    // Revocation, attempt cancellation and the executor finalizer can converge.
    // They must share one actual stop observation, not race stale row snapshots.
    const work = this.stopUnitOnce(id);
    this.unitStops.set(id, work);
    void work
      .finally(() => {
        if (this.unitStops.get(id) === work) this.unitStops.delete(id);
      })
      .catch(() => {});
    return work;
  }
  private async stopUnitOnce(id: string): Promise<unknown> {
    const row = this.unit(id);
    if (row.state === 'stopped') return JSON.parse(row.stop_json!);
    try {
      const proof =
        row.state === 'prepared'
          ? { version: 1, method: 'not_started' }
          : await new StationSystemd(JSON.parse(row.config_json)).stop(
              id,
              row.context_digest,
              row.unit_json ? JSON.parse(row.unit_json) : undefined,
            );
      this.store.transaction(() =>
        this.store.db
          .prepare("UPDATE station_units SET state='stopped',stop_json=? WHERE id=?")
          .run(canonical(proof), id),
      );
      if (
        !row.snapshot_path.startsWith(this.directory + '/unit-') ||
        !row.snapshot_path.endsWith('/source')
      )
        stationUnavailable();
      rmSync(row.snapshot_path, { recursive: true, force: true });
      return proof;
    } catch {
      this.store.transaction(() =>
        this.store.db.prepare("UPDATE station_units SET state='unconfirmed' WHERE id=?").run(id),
      );
      stationUnavailable();
    }
  }
  async initialize(): Promise<void> {
    this.proven = false;
    this.recoverRestores();
    for (const row of this.store.db
      .prepare(
        "SELECT id FROM station_calls WHERE helper_state NOT IN ('none','stopped') ORDER BY rowid",
      )
      .all())
      await this.stopHelper(String(row.id));
    for (const row of this.store.db
      .prepare("SELECT id FROM station_units WHERE state!='stopped' ORDER BY rowid")
      .all())
      await this.stopUnit(String(row.id));
    this.store.transaction(() => {
      for (const row of this.store.db
        .prepare("SELECT * FROM station_calls WHERE state IN ('prepared','dispatching')")
        .all() as unknown as StationCall[]) {
        if (row.state === 'prepared') {
          if (row.operation_id) this.managed.workspaceNotSentInTransaction(row.operation_id);
          this.change(row, 'cancelled');
        } else {
          if (row.operation_id) this.managed.workspaceUnknownInTransaction(row.operation_id);
          this.change(row, row.kind === 'patch' ? 'outcome_unknown' : 'failed', {
            code: 'daemon_interrupted',
            verified_check: false,
          });
        }
      }
    });
    this.configCheck();
    await this.helper({ action: 'inspect' });
    const probe = this.createUnit(
      null,
      null,
      digest({ configuration: this.configurationDigest, probe: randomUUID() }),
    );
    mkdirSync(probe.snapshot_path, { mode: 0o755 });
    writeFileSync(join(probe.snapshot_path, 'sample'), 'station-boundary-proof', { mode: 0o444 });
    chmodSync(join(probe.snapshot_path, 'sample'), 0o444);
    chmodSync(probe.snapshot_path, 0o555);
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const script = `node -e ${quote("const fs=require('fs'),assert=require('assert/strict');assert.notEqual(process.getuid(),0);const status=fs.readFileSync('/proc/self/status','utf8');assert.match(status,/CapEff:\\s+0000000000000000/);assert.match(status,/NoNewPrivs:\\s+1/);const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('\\n').find(l=>l.startsWith('0::')).slice(3);assert.equal(fs.readFileSync('/sys/fs/cgroup'+group+'/memory.max','utf8').trim(),'536870912');assert.equal(fs.readFileSync('/sys/fs/cgroup'+group+'/pids.max','utf8').trim(),'64');assert.equal(fs.readFileSync('/workspace/sample','utf8'),'station-boundary-proof');assert.throws(()=>fs.writeFileSync('/workspace/sample','bad'));assert.throws(()=>fs.readFileSync(" + JSON.stringify(join(this.directory, 'control-canary')) + "));assert.throws(()=>fs.statSync('/run/systemd/private'));assert.throws(()=>fs.statSync('/var/run/docker.sock'));assert.ok(!fs.existsSync('/root/.ssh'));assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);for(const k of ['ANTHROPIC_API_KEY','SSH_AUTH_SOCK','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','SALAAM_WORKER_CONFIG'])assert.equal(process.env[k],undefined);console.log('station-boundary-ok');")}`;
    writeFileSync(join(this.directory, 'control-canary'), 'synthetic-control-only', {
      mode: 0o600,
    });
    const outcome = await this.executeUnit(probe, script, () => {
      if (this.closing) stationUnavailable();
    });
    if (outcome.exit_code !== 0 || !outcome.output.includes('station-boundary-ok'))
      stationUnavailable();
    this.proven = true;
  }
  cancelInTransaction(attempt: string): void {
    if (!this.store.db.isTransaction) throw Error('Station cancellation requires a transaction');
    for (const c of this.store.db
      .prepare(
        "SELECT * FROM station_calls WHERE attempt_id=? AND state IN ('prepared','dispatching')",
      )
      .all(attempt) as unknown as StationCall[]) {
      if (c.operation_id) {
        if (c.state === 'prepared') this.managed.workspaceNotSentInTransaction(c.operation_id);
        else this.managed.workspaceUnknownInTransaction(c.operation_id);
      }
      this.change(
        c,
        c.kind === 'patch' && c.state === 'dispatching' ? 'outcome_unknown' : 'cancelled',
      );
    }
  }
  async abortAttempt(attempt: string): Promise<void> {
    const calls = this.store.db
      .prepare('SELECT id FROM station_calls WHERE attempt_id=?')
      .all(attempt);
    for (const c of calls) await this.stopHelper(String(c.id));
    const results = await Promise.allSettled(
      this.store.db
        .prepare(
          "SELECT u.id FROM station_units u JOIN station_calls c ON c.id=u.call_id WHERE c.attempt_id=? AND u.state!='stopped'",
        )
        .all(attempt)
        .map((u) => this.stopUnit(String(u.id))),
    );
    if (results.some((r) => r.status === 'rejected')) stationUnavailable();
  }
  async stopSession(session: string): Promise<void> {
    this.store.transaction(() => {
      for (const row of this.store.db
        .prepare(
          "SELECT * FROM station_calls WHERE session_id=? AND state IN ('prepared','dispatching')",
        )
        .all(session) as unknown as StationCall[]) {
        if (row.operation_id) {
          if (row.state === 'prepared')
            this.managed.workspaceNotSentInTransaction(row.operation_id);
          else this.managed.workspaceUnknownInTransaction(row.operation_id);
        }
        this.change(
          row,
          row.kind === 'patch' && row.state === 'dispatching' ? 'outcome_unknown' : 'cancelled',
        );
      }
    });
    const results = await Promise.allSettled([
      ...this.store.db
        .prepare(
          "SELECT id FROM station_calls WHERE session_id=? AND helper_state NOT IN ('none','stopped')",
        )
        .all(session)
        .map((r) => this.stopHelper(String(r.id))),
      ...this.store.db
        .prepare("SELECT id FROM station_units WHERE session_id=? AND state!='stopped'")
        .all(session)
        .map((r) => this.stopUnit(String(r.id))),
    ]);
    if (results.some((r) => r.status === 'rejected')) stationUnavailable();
  }
  stopped(session: string): boolean {
    return !this.unconfirmed(session).length;
  }
  unconfirmed(session: string, attempt?: string): string[] {
    const helpers = this.store.db
      .prepare(
        "SELECT id FROM station_calls WHERE session_id=? AND helper_state NOT IN ('none','stopped') AND (? IS NULL OR attempt_id=?)",
      )
      .all(session, attempt ?? null, attempt ?? null)
      .map((r) => 'station-files:' + r.id);
    return [
      ...helpers,
      ...this.store.db
        .prepare(
          "SELECT u.id FROM station_units u LEFT JOIN station_calls c ON c.id=u.call_id WHERE u.session_id=? AND u.state!='stopped' AND (? IS NULL OR c.attempt_id=?)",
        )
        .all(session, attempt ?? null, attempt ?? null)
        .map((r) => 'station-unit:' + r.id),
    ];
  }
  async close(): Promise<void> {
    this.closing = true;
    this.proven = false;
    for (const c of this.files.values()) c.abort();
    const results = await Promise.allSettled([
      ...this.store.db
        .prepare("SELECT id FROM station_units WHERE state!='stopped'")
        .all()
        .map((r) => this.stopUnit(String(r.id))),
      ...this.store.db
        .prepare("SELECT id FROM station_calls WHERE helper_state NOT IN ('none','stopped')")
        .all()
        .map((r) => this.stopHelper(String(r.id))),
    ]);
    await Promise.allSettled([...this.jobs.values()]);
    this.unregister();
    if (results.some((r) => r.status === 'rejected')) stationUnavailable();
  }
}
