import { BoardReads } from './board-reads.js';
import { takeImages } from './mentions.js';
import { HostBreaker, callThroughBreaker } from './host-breaker.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, writeFileSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  canonical,
  object,
  ServiceError,
  textDigest,
  workerTools,
  workerCapabilities,
  type CodingBinding,
  string,
  type Manifest,
  type Session,
} from './protocol.js';
import {
  PI_CLI,
  HOUSE_EXTENSION,
  POLICY_DIGEST,
  bundleDigest,
  VERSION,
  PI_VERSION,
} from './config.js';
import { readinessFingerprint } from './readiness-fingerprint.js';
import { PiProcess, PiCommandError } from './pi.js';
import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
import type { McpWork, McpWorkerBinding } from './mcp-work.js';
import type { StationWork, StationBinding } from './station-work.js';
import type { ToolkitWork, ToolkitWorkerBinding } from './toolkit-work.js';
import { mergeMcpProvenance, type McpServerProvenance, type OperatorMcp } from './operator-mcp.js';
import type { ChildWork } from './children.js';
import {
  OFFLINE_ROUTE,
  providerRoute,
  providerHasOutputCap,
  type ProviderRoute,
} from './provider-config.js';
import type { TaskContext, Compaction } from './task-context.js';
import { validateApiKey } from './credentials.js';
import { resolveProviderAuth } from './provider-auth.js';
import { bindProviderConfiguration } from './provider-model.js';
import { validateProviderPayload } from './provider-payload.js';
import { digest } from './protocol.js';
import { readLocalWorkspace } from './local-workspace.js';
import type { CodingWork } from './coding.js';
import type { TaskLimits } from './task-policy.js';
import { repositoryPath, type RepositorySnapshots } from './repository-snapshots.js';
import type { TeamWork } from './team-work.js';
import {
  acpFailure,
  credentialStrings,
  parseAcpFailure,
  providerOutcome,
  redactFailureText,
  toolMetadata,
  type AttemptOutcome,
} from './acp-outcome.js';

export interface Launch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export interface SupervisorOptions {
  stateDir: string;
  bridgeSocket: string;
  startupTimeout?: number;
  heartbeatTimeout?: number;
  launch?: (launch: Launch) => PiProcess;
  extensionPath?: string;
  effectsEnabled?: boolean;
  providerRoute?: ProviderRoute;
  anthropicApiKey?: string;
  providerCredentials?: import('@earendil-works/pi-ai').CredentialStore;
  providerEnvironment?: NodeJS.ProcessEnv;
}
interface Worker {
  mcp?: McpWorkerBinding;
  operatorMcp?: McpServerProvenance[];
  mcpServers?: McpServerProvenance[];
  toolkit?: ToolkitWorkerBinding;
  station?: StationBinding;
  secrets?: string[];
  route: ProviderRoute;
  providerOutputCap?: boolean;
  id: string;
  epoch: number;
  token: string;
  frame: string;
  binding: string;
  compaction?: string;
  bundle: string;
  ready: boolean;
  invalid: string | null;
  stopping: boolean;
  pi?: PiProcess;
  manifest?: Manifest;
  lastBeat: number;
  busy: boolean;
  attempt?: string;
  handshake: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}
export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'linux') {
      // /proc stat field 22 is the boot-relative start tick. Pair it with boot,
      // process group, executable and argv, and re-read to reject PID reuse mid-snapshot.
      const path = `/proc/${pid}`;
      const stat = () => {
        const value = readFileSync(path + '/stat', 'utf8');
        const end = value.lastIndexOf(') ');
        if (end < 0 || !value.startsWith(pid + ' (')) throw Error('Invalid process stat');
        const fields = value
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        if (!/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[2] ?? ''))
          throw Error('Invalid process start identity');
        return { start: fields[19], group: fields[2], session: fields[3] };
      };
      const before = stat(),
        boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        // A tools-user launcher (sudo) is root-owned; its exe link is unreadable to the service.
        executable = (() => {
          try {
            return readlinkSync(path + '/exe');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EACCES') return 'unreadable';
            throw error;
          }
        })(),
        argv = readFileSync(path + '/cmdline');
      if (
        !/^[a-f0-9-]{36}$/.test(boot) ||
        !argv.length ||
        argv.length > 16384 ||
        canonical(before) !== canonical(stat())
      )
        return null;
      return (
        'linux-proc-v1:' +
        textDigest(canonical({ pid, boot, ...before, executable, argv: argv.toString('base64') }))
      );
    }
    return (
      execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        killSignal: 'SIGKILL',
        maxBuffer: 16384,
      }).trim() || null
    );
  } catch {
    return null;
  }
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
export class Supervisor extends EventEmitter {
  localCoding?: import('./local-coding.js').LocalCoding;
  /** Built-in web search and fetch for interactive coding (operator ruling 2026-10-31). */
  web?: import('./web-search.js').WebSearch;
  tasks!: TaskContext;
  private compactionJobs = new Set<Promise<void>>();
  private readonly fetchBreaker = new HostBreaker();
  managed?: ManagedWork;
  mcp?: McpWork;
  operatorMcp?: OperatorMcp;
  /** Item 9: the host's pinned persona, given to every worker on this host. */
  persona?: import('./persona.js').Persona;
  toolkit?: ToolkitWork;
  station?: StationWork;
  children?: ChildWork;
  coding?: CodingWork;
  repositories?: RepositorySnapshots;
  team?: TeamWork;
  routeFor(id: string): ProviderRoute {
    const child = this.children?.owned(id);
    return child
      ? (this.store.workerBoundary.view(child.id).binding.agent?.route ?? this.route)
      : this.store.localWorkspace(id)
        ? (this.store.providerRoute(id) ?? this.route)
        : this.route;
  }
  async prepareProviderRoute(input: ProviderRoute) {
    const route = structuredClone(input);
    if (route.provider === 'salaam-proof') return { route, output_cap: true, auth: undefined };
    const auth =
      route.provider === 'anthropic' && this.apiKey
        ? { auth: { apiKey: this.apiKey }, env: {} }
        : await resolveProviderAuth(
            route,
            this.options.providerCredentials,
            this.options.providerEnvironment,
          );
    const bound = bindProviderConfiguration(route, auth);
    return { route: bound, output_cap: providerHasOutputCap(bound, auth), auth };
  }
  private codingBinding(id: string): CodingBinding | undefined {
    const child = this.children?.owned(id),
      coding = this.coding?.binding(id);
    if (!child) return coding;
    const binding = this.store.workerBoundary.view(child.id).binding;
    return binding.isolation && coding
      ? {
          ...coding,
          files: binding.tools.includes('salaam_files'),
          commands: coding.commands && binding.tools.includes('salaam_command'),
        }
      : undefined;
  }
  private tools(id: string): string[] {
    const child = this.children?.owned(id);
    if (child) return JSON.parse(child.authority) as string[];
    return workerTools(
      !!this.options.effectsEnabled,
      !!this.children?.owned(id),
      this.codingBinding(id),
      undefined,
      !!this.mcp,
      !!this.toolkit,
      !!this.station,
      this.store.localWorkspace(id),
      this.store.localCoding(id),
      this.declaredMcp(id),
    );
  }
  /** Operator-declared MCP reaches root sessions only; children get no MCP authority. */
  private declaredMcp(id: string): boolean {
    return !!this.operatorMcp && !this.operatorMcp.empty && !this.children?.owned(id);
  }
  /** Every MCP server the session got, from both sources; persisted beside the worker. */
  mcpServers(id: string): McpServerProvenance[] | undefined {
    const live = this.workers.get(id)?.mcpServers;
    if (live) return structuredClone(live);
    try {
      const path = join(this.options.stateDir, 'workers', id, 'mcp-servers.json');
      return existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as McpServerProvenance[])
        : undefined;
    } catch {
      return undefined;
    }
  }
  private childBoundary(id: string, epoch: number) {
    const child = this.children?.owned(id);
    return child ? this.store.workerBoundary.assert(child, epoch, this.routeFor(id)) : undefined;
  }
  readonly route: ProviderRoute;
  private apiKey?: string;
  private outputCap = true;
  private authInitialized = false;
  providerCapabilities() {
    return {
      output_token_cap: this.outputCap,
      durable_tasks: true,
      warning: this.outputCap
        ? null
        : 'No provider-enforced output cap; tasks must explicitly disable token budgeting',
    };
  }
  assertTaskProviderSupported(limits: TaskLimits, outputCap = this.outputCap) {
    if (!outputCap && (limits.token_units !== null || limits.output_token_bound !== null))
      throw new ServiceError(
        'provider_capability',
        'This provider authentication has no output cap; set limits.token_units to null and omit output_token_bound',
      );
  }
  assertSessionProviderSupported(id: string, outputCap = this.outputCap) {
    const parent = this.children?.owned(id)?.parent_session ?? id;
    const task = this.tasks.work?.forSession(parent);
    if (task) this.assertTaskProviderSupported(task.limits, outputCap);
  }
  readonly bootId = randomUUID();
  private workers = new Map<string, Worker>();
  private boardReadsStore?: BoardReads;
  get boardReads(): BoardReads {
    return (this.boardReadsStore ??= new BoardReads(this.store));
  }
  private monitor: NodeJS.Timeout;
  readonly bundle: string;
  constructor(
    readonly store: Store,
    readonly options: SupervisorOptions,
  ) {
    super();
    this.route = structuredClone(options.providerRoute ?? OFFLINE_ROUTE);
    // Validate public configuration without trusting programmatic callers.
    const checked = providerRoute(
      this.route.provider === 'salaam-proof' ? 'offline' : this.route.provider,
      this.route.provider !== 'salaam-proof' ? this.route.model : undefined,
      this.route.provider !== 'salaam-proof' ? this.route.max_tokens : undefined,
      this.route.workspace_id,
      this.route.connection,
      this.route.reasoning,
    );
    if (canonical(checked) !== canonical(this.route)) throw new Error('Invalid provider route');
    if (options.anthropicApiKey) this.apiKey = validateApiKey(options.anthropicApiKey);
    this.bundle = bundleDigest();
    this.monitor = setInterval(() => {
      for (const worker of this.workers.values())
        if (worker.ready) {
          if (Date.now() - worker.lastBeat > (options.heartbeatTimeout ?? 2500))
            this.invalidate(worker, 'Worker heartbeat expired');
          const child = this.children?.owned(worker.id);
          if (child?.state === 'accepted') {
            try {
              this.childBoundary(worker.id, worker.epoch);
            } catch (error) {
              this.invalidate(worker, 'Worker boundary revoked: ' + (error as Error).message);
            }
          }
        }
    }, 250);
    this.monitor.unref();
  }
  async providerAuth() {
    if (this.route.provider === 'salaam-proof') return undefined;
    if (this.route.provider === 'anthropic' && this.apiKey)
      return { auth: { apiKey: this.apiKey }, env: {} };
    const auth = await resolveProviderAuth(
      this.route,
      this.options.providerCredentials,
      this.options.providerEnvironment,
    );
    Object.assign(this.route, bindProviderConfiguration(this.route, auth));
    const outputCap = providerHasOutputCap(this.route, auth);
    if (this.authInitialized && this.outputCap !== outputCap)
      throw new Error(
        'Provider output-cap capability changed; restart the service before using the new authentication',
      );
    this.outputCap = outputCap;
    this.authInitialized = true;
    return auth;
  }
  async recover(): Promise<void> {
    const rows = this.store.db.prepare("SELECT * FROM workers WHERE state!='exited'").all() as {
      session_id: string;
      epoch: number;
      pid: number | null;
      identity: string | null;
    }[];
    for (const row of rows) {
      let error: string | null = null;
      if (row.pid === null || row.identity === null)
        error = 'Previous worker identity was not recorded; manual reconciliation required';
      else {
        const actual = processIdentity(row.pid);
        if (actual === row.identity) {
          try {
            process.kill(-row.pid, 'SIGKILL');
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
              error = 'Previous worker cannot be stopped';
          }
          for (let i = 0; i < 40 && groupExists(row.pid); i++)
            await new Promise((r) => setTimeout(r, 25));
        }
        if (groupExists(row.pid)) error = 'Previous worker group cannot be proven stopped';
      }
      // A mismatched live PID is never signalled. Its group still blocks reuse.
      this.store.state(
        row.session_id,
        row.epoch,
        error ? 'unhealthy' : 'exited',
        error ?? 'Service restart interrupted this worker',
      );
    }
  }
  async start(id: string): Promise<void> {
    this.store.execution.assert(id);
    const child = this.children?.owned(id);
    if (child && this.store.workerBoundary.view(child.id).binding.runtime !== 'native-pi')
      throw new ServiceError(
        'external_worker_owned',
        'Use the external worker lifecycle; Pi cannot claim this session',
      );
    const route = this.routeFor(id);
    const prior = this.workers.get(id);
    if (prior && !prior.stopping)
      throw new ServiceError('worker_exists', 'Worker already supervised');
    const previous = this.store.session(id);
    // A new worker must earn readiness again. Only a proven-dead previous
    // writer permits this; uncertain process ownership still blocks recovery.
    if (
      previous.state === 'unhealthy' &&
      this.store.db
        .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited' LIMIT 1")
        .get(id)
    )
      throw new ServiceError(
        'reconciliation_required',
        previous.error ?? 'Session requires reconciliation',
      );
    this.store.bindRoute(id, route);
    const epoch = this.store.allocate(id, this.bootId);
    let accept!: () => void;
    let reject!: (e: Error) => void;
    const handshake = new Promise<void>((a, b) => {
      accept = a;
      reject = b;
    });
    const binding = randomBytes(16).toString('hex');
    const frame = this.tasks.frame(id, binding);
    const worker: Worker = {
      route: structuredClone(route),
      id,
      epoch,
      token: randomBytes(32).toString('hex'),
      frame,
      binding,
      bundle: this.bundle,
      ready: false,
      invalid: null,
      stopping: false,
      lastBeat: Date.now(),
      busy: false,
      handshake,
      resolve: accept,
      reject,
    };
    this.workers.set(id, worker);
    worker.secrets = [worker.token, ...(this.apiKey ? [this.apiKey] : [])];
    // Attach a rejection handler before spawn/identity checks can fail.
    void handshake.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      const child = this.children?.owned(id);
      if (this.mcp && !child) worker.mcp = await this.mcp.ready(id);
      if (this.toolkit && !child) worker.toolkit = await this.toolkit.ready(id);
      if (this.declaredMcp(id)) worker.operatorMcp = this.operatorMcp!.provenance();
      if (worker.operatorMcp || worker.mcp) {
        // Collisions are refused at admission; nothing is silently shadowed.
        worker.mcpServers = mergeMcpProvenance(
          worker.operatorMcp ?? [],
          (worker.mcp?.servers ?? []).map((server) => ({
            name: server.name,
            source: 'agentpod' as const,
            transport: 'http' as const,
            endpoint_digest: server.endpoint_digest,
            declaration_digest: digest(server),
          })),
        );
      }
      if (this.station && !child) worker.station = this.station.ready(id);
      this.store.execution.assert(id);
      if (worker.stopping || worker.invalid) throw new Error('Worker startup cancelled');
      if (child) this.store.workerBoundary.claim(child, epoch, route);
      const workerDir = join(this.options.stateDir, 'workers', id);
      mkdirSync(join(workerDir, 'agent'), { recursive: true, mode: 0o700 });
      writeFileSync(
        join(workerDir, 'agent', 'settings.json'),
        JSON.stringify({
          compaction: { enabled: false, keepRecentTokens: 512, reserveTokens: 8192 },
        }),
        { mode: 0o600 },
      );
      const sessionDir = join(workerDir, 'sessions');
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      const provenancePath = join(workerDir, 'mcp-servers.json');
      if (worker.mcpServers)
        writeFileSync(provenancePath, JSON.stringify(worker.mcpServers, null, 2), { mode: 0o600 });
      else rmSync(provenancePath, { force: true });
      const config = {
        socket: this.options.bridgeSocket,
        token: worker.token,
        session: id,
        epoch,
        bundle: this.bundle,
        policy: POLICY_DIGEST,
        frame,
        effects: !!this.options.effectsEnabled && !this.children?.owned(id),
        child: !!this.children?.owned(id),
        worker_binding: this.childBoundary(id, epoch),
        route: route,
        coding: this.codingBinding(id),
        local: this.store.localWorkspace(id),
        localCoding: this.store.localCoding(id),
        ...(worker.mcp ? { mcp: worker.mcp } : {}),
        ...(worker.operatorMcp ? { operator_mcp: worker.operatorMcp } : {}),
        ...(worker.mcpServers ? { mcp_servers: worker.mcpServers } : {}),
        ...(worker.toolkit ? { toolkit: worker.toolkit } : {}),
        ...(worker.station ? { station: worker.station } : {}),
        ...(this.persona ? { persona: this.persona } : {}),
      };
      const args = [
        PI_CLI,
        '--mode',
        'rpc',
        '--session-id',
        id,
        '--session-dir',
        sessionDir,
        '--name',
        `salaam/${id}/${epoch}/${this.bootId}`,
        '--no-approve',
        '--no-extensions',
        '--extension',
        this.options.extensionPath ?? HOUSE_EXTENSION,
        '--no-mcp',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--no-context-files',
        '--no-builtin-tools',
        '--tools',
        this.tools(id).join(','),
        '--provider',
        route.provider,
        '--model',
        route.model,
      ];
      if (previous.pi_session_file && existsSync(previous.pi_session_file)) {
        const index = args.indexOf('--session-id');
        args.splice(index, 2, '--session', previous.pi_session_file);
      } else if (
        this.store.db
          .prepare("SELECT 1 FROM events WHERE session_id=? AND kind='model.admitted' LIMIT 1")
          .get(id)
      ) {
        throw new Error('Recorded Pi transcript is missing; reconciliation required');
      }
      // Do not inherit provider credentials or global Pi resource settings.
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: workerDir,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PI_CODING_AGENT_DIR: join(workerDir, 'agent'),
        SALAAM_WORKER_CONFIG: JSON.stringify(config),
        ...(route.connection?.configuration ?? {}),
      };
      worker.pi = (this.options.launch ?? ((x) => new PiProcess(x.command, x.args, x.cwd, x.env)))({
        command: process.execPath,
        args,
        cwd: previous.cwd,
        env,
      });
      worker.pi.on('fault', (error) => {
        if (!worker.stopping) this.invalidate(worker, 'Pi transport failed');
      });
      worker.pi.on('activity', (observation: import('./pi.js').ToolObservation) => {
        if (!worker.attempt || worker.stopping) return;
        try {
          this.store.request(
            `tool-activity:${id}:${epoch}:${worker.attempt}`,
            `${observation.phase}:${observation.tool_call_id}`,
            observation,
            () => {
              this.store.event(id, `tool.${observation.phase}`, {
                attempt_id: worker.attempt,
                worker_epoch: epoch,
                ...observation,
                ...(observation.phase === 'started'
                  ? toolMetadata(
                      observation.tool,
                      observation.input,
                      observation.tool === 'salaam_station'
                        ? this.station?.config.workspace
                        : this.coding?.workspaces.find(id)?.root,
                    )
                  : {}),
              });
              return { recorded: true };
            },
          );
        } catch {
          this.invalidate(worker, 'Required tool activity recording failed');
        }
      });
      worker.pi.on('record', (record) => {
        if (
          record.type === 'extension_ui_request' &&
          record.method === 'confirm' &&
          typeof record.id === 'string'
        ) {
          const marker =
            typeof record.title === 'string'
              ? /^salaam-approval:([a-f0-9-]{36}):([a-f0-9]{64})$/.exec(record.title)
              : null;
          try {
            if (!marker || !this.managed) {
              worker.pi!.replyUI(record.id, false);
              return;
            }
            this.managed.bindDialog(id, epoch, marker[1]!, marker[2]!, record.id);
          } catch {
            try {
              worker.pi!.replyUI(record.id, false);
            } catch {}
            if (!worker.stopping) this.invalidate(worker, 'Approval dialog binding failed');
          }
        }
        if (worker.attempt && record.type === 'message_update') {
          const update = object(record.assistantMessageEvent ?? {});
          if (update.type === 'text_delta' && typeof update.delta === 'string')
            this.emit('preview', {
              session_id: id,
              attempt_id: worker.attempt,
              text: update.delta,
            });
        }
        if (record.type === 'extension_error')
          this.invalidate(worker, 'Required extension reported an error');
        if (
          record.type === 'tool_execution_end' &&
          record.toolName === 'salaam_probe' &&
          record.isError === true
        )
          this.invalidate(worker, 'Required managed probe failed');
      });
      const pid = worker.pi.child.pid;
      if (!pid) throw new Error('Pi failed to spawn');
      const identity = processIdentity(pid);
      if (!identity) throw new Error('Pi process identity unavailable');
      this.store.process(id, epoch, pid, identity);
      const timeout = new Promise<never>((_a, b) => {
        timer = setTimeout(
          () => b(new Error('Worker readiness timed out')),
          this.options.startupTimeout ?? 15000,
        );
      });
      await Promise.race([handshake, timeout]);
      await worker.pi.command('set_auto_retry', { enabled: false });
      await worker.pi.command('set_auto_compaction', { enabled: false });
      const response = await worker.pi.command('get_state');
      const state = object(response.data);
      if (state.autoCompactionEnabled !== false)
        throw new Error('Pi automatic compaction is outside the current managed route');
      if (state.sessionId !== id) throw new Error('Pi state has the wrong session identity');
      const file = typeof state.sessionFile === 'string' ? resolve(state.sessionFile) : null;
      if (!file || !file.startsWith(resolve(sessionDir) + '/'))
        throw new Error('Pi session is outside its managed directory');
      if (object(state.model).provider !== route.provider || object(state.model).id !== route.model)
        throw new Error('Pi selected an unapproved provider route');
      if (worker.invalid) throw new Error(worker.invalid);
      // Pi buffers setup-only entries until there is a conversation. Do not
      // persist a cursor into that ephemeral tree before its file exists.
      if (existsSync(file)) await this.syncEntries(worker);
      this.store.execution.assert(id);
      if (child) this.store.workerBoundary.accepted(child, epoch, route);
      this.store.state(
        id,
        epoch,
        'ready',
        null,
        workerCapabilities(this.codingBinding(id), this.tools(id)),
        file,
        readinessFingerprint({
          session_id: id,
          worker_epoch: epoch,
          version: 1,
          harness: 'salaam',
          harness_version: VERSION,
          pi_version: PI_VERSION,
          bundle_digest: worker.bundle,
          policy_digest: POLICY_DIGEST,
          provider: route.provider,
          model: route.model,
          context_digest: textDigest(worker.frame),
          context_admission_digest: this.tasks.admitted?.currentDigest(id) ?? null,
          verification: 'pinned-readiness-handshake',
        }),
      );
      worker.ready = true;
      worker.lastBeat = Date.now();
    } catch (error) {
      this.invalidate(worker, (error as Error).message);
      await this.stopWorker(worker);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  private invalidate(worker: Worker, reason: string): void {
    if (worker.invalid) return;
    worker.invalid = reason;
    worker.ready = false;
    worker.reject(new Error(reason));
    try {
      this.managed?.invalidateWorker(worker.id, worker.epoch);
      this.cancelMcpWorker(worker);
      this.children?.workerLost(worker.id, reason);
    } catch {
      /* in-memory readiness denial fences new dispatch */
    }
    try {
      this.store.state(worker.id, worker.epoch, 'unhealthy', reason);
    } catch {
      /* in-memory denial remains authoritative if persistence fails */
    }
    if (worker.pi) void this.stopWorker(worker).catch(() => {});
  }
  private cancelMcpWorker(worker: Worker): void {
    if (this.station && worker.attempt) {
      this.store.transaction(() => this.station!.cancelInTransaction(worker.attempt!));
      void this.station.abortAttempt(worker.attempt).catch(() => {
        worker.invalid = 'Station stop is unconfirmed';
      });
    }
    if (this.toolkit && worker.attempt) {
      this.store.transaction(() => this.toolkit!.cancelInTransaction(worker.attempt!));
      this.toolkit.abortAttempt(worker.attempt);
    }
    if (this.mcp && worker.attempt) {
      this.store.transaction(() =>
        this.mcp!.cancelInTransaction(worker.attempt!, 'worker_unavailable'),
      );
      this.mcp.abortAttempt(worker.attempt);
    }
  }
  private authenticate(
    id: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ): Worker {
    const w = this.workers.get(id);
    if (
      !w ||
      !token ||
      Buffer.byteLength(token) !== Buffer.byteLength(w.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(w.token))
    )
      throw new ServiceError('unauthorized', 'Invalid worker credentials', 403);
    if (body.epoch !== w.epoch)
      throw new ServiceError('stale_worker', 'Worker epoch is no longer current', 403);
    try {
      this.store.assertEpoch(id, w.epoch);
    } catch (error) {
      this.invalidate(w, 'Worker epoch was revoked');
      throw error;
    }
    return w;
  }
  /** Is this attempt a task step that has acceptance checks to decide it? */
  /** A person's own local coding session: not a delegated child and not AgentPod-admitted work,
   * whose strict semantics stay as they are. */
  private interactiveCoding(id: string): boolean {
    return (
      this.store.localCoding(id) &&
      !this.children?.owned(id) &&
      !this.store.db.prepare('SELECT 1 FROM agentpod_admissions WHERE session_id=?').get(id)
    );
  }
  private checkedStepAttempt(attempt: string): boolean {
    const row = this.store.db
      .prepare('SELECT checks FROM task_steps WHERE attempt_id=?')
      .get(attempt) as { checks?: string } | undefined;
    try {
      const checks = row?.checks ? JSON.parse(String(row.checks)) : [];
      return Array.isArray(checks) && checks.length > 0;
    } catch {
      return false;
    }
  }
  /** A station call refused before it runs leaves no station_calls row, so record its
   * method, requested action and refusal code: never its path, arguments or content. */
  private recordStationRefusal(
    id: string,
    method: string,
    body: Record<string, unknown>,
    error: unknown,
  ): void {
    const args =
      body.args && typeof body.args === 'object' ? (body.args as Record<string, unknown>) : {};
    const ident = (v: unknown) =>
      typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) ? v : null;
    try {
      this.store.transaction(() =>
        this.store.event(id, 'station.call_refused', {
          attempt_id: this.workers.get(id)?.attempt ?? null,
          method: ident(method),
          action: ident(args.action),
          code: error instanceof ServiceError ? ident(error.code) : 'error',
        }),
      );
    } catch {
      // Recording a refusal never changes the refusal itself.
    }
  }
  async bridge(
    id: string,
    method: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const w = this.authenticate(id, token, body);
    const route = w.route;
    if (method === 'failure') {
      if (!w.stopping) this.invalidate(w, 'Required extension failed');
      return { ok: true };
    }
    if (w.invalid || w.stopping)
      throw new ServiceError('worker_unavailable', 'Worker is not available', 403);
    try {
      this.store.execution.assert(id);
      if (w.mcp) this.mcp!.assertBinding(id, w.mcp);
      if (w.toolkit) this.toolkit!.assertBinding(id, w.toolkit);
      if (w.station) this.station!.assertBinding(id, w.station);
    } catch (error) {
      this.invalidate(w, 'Session execution authority revoked');
      throw error;
    }
    if (method === 'handshake') {
      try {
        if (w.manifest) throw new Error('Duplicate handshake');
        const boundary = this.childBoundary(id, w.epoch);
        const expected = {
          protocol_version: PROTOCOL_VERSION,
          bundle_digest: w.bundle,
          policy_digest: POLICY_DIGEST,
          session_id: id,
          pi_session_id: id,
          epoch: w.epoch,
          capabilities: workerCapabilities(this.codingBinding(id), this.tools(id)),
          tools: this.tools(id),
          active_tools: this.tools(id),
          ...(this.codingBinding(id) ? { coding: this.codingBinding(id) } : {}),
          provider: route.provider,
          route: route,
          context_digest: textDigest(w.frame),
          ...(boundary ? { worker_binding: boundary } : {}),
          ...(w.mcp ? { mcp: w.mcp } : {}),
          ...(w.operatorMcp ? { operator_mcp: w.operatorMcp } : {}),
          ...(w.mcpServers
            ? { mcp_servers: w.mcpServers, mcp_servers_digest: digest(w.mcpServers) }
            : {}),
          ...(w.toolkit ? { toolkit: w.toolkit } : {}),
          ...(w.station ? { station: w.station } : {}),
          // Item 9: the worker proves it runs with the host's pinned persona.
          ...(this.persona ? { persona_digest: this.persona.digest } : {}),
        };
        for (const [key, value] of Object.entries(expected))
          if (canonical(body[key]) !== canonical(value))
            throw new Error(`Invalid readiness field: ${key}`);
        w.manifest = body as unknown as Manifest;
        w.resolve();
        return { ok: true };
      } catch (error) {
        this.invalidate(w, (error as Error).message);
        throw new ServiceError('readiness_rejected', (error as Error).message, 403);
      }
    }
    if (method === 'heartbeat') {
      w.lastBeat = Date.now();
      return { ok: true };
    }
    if (!w.ready || this.store.session(id).state !== 'ready')
      throw new ServiceError('not_ready', 'Worker has not passed readiness', 403);
    if (w.attempt && this.store.cancelled(w.attempt))
      throw new ServiceError('attempt_cancelled', 'Attempt cancellation revoked further grants');
    try {
      this.childBoundary(id, w.epoch);
      if (method.startsWith('team.')) {
        const child = this.children?.owned(id);
        if (!child || !this.team || !w.attempt) throw new Error('No owned team assignment');
        const binding = this.store.workerBoundary.view(child.id).binding;
        if (!binding.assignment || !binding.tools.includes('salaam_team'))
          throw new Error('No team message authority');
        const authorize = () => {
          this.assertActive(id, w.epoch, w.attempt!);
          this.team!.assert(binding);
          this.store.taskGrantCheck?.(id);
        };
        authorize();
        const request = string(body.request_id, 'request_id', 128),
          assignment = binding.assignment.id;
        if (method === 'team.send')
          return this.team.send(
            binding.owner_task!,
            assignment,
            string(body.recipient, 'recipient', 128),
            string(body.text, 'text', 4096),
            request,
            authorize,
          );
        if (method === 'team.receive') return this.team.receive(assignment, request, authorize);
        if (method === 'team.ack')
          return this.team.acknowledge(
            assignment,
            string(body.message_id, 'message_id', 128),
            request,
            authorize,
          );
        throw new ServiceError('invalid_field', 'Unknown team method', 400);
      }
      if (method === 'specialist.read' || method === 'specialist.report') {
        const child = this.children?.owned(id);
        if (!child || !this.repositories || !w.attempt)
          throw new Error('No active specialist assignment');
        this.assertActive(id, w.epoch, w.attempt);
        const binding = this.store.workerBoundary.view(child.id).binding;
        const tool = method === 'specialist.read' ? 'salaam_repository' : 'salaam_findings';
        if (!binding.tools.includes(tool)) throw new Error('Specialist authority is unavailable');
        this.store.taskGrantCheck?.(id);
        if (method === 'specialist.report') return this.repositories.report(binding, body.findings);
        const args = object(body.args);
        return this.store.request(
          `specialist-read:${id}:${w.epoch}`,
          string(body.tool_call_id, 'tool_call_id', 512),
          args,
          () => {
            const result = this.repositories!.read(binding, args);
            this.store.event(id, 'specialist.read', {
              attempt_id: w.attempt,
              snapshot_digest: binding.repository?.digest,
              argument_digest: digest(args),
              result_digest: digest(result),
            });
            return result;
          },
        );
      }
      if (method === 'provider.auth') {
        if (!this.children?.owned(id) && !this.store.localWorkspace(id)) {
          const auth = await this.providerAuth();
          if (canonical(this.route) !== canonical(route)) throw new Error('Provider route changed');
          w.providerOutputCap = this.outputCap;
          this.assertSessionProviderSupported(id, this.outputCap);
          return auth;
        }
        const prepared = await this.prepareProviderRoute(route);
        const expectedCap = this.children?.owned(id)
          ? this.store.workerBoundary.view(this.children.owned(id)!.id).binding.agent?.output_cap
          : (this.store.localOutputCap(id) ?? this.outputCap);
        if (
          canonical(prepared.route) !== canonical(route) ||
          (expectedCap ?? this.outputCap) !== prepared.output_cap
        )
          throw new Error('Provider capability or route changed; restart or renew admission');
        w.providerOutputCap = prepared.output_cap;
        this.assertSessionProviderSupported(id, prepared.output_cap);
        const auth = prepared.auth;
        w.secrets = [...new Set([...(w.secrets ?? []), ...credentialStrings(auth)])];
        return auth;
      }
      if (method.startsWith('operator_mcp.')) {
        if (!this.declaredMcp(id) || !w.operatorMcp || !w.attempt)
          throw new ServiceError('mcp_disabled', 'Worker has no declared MCP servers', 403);
        this.assertActive(id, w.epoch, w.attempt);
        if (method === 'operator_mcp.catalog')
          return await this.operatorMcp!.catalog(id, body.server, body.tool);
        if (method !== 'operator_mcp.call')
          throw new ServiceError('invalid_field', 'Unknown declared MCP method', 400);
        const attempt = w.attempt;
        const args = body.arguments ?? {};
        const server = String(body.server ?? ''),
          tool = String(body.tool ?? '');
        // A host failing again and again is paused briefly (never called, so no operator MCP call
        // is recorded); the agent gets a tool error and the run carries on.
        return await callThroughBreaker(
          this.fetchBreaker,
          id,
          args,
          (paused) =>
            this.store.transaction(() =>
              this.store.event(id, 'fetch.host_paused', { attempt_id: attempt, ...paused }),
            ),
          async () => {
            try {
              const result = await this.operatorMcp!.call(id, body.server, body.tool, args);
              this.store.transaction(() =>
                this.store.event(id, 'operator_mcp.call', {
                  attempt_id: attempt,
                  server,
                  tool,
                  argument_digest: digest(args),
                  outcome: result.is_error ? 'tool_error' : 'returned',
                  result_digest: digest(result),
                }),
              );
              return result;
            } catch (error) {
              this.store.transaction(() =>
                this.store.event(id, 'operator_mcp.call', {
                  attempt_id: attempt,
                  server,
                  tool,
                  argument_digest: digest(args),
                  outcome: 'failed',
                  error: (error as ServiceError).code ?? 'mcp_server_failed',
                }),
              );
              throw error;
            }
          },
        );
      }
      if (method.startsWith('toolkit.')) {
        if (!this.toolkit || !w.toolkit || !w.attempt || this.children?.owned(id))
          throw new ServiceError('toolkit_disabled', 'Worker has no native Toolkit authority', 403);
        this.assertActive(id, w.epoch, w.attempt);
        this.toolkit.assertBinding(id, w.toolkit);
        this.store.taskGrantCheck?.(id);
        if (method === 'toolkit.catalog')
          return this.toolkit.catalog(
            id,
            w.toolkit,
            body.category === undefined ? undefined : string(body.category, 'category', 128),
            body.action === undefined ? undefined : string(body.action, 'action', 128),
          );
        if (!['toolkit.prepare', 'toolkit.run', 'toolkit.status'].includes(method))
          throw new ServiceError('invalid_field', 'Unsupported native Toolkit action', 400);
        const call =
          method === 'toolkit.prepare'
            ? this.toolkit.prepare(
                id,
                w.epoch,
                w.attempt,
                string(body.tool_call_id, 'tool_call_id', 512),
                body.args,
              )
            : this.toolkit.calls.get(string(body.call_id, 'call_id', 128));
        if (
          call.session_id !== id ||
          call.worker_epoch !== w.epoch ||
          call.attempt_id !== w.attempt
        )
          throw new ServiceError(
            'mcp_call_scope',
            'Native Toolkit call belongs to another invocation',
            403,
          );
        if (method === 'toolkit.run') this.toolkit.start(call.id, id, w.epoch, w.attempt);
        return this.toolkit.view(call.id);
      }
      if (method.startsWith('mcp.')) {
        if (!this.mcp || !w.mcp || !w.attempt || this.children?.owned(id))
          throw new ServiceError('mcp_disabled', 'Worker has no managed MCP authority', 403);
        this.assertActive(id, w.epoch, w.attempt);
        this.mcp.assertBinding(id, w.mcp);
        this.store.taskGrantCheck?.(id);
        if (method === 'mcp.catalog')
          return this.mcp.describe(
            id,
            w.mcp,
            body.server === undefined ? undefined : string(body.server, 'server', 128),
            body.tool === undefined ? undefined : string(body.tool, 'tool', 128),
          );
        const call =
          method === 'mcp.prepare'
            ? this.mcp.prepare(
                id,
                w.epoch,
                w.attempt,
                string(body.tool_call_id, 'tool_call_id', 512),
                body.args,
              )
            : this.mcp.get(string(body.call_id, 'call_id', 128));
        if (
          call.session_id !== id ||
          call.worker_epoch !== w.epoch ||
          call.attempt_id !== w.attempt
        )
          throw new ServiceError('mcp_call_scope', 'MCP call belongs to another invocation', 403);
        if (!['mcp.prepare', 'mcp.run', 'mcp.status'].includes(method))
          throw new ServiceError('invalid_field', 'Unsupported MCP action', 400);
        const current =
          method === 'mcp.run' ? this.mcp.start(call.id, id, w.epoch, w.attempt) : call;
        return {
          call: current,
          result: current.result_artifact
            ? JSON.parse(this.mcp.artifacts.read(current.result_artifact))
            : null,
          ...(current.operation_id && this.managed
            ? {
                operation: this.managed.operation(current.operation_id),
                approval: this.managed.forOperation(current.operation_id),
              }
            : {}),
        };
      }
      if (method === 'board.read' || method === 'board.status') {
        // Read-only board reads, served by the hub (operator ruling 2026-10-28, option iii).
        if (!this.station || !w.station || !w.attempt || this.children?.owned(id))
          throw new ServiceError('station_disabled', 'Board reads need protected station work');
        this.assertActive(id, w.epoch, w.attempt);
        return method === 'board.read'
          ? this.boardReads.request(
              id,
              string(body.tool_call_id, 'tool_call_id', 512),
              object(body.args),
            )
          : this.boardReads.get(id, string(body.read_id, 'read_id', 64));
      }
      if (method.startsWith('station.')) {
        if (!this.station || !w.station || !w.attempt || this.children?.owned(id))
          throw new ServiceError('station_disabled', 'Station execution is unavailable');
        this.assertActive(id, w.epoch, w.attempt);
        this.store.taskGrantCheck?.(id);
        if (method === 'station.read')
          return this.station.read(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            object(body.args),
          );
        if (method === 'station.prepare')
          return this.station.prepare(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            object(body.args),
          );
        const c = this.station.get(string(body.call_id, 'call_id', 128));
        if (c.session_id !== id || c.worker_epoch !== w.epoch || c.attempt_id !== w.attempt)
          throw new ServiceError(
            'station_scope',
            'Station call belongs to another invocation',
            403,
          );
        if (method === 'station.run') return this.station.run(c.id);
        if (method === 'station.status') return this.station.view(c.id);
        throw new ServiceError('invalid_field', 'Unsupported station method');
      }
      if (method === 'web.search' || method === 'web.fetch') {
        if (!this.web || !this.store.localCoding(id) || this.children?.owned(id) || !w.attempt)
          throw new ServiceError('web_denied', 'Web search is not admitted for this session', 403);
        this.assertActive(id, w.epoch, w.attempt);
        const args = object(body.args);
        const toolCallId = string(body.tool_call_id, 'tool_call_id', 512);
        if (method === 'web.search') {
          const out = await this.web.search({
            query: string(args.query, 'query', 300),
            ...(typeof args.kind === 'string'
              ? { kind: args.kind as import('./web-search.js').SearchKind }
              : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          });
          // Recorded: kind, backends tried, which answered and how long. Never a key or the query.
          this.store.transaction(() =>
            this.store.event(id, 'web.search', {
              attempt_id: w.attempt,
              tool_call_id: toolCallId,
              kind: out.kind,
              cached: !!out.cached,
              results: out.results.length,
              tried: out.tried,
            }),
          );
          return out;
        }
        const url = string(args.url, 'url', 2000);
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          /* fetchPage refuses it */
        }
        try {
          const page = await (await import('./web-fetch.js')).fetchPage(url);
          this.store.transaction(() =>
            this.store.event(id, 'web.fetch', {
              attempt_id: w.attempt,
              tool_call_id: toolCallId,
              host,
              status: page.status,
              chars: page.text.length,
              truncated: page.truncated,
            }),
          );
          const { renderFetched } = await import('./web-fetch.js');
          return { ok: true, url: page.url, text: renderFetched(page) };
        } catch (error) {
          const message = String((error as Error).message ?? error).slice(0, 300);
          this.store.transaction(() =>
            this.store.event(id, 'web.fetch', {
              attempt_id: w.attempt,
              tool_call_id: toolCallId,
              host,
              error: message,
            }),
          );
          return { ok: false, url, error: message };
        }
      }
      if (method.startsWith('local.') && method !== 'local.read') {
        if (
          !this.localCoding ||
          !this.store.localCoding(id) ||
          this.children?.owned(id) ||
          !w.attempt
        )
          throw new ServiceError('local_denied', 'Local coding is not admitted', 403);
        this.assertActive(id, w.epoch, w.attempt);
        if (method === 'local.prepare')
          return this.localCoding.prepare(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            object(body.args),
          );
        const c = this.localCoding.get(string(body.call_id, 'call_id'));
        if (c.session_id !== id || c.epoch !== w.epoch || c.attempt_id !== w.attempt)
          throw new ServiceError('local_scope', 'Operation belongs to another invocation', 403);
        if (method === 'local.run') return this.localCoding.run(c.id);
        if (method === 'local.status') return this.localCoding.view(c.id);
        throw new ServiceError('invalid_field', 'Unsupported local method');
      }
      if (method === 'local.read') {
        if (!this.store.localWorkspace(id) || this.children?.owned(id) || !w.attempt)
          throw new ServiceError('workspace_denied', 'Local workspace is not admitted', 403);
        this.assertActive(id, w.epoch, w.attempt);
        this.store.taskGrantCheck?.(id);
        const args = object(body.args);
        const result = readLocalWorkspace(this.store.session(id).cwd, args);
        this.store.transaction(() =>
          this.store.event(id, 'workspace.read', {
            attempt_id: w.attempt,
            tool_call_id: string(body.tool_call_id, 'tool_call_id', 512),
            argument_digest: digest(args),
            result_digest: digest(result),
          }),
        );
        return result;
      }
      if (method === 'coding.files' || method === 'coding.command') {
        if (!this.coding || !this.codingBinding(id) || !w.attempt)
          throw new Error('Coding authority is unavailable');
        this.assertActive(id, w.epoch, w.attempt);
        this.store.taskGrantCheck?.(id);
        const args = object(body.args);
        if (method === 'coding.files') {
          if (!this.codingBinding(id)?.files) throw new Error('File authority is unavailable');
          if (this.children?.owned(id) && args.path !== undefined) repositoryPath(args.path);
          return this.coding.file(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            args,
          );
        }
        if (!this.codingBinding(id)?.commands) throw new Error('Command execution is unavailable');
        if (args.action === 'start')
          return this.coding.start(id, w.attempt, args, () =>
            this.assertActive(id, w.epoch, w.attempt!),
          );
        const run = string(args.run_id, 'run_id', 128);
        if (args.action === 'status') return this.coding.get(id, run);
        if (args.action === 'logs') return this.coding.logs(id, run, Number(args.offset ?? 0));
        if (args.action === 'cancel')
          return this.coding.cancel(id, run, string(body.tool_call_id, 'tool_call_id', 512), () =>
            this.assertActive(id, w.epoch, w.attempt!),
          );
        throw new ServiceError('invalid_field', 'Unsupported command action', 400);
      }
      if (
        method === 'operation.prepare' ||
        method === 'operation.status' ||
        method === 'operation.run'
      ) {
        if (this.children?.owned(id))
          throw new Error('Child operation authority is read-only probe only');
        if (!this.managed || !w.attempt) throw new Error('No active managed attempt');
        this.assertActive(id, w.epoch, w.attempt);
        if (method === 'operation.prepare') {
          if (body.kind !== 'review' && body.kind !== 'effect')
            throw new Error('Unsupported operation kind');
          if (body.kind === 'effect' && !this.options.effectsEnabled)
            throw new Error('Effects are disabled');
          return await this.managed.prepare(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            body.kind,
            string(body.target, 'target', 256),
            string(body.value, 'value', 4096),
          );
        }
        const op = this.managed.operation(string(body.operation_id, 'operation_id', 128));
        if (op.session_id !== id || op.worker_epoch !== w.epoch || op.attempt_id !== w.attempt)
          throw new Error('Operation belongs to another invocation');
        return method === 'operation.run' ? this.managed.start(op.id, id, w.epoch, w.attempt) : op;
      }
      if (method.startsWith('child.')) {
        if (!this.children || !w.attempt) throw new Error('No active parent attempt');
        // spawn() resolves a saved step before testing a fresh invocation/grant.
        if (method !== 'child.spawn') this.assertActive(id, w.epoch, w.attempt);
        if (method === 'child.spawn') {
          if (
            Object.keys(body).some(
              (key) =>
                !['epoch', 'step_key', 'prompt', 'budget', 'authority', 'profile'].includes(key),
            )
          )
            throw new ServiceError('invalid_child', 'Unsupported child admission field');
          return this.children.spawn(
            id,
            w.epoch,
            w.attempt,
            string(body.step_key, 'step_key', 128),
            string(body.prompt, 'prompt', 32768),
            Number(body.budget),
            Array.isArray(body.authority)
              ? body.authority.map((x) => string(x, 'authority', 128))
              : body.profile
                ? []
                : ['salaam_probe'],
            body.profile === undefined ? undefined : string(body.profile, 'profile', 128),
          );
        }
        if (method === 'child.list') return this.children.list(id);
        const child = string(body.child_id, 'child_id', 128);
        if (method === 'child.inspect') return this.children.inspect(id, child);
        const result = string(body.result_id, 'result_id', 128);
        if (method === 'child.consume') return this.children.consume(id, child, result);
        if (method === 'child.ack')
          return this.children.acknowledge(
            id,
            child,
            result,
            string(body.request_id, 'request_id', 128),
          );
        throw new Error('Unsupported child operation');
      }
      if (method === 'context')
        return { frame: this.tasks.frame(id, w.binding), version: this.tasks.state(id).version };
      if (method === 'history') return this.tasks.history(id, body);
      if (method === 'compaction.plan') {
        if (!w.compaction || w.attempt) throw new Error('No managed compaction grant');
        const work = this.tasks.compaction(w.compaction);
        if (
          work.state !== 'running' ||
          work.epoch !== w.epoch ||
          work.task_version !== this.tasks.state(id).version
        )
          throw new Error('Compaction grant is stale');
        return {
          id: work.id,
          task_version: work.task_version,
          summary:
            'Salaam task checkpoint. Earlier conversation is available through salaam_history. Explicit facts below are authoritative; superseded facts remain historical.\n' +
            this.tasks.frame(id, w.binding),
        };
      }
      if (method === 'usage') {
        const source = this.store.db
          .prepare('SELECT session_id,attempt_id FROM usage_observations WHERE source_key=?')
          .get(String(body.source_key));
        if (!source || source.session_id !== id || source.attempt_id !== (w.attempt ?? null))
          throw new Error('Usage does not belong to this request');
        this.store.transaction(() =>
          this.store.usage.observe(
            id,
            string(body.source_key, 'source_key', 256),
            route.provider,
            route.model,
            body.usage,
            route.provider !== 'salaam-proof' ? 'estimated' : 'known',
          ),
        );
        return { ok: true };
      }
      if (method === 'model') {
        this.coding?.assertSafe(id);
        this.store.taskGrantCheck?.(id);
        if (
          body.provider !== route.provider ||
          body.model !== route.model ||
          body.context_digest !== textDigest(this.tasks.frame(id, w.binding))
        )
          throw new Error('Provider or task context is invalid');
        if (route.provider !== 'salaam-proof') {
          if (w.providerOutputCap === undefined)
            throw new Error('Provider authentication was not admitted');
          this.assertSessionProviderSupported(id, w.providerOutputCap);
          validateProviderPayload(
            body.payload,
            route,
            this.tasks.frame(id, w.binding),
            this.tools(id),
            !w.providerOutputCap,
          );
          if (body.payload_digest !== digest(body.payload))
            throw new Error('Provider payload digest changed');
        }
        if (route.provider === 'salaam-proof') {
          const payload = object(body.payload);
          if (!Array.isArray(payload.messages)) throw new Error('Proof payload missing');
          const last = object(payload.messages.at(-1));
          const text =
            typeof last.content === 'string'
              ? last.content
              : Array.isArray(last.content)
                ? last.content
                    .map((x) => (object(x).type === 'text' ? object(x).text : ''))
                    .join('')
                : '';
          if (
            last.role !== 'user' ||
            text !== this.tasks.frame(id, w.binding) ||
            body.payload_digest !== digest(payload)
          )
            throw new Error('Proof task payload is stale or invalid');
        }
        this.store.usage.admit(
          id,
          w.attempt,
          string(body.source_key, 'source_key', 256),
          String(body.provider),
          String(body.model),
          { input: Buffer.byteLength(JSON.stringify(body.payload)), output: route.max_tokens },
        );
        this.store.transaction(() => {
          this.store.event(id, 'model.admitted', {
            attempt_id: w.attempt ?? null,
            epoch: w.epoch,
            provider: body.provider,
            context_digest: body.context_digest,
            context_admission_digest: this.tasks.admitted?.currentDigest(id) ?? null,
            payload_digest: body.payload_digest,
            task_version: this.tasks.state(id).version,
          });
        });
      } else if (method === 'policy' || method === 'tool') {
        this.tasks.admitted?.assertFresh(id);
        this.store.taskGrantCheck?.(id);
        if (!this.tools(id).includes(String(body.tool))) throw new Error('Tool is outside policy');
        this.store.transaction(() => {
          this.store.event(id, method === 'tool' ? 'tool.granted' : 'policy.allowed', {
            attempt_id: w.attempt ?? null,
            epoch: w.epoch,
            tool: body.tool,
          });
        });
      } else throw new Error('Unsupported worker operation');
      return { ok: true };
    } catch (error) {
      this.store.taskBudgetDenied?.(id, error);
      if (method.startsWith('station.')) this.recordStationRefusal(id, method, body, error);
      if (
        method.startsWith('station.') &&
        error instanceof ServiceError &&
        [
          'invalid_field',
          'request_conflict',
          'station_files_changed',
          'station_scope',
          'station_call_limit',
          'station_busy',
          'not_found',
        ].includes(error.code)
      )
        throw error;
      if (
        method.startsWith('operator_mcp.') &&
        error instanceof ServiceError &&
        [
          'invalid_field',
          'invalid_mcp_server',
          'invalid_mcp_tool',
          'invalid_mcp_arguments',
          'mcp_server_failed',
        ].includes(error.code)
      )
        throw error;
      if (
        (method.startsWith('mcp.') || method.startsWith('toolkit.')) &&
        error instanceof ServiceError &&
        [
          'invalid_field',
          'invalid_mcp_call',
          'invalid_mcp_arguments',
          'invalid_mcp_server',
          'invalid_mcp_tool',
          'mcp_tool_unadmitted',
          'mcp_input_limit',
          'mcp_call_limit',
          'invalid_toolkit_request',
          'toolkit_busy',
          'request_conflict',
        ].includes(error.code)
      )
        throw error;
      if (
        method.startsWith('specialist.') &&
        error instanceof ServiceError &&
        [
          'not_found',
          'binary_file',
          'line_limit',
          'invalid_field',
          'local_busy',
          'workspace_read_failed',
          'unsafe_path',
          'request_conflict',
        ].includes(error.code)
      )
        throw error;
      if (
        (method.startsWith('coding.') || method.startsWith('local.')) &&
        error instanceof ServiceError &&
        [
          'local_busy',
          'workspace_read_failed',
          'unsafe_path',
          'workspace_changed',
          'workspace_busy',
          'workspace_limit',
          'workspace_conflict',
          'not_found',
          'binary_file',
          'line_limit',
          'invalid_field',
          'request_conflict',
          'command_conflict',
          'command_limit',
          'invalid_cursor',
        ].includes(error.code)
      )
        throw error;
      if (
        method === 'history' &&
        error instanceof ServiceError &&
        ['not_found', 'invalid_field'].includes(error.code)
      )
        throw error;
      if (
        method.startsWith('child.') &&
        error instanceof ServiceError &&
        [
          'budget_exhausted',
          'child_limit',
          'depth_exceeded',
          'authority_denied',
          'spawn_conflict',
          'invalid_budget',
          'invalid_child',
          'result_unavailable',
          'not_found',
          'request_conflict',
        ].includes(error.code)
      )
        throw error;
      if (!w.stopping) this.invalidate(w, 'Required control failed: ' + (error as Error).message);
      throw new ServiceError('control_failed', 'Required control unavailable', 503);
    }
  }
  inspect(id: string): Session {
    if (this.store.execution.revocation(id)) {
      const session = this.store.session(id);
      return {
        ...session,
        state: ['starting', 'ready'].includes(session.state) ? 'unhealthy' : session.state,
        capabilities: [],
        error: 'Session execution authority revoked',
      };
    }
    const externalChild = this.children?.owned(id);
    if (externalChild && this.store.workerBoundary.view(externalChild.id).binding.external)
      return this.store.session(id);
    const child = this.children?.owned(id);
    const cap = child
      ? this.store.workerBoundary.view(child.id).binding.agent?.output_cap
      : this.store.localWorkspace(id)
        ? this.store.localOutputCap(id)
        : undefined;
    const state = {
      ...this.store.session(id),
      provider_route: this.store.providerRoute(id) ?? undefined,
      project_instructions: this.tasks.instructions?.summary(id) ?? undefined,
      provider_capabilities:
        cap === undefined
          ? this.providerCapabilities()
          : {
              output_token_cap: cap,
              durable_tasks: true,
              warning: cap
                ? null
                : 'No provider-enforced output cap; tasks must explicitly disable token budgeting',
            },
      ...(this.mcpServers(id) ? { mcp_servers: this.mcpServers(id) } : {}),
    };
    const w = this.workers.get(id);
    if (w?.invalid) return { ...state, state: 'unhealthy', capabilities: [], error: w.invalid };
    if (state.state === 'ready' && (!w?.ready || w.stopping))
      return {
        ...state,
        state: 'unhealthy',
        capabilities: [],
        error: 'No ready supervised worker; reconciliation required',
      };
    if (w && w.epoch !== state.epoch)
      return {
        ...state,
        state: 'unhealthy',
        capabilities: [],
        error: 'Worker epoch changed; reconciliation required',
      };
    return state;
  }
  assertActive(id: string, epoch: number, attempt: string): void {
    this.tasks.admitted?.assertFresh(id);
    this.store.execution.assert(id);
    const w = this.workers.get(id);
    if (
      !w ||
      !w.ready ||
      w.invalid ||
      w.stopping ||
      w.epoch !== epoch ||
      w.attempt !== attempt ||
      this.store.assertEpoch(id, epoch).state !== 'ready' ||
      this.store.cancelled(attempt)
    )
      throw new ServiceError('invocation_inactive', 'Worker no longer owns this invocation');
  }
  replyUI(id: string, epoch: number, request: string, confirmed: boolean): void {
    const w = this.workers.get(id);
    if (!w || w.epoch !== epoch || w.stopping || w.invalid) return;
    w.pi?.replyUI(request, confirmed);
  }
  failControl(id: string, error: Error): void {
    const w = this.workers.get(id);
    if (w) this.invalidate(w, 'Managed control failed: ' + error.message);
  }
  async steer(
    id: string,
    request: string,
    text: string,
    controller: import('./protocol.js').Controller,
  ) {
    const input = { kind: 'steer', id, text };
    const saved = this.store.cachedRequest<{ state: string }>('local-operator', request, input);
    if (saved) return saved;
    const worker = this.workers.get(id);
    const intent = this.store.request('local-operator', request, input, () => {
      this.store.authorizeControl(id, controller);
      this.store.execution.assert(id);
      if (
        !this.store.localWorkspace(id) ||
        !worker?.ready ||
        worker.invalid ||
        worker.stopping ||
        !worker.pi ||
        !worker.busy ||
        !worker.attempt
      )
        throw new ServiceError(
          'steer_unavailable',
          'Steering requires an active local model turn; use /queue for the next turn',
        );
      if (this.store.hasUnknown(id))
        throw new ServiceError('outcome_unknown', 'Resolve uncertain work before steering');
      if (this.store.attempt(worker.attempt).state !== 'running')
        throw new ServiceError('steer_unavailable', 'The active attempt is no longer running');
      const receipt = { state: 'delivery_unknown', attempt: worker.attempt, epoch: worker.epoch };
      this.store.event(id, 'steering.saved', { ...receipt, text }, request);
      return receipt;
    });
    try {
      await worker!.pi!.command('steer', { message: text });
      return this.store.transaction(() => {
        const receipt = { ...intent, state: 'received' };
        this.store.event(id, 'steering.received', receipt, request);
        this.store.db
          .prepare('UPDATE requests SET response=? WHERE actor=? AND id=?')
          .run(JSON.stringify(receipt), 'local-operator', request);
        return receipt;
      });
    } catch (error) {
      // The worker may have received it. Never retry this message across reconnect/restart.
      this.store.transaction(() =>
        this.store.event(id, 'steering.delivery_unknown', intent, request),
      );
      throw new ServiceError(
        'steer_delivery_unknown',
        'Steering receipt was lost. Inspect history; this steering request will not be replayed.',
      );
    }
  }
  async cancelAttempt(attempt: string): Promise<void> {
    const work = this.store.attempt(attempt);
    const w = this.workers.get(work.session_id);
    if (!w?.pi || w.attempt !== attempt) return;
    const settled = w.pi.waitFor('agent_settled', 5000);
    void settled.catch(() => {});
    try {
      await w.pi.command('abort', {}, 5000);
      await settled;
    } catch {
      await this.stopWorker(w);
    }
  }
  attemptActive(attempt: string): boolean {
    const work = this.store.attempt(attempt),
      worker = this.workers.get(work.session_id);
    return worker?.attempt === attempt && worker.busy;
  }
  assertIdle(id: string): Worker {
    this.store.execution.assert(id);
    const w = this.workers.get(id);
    if (!w?.ready || w.invalid || w.stopping || !w.pi || this.store.session(id).state !== 'ready')
      throw new ServiceError('not_ready', 'A ready worker is required');
    if (
      w.busy ||
      this.store.db
        .prepare("SELECT 1 FROM approvals WHERE session_id=? AND state='pending' LIMIT 1")
        .get(id)
    )
      throw new ServiceError('worker_busy', 'Wait for the active turn and approvals to settle');
    return w;
  }
  compact(id: string, request: string, expected: number, authorize: () => void): Compaction {
    // Deduplication runs before idle/lease checks, including after a lost response.
    const work = this.tasks.begin(id, this.store.session(id).epoch, request, expected, () => {
      authorize();
      this.store.taskGrantCheck?.(id);
    });
    const w = this.workers.get(id)!;
    if (work.state !== 'running' || w.compaction === work.id) return work;
    w.busy = true;
    w.compaction = work.id;
    const job = (async () => {
      try {
        await w.pi!.command('compact', {}, 30000);
        await this.syncEntries(w);
        if (this.tasks.compaction(work.id).state !== 'completed')
          throw new Error('Pi compaction receipt missing');
      } catch (error) {
        try {
          // A pipe response can be lost after Pi persisted its receipt.
          if (!w.stopping && !w.invalid) await this.syncEntries(w);
          const ambiguous = !(error instanceof PiCommandError);
          if (ambiguous && this.tasks.compaction(work.id).state !== 'completed')
            this.invalidate(w, 'Compaction outcome requires reconciliation');
          this.tasks.settle(
            work.id,
            ambiguous
              ? 'interrupted'
              : this.store.db
                    .prepare('SELECT 1 FROM compaction_cancellations WHERE id=?')
                    .get(work.id)
                ? 'cancelled'
                : 'failed',
            (error as Error).message,
          );
        } catch {
          this.invalidate(w, 'Compaction reconciliation failed');
        }
      } finally {
        w.busy = false;
        delete w.compaction;
        this.emit('idle', id);
      }
    })();
    this.compactionJobs.add(job);
    void job.finally(() => this.compactionJobs.delete(job));
    return work;
  }
  cancelCompaction(id: string, request: string, authorize: () => void): Compaction {
    const work = this.tasks.compaction(id);
    this.store.request('local-operator', request, { kind: 'cancel-compaction', id }, () => {
      authorize();
      if (work.state === 'running') {
        this.store.db.prepare('INSERT OR IGNORE INTO compaction_cancellations VALUES (?)').run(id);
        this.store.event(
          work.session_id,
          'compaction.cancel_requested',
          { compaction_id: id },
          request,
        );
      }
      return { id };
    });
    const w = this.workers.get(work.session_id);
    if (w?.compaction === id)
      void w
        .pi!.command('abort', {}, 5000)
        .catch(() => this.invalidate(w, 'Compaction abort failed'));
    return this.tasks.compaction(id);
  }
  async probe(id: string, nested = false): Promise<{ text: string }> {
    const w = this.workers.get(id);
    if (!w?.ready || w.invalid || !w.pi || this.store.session(id).state !== 'ready')
      throw new ServiceError('not_ready', 'Worker has not passed readiness');
    if (w.busy) throw new ServiceError('worker_busy', 'A diagnostic is already active');
    w.busy = true;
    const settled = w.pi.waitFor('agent_settled');
    void settled.catch(() => {});
    try {
      this.store.writable();
      await w.pi.command('prompt', {
        message: nested
          ? 'Run the nested Salaam readiness probe.'
          : 'Run the Salaam readiness probe.',
      });
      await settled;
      if (w.invalid) throw new Error(w.invalid);
      await this.syncEntries(w);
      const text = object((await w.pi.command('get_last_assistant_text')).data);
      return { text: String(text.text ?? '') };
    } catch (error) {
      if (!w.stopping) this.invalidate(w, 'Diagnostic failed: ' + (error as Error).message);
      throw error;
    } finally {
      w.busy = false;
      this.emit('idle', id);
    }
  }
  async dispatchNext(id: string): Promise<boolean> {
    const w = this.workers.get(id);
    if (!w?.ready || w.invalid || !w.pi || w.busy) return false;
    // Commit the handoff boundary before touching the pipe. A crash from this
    // point onward is ambiguous and must never cause automatic prompt replay.
    if (this.children?.owned(id) && this.store.cancelled(this.children.owned(id)!.child_attempt))
      return false;
    const work = this.store.claim(id, w.epoch);
    if (!work) return false;
    w.busy = true;
    w.attempt = work.attempt.id;
    // Approval deadlines belong to the journal, not an adapter-side timer.
    const settled = w.pi.waitFor('agent_settled', 0);
    void settled.catch(() => {});
    let outcome: AttemptOutcome | undefined;
    const record = (value: Record<string, unknown>) => {
      if (value.type === 'message_end') {
        const message = object(value.message);
        if (message.role === 'assistant') {
          const explicit = parseAcpFailure(message.salaamFailure);
          const candidate: AttemptOutcome = explicit
            ? {
                version: 1,
                stopReason:
                  explicit.kind === 'refusal'
                    ? 'refusal'
                    : explicit.kind === 'max_tokens'
                      ? 'max_tokens'
                      : 'error',
                failure: { ...explicit, message: redactFailureText(explicit.message, w.secrets) },
              }
            : providerOutcome(
                String(message.stopReason),
                String(message.errorMessage ?? ''),
                w.route,
                undefined,
                w.secrets,
              );
          if (candidate.stopReason !== 'end_turn') outcome = candidate;
        }
      }
      // A checked task step is decided by its checks, not by a tool error the model went on
      // to recover from (operator decision, 2026-10-23). The error stays in the journal
      // (tool.finished failed=true). A delegated child turn, whose denied probes are its
      // boundary proof, and any attempt outside a checked step still fail on it, except an
      // interactive coding turn: at a desk a failed command is feedback, and the turn is
      // decided by how it ends (step 0, 2026-10-31).
      if (
        value.type === 'tool_execution_end' &&
        value.isError === true &&
        (this.children?.owned(id) ||
          (!this.checkedStepAttempt(work.attempt.id) && !this.interactiveCoding(id)))
      )
        outcome ??= {
          version: 1,
          stopReason: 'error',
          failure: acpFailure(new ServiceError('tool_failed', toolFailureMessage(value.toolName))),
        };
    };
    w.pi.on('record', record);
    try {
      // Interactive sessions pick up AGENTS.md edits at the start of each turn (recorded as a new
      // instructions.loaded revision). A discovery failure never blocks the turn.
      try {
        this.tasks.instructions?.refresh(id);
      } catch {
        /* the previously loaded guidance stays in force */
      }
      const images = takeImages(this.store.db, work.submission.id);
      const response = await w.pi.command('prompt', {
        message: work.submission.text,
        ...(images.length ? { images } : {}),
      });
      const disposition = object(response.data ?? {}).disposition;
      if (disposition !== 'started') throw new Error('Pi did not start the dispatched prompt');
      this.store.running(work.attempt.id);
      const end = await settled;
      if (w.invalid || end.aborted) throw new Error(w.invalid ?? 'Attempt aborted');
      const entries = await this.readEntries(w);
      const result = object((await w.pi.command('get_last_assistant_text')).data);
      this.childBoundary(id, w.epoch);
      this.store.finish(
        work.attempt.id,
        outcome ? 'failed' : 'completed',
        String(result.text ?? ''),
        outcome?.failure?.message ?? null,
        { epoch: w.epoch, ...entries },
        outcome,
      );
    } catch (error) {
      const message = redactFailureText((error as Error).message, w.secrets);
      if (!w.stopping && !this.store.cancelled(work.attempt.id))
        this.invalidate(w, 'Attempt interrupted: ' + message);
      this.store.finish(work.attempt.id, 'interrupted', null, message);
    } finally {
      w.pi.off('record', record);
      w.busy = false;
      delete w.attempt;
      const child = this.children?.owned(id);
      if (child && child.state !== 'accepted') await this.stopWorker(w);
      this.emit('idle', id);
    }
    return true;
  }
  private async syncEntries(w: Worker): Promise<void> {
    const entries = await this.readEntries(w);
    this.store.importEntries(w.id, w.epoch, entries.entries, entries.leaf);
  }
  private async readEntries(
    w: Worker,
  ): Promise<{ entries: { id: string }[]; leaf: string | null }> {
    const cursor = this.store.session(w.id).pi_cursor;
    const entries = object(
      (await w.pi!.command('get_entries', cursor ? { since: cursor } : {})).data,
    );
    if (
      !Array.isArray(entries.entries) ||
      entries.entries.some((entry) => typeof object(entry).id !== 'string')
    )
      throw new Error('Invalid Pi entries');
    return {
      entries: entries.entries as { id: string }[],
      leaf: typeof entries.leafId === 'string' ? entries.leafId : null,
    };
  }
  async stopSession(id: string): Promise<void> {
    const w = this.workers.get(id);
    if (w) await this.stopWorker(w);
  }
  private async stopWorker(w: Worker): Promise<void> {
    if (w.stopping) {
      await w.pi?.closed;
      return;
    }
    w.stopping = true;
    w.ready = false;
    try {
      this.managed?.invalidateWorker(w.id, w.epoch);
      this.cancelMcpWorker(w);
      void this.operatorMcp?.stopSession(w.id).catch(() => {});
      this.children?.workerLost(w.id, 'Worker stopped before child dispatch');
    } catch {
      /* shutdown still owns and stops the worker */
    }
    await w.pi?.stop();
    if (!w.invalid) this.store.state(w.id, w.epoch, 'exited');
    // Preserve the unhealthy session reason while marking this process dead.
    else
      try {
        this.store.db
          .prepare("UPDATE workers SET state='exited' WHERE session_id=? AND epoch=?")
          .run(w.id, w.epoch);
      } catch {}
  }
  async close(): Promise<void> {
    clearInterval(this.monitor);
    const results = await Promise.allSettled(
      [...this.workers.values()].map((w) => this.stopWorker(w)),
    );
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    await Promise.allSettled(this.compactionJobs);
    if (errors.length)
      throw new AggregateError(errors, 'Worker shutdown could not persist all final states');
  }
}

/** Names the failing tool (never its arguments or output), so a failed step says which call
 * failed it. Only a plain tool identifier is echoed. */
export function toolFailureMessage(toolName: unknown): string {
  return typeof toolName === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(toolName)
    ? `Tool execution failed (tool ${toolName})`
    : 'Tool execution failed';
}
