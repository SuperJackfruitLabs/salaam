// The supervisor runs each session's Pi worker: it launches it (launch.ts), checks its readiness
// handshake, keeps its heartbeat, dispatches turns to it, and answers the requests it sends back
// over the bridge (bridge/), failing the worker when a required control breaks.
import { BoardReads } from './board-reads.js';
import { takeImages } from './mentions.js';
import { HostBreaker } from './breaker.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  canonical,
  object,
  ServiceError,
  workerTools,
  workerCapabilities,
  type CodingBinding,
  type Manifest,
  type Session,
  bundleDigest,
  readinessFingerprint,
  OFFLINE_ROUTE,
  type ProviderRoute,
  digest,
  redactFailureText,
  processIdentity,
} from '../core/index.js';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { PiProcess, PiCommandError } from './pi.js';
import type { Store } from '../store/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { McpWork } from '../mcp/index.js';
import type { StationBridge } from './station.js';
import type { ToolkitWork } from '../toolkit/index.js';
import { mergeMcpProvenance, type OperatorMcp } from '../mcp/index.js';
import type { McpServerProvenance, AttemptOutcome, TaskLimits } from '../core/index.js';
import type { ChildWork } from '../workers/index.js';
import {
  providerRoute,
  providerHasOutputCap,
  validateApiKey,
  resolveProviderAuth,
  bindProviderConfiguration,
} from '../providers/index.js';
import type { TaskContext, Compaction } from './task-context.js';
import type { CodingWork } from '../coding/index.js';
import type { RepositorySnapshots } from '../workers/index.js';
import type { TeamBridge } from './team.js';
import type { HookEvent, HookOutcome, Hooks, LocalCoding } from '../local/index.js';
import type { WebSearch } from '../web/index.js';
import type { Persona } from './persona.js';
import type { Controller } from '../core/index.js';
import { isFeedback, Unawaited, type BridgeRoute } from './bridge/bridge.js';
import { bridgeRoutes } from './bridge/routes.js';
import { recordStationRefusal } from './bridge/station.js';
import { recoverWorkers } from './recovery.js';
import { runCompaction } from './compaction-job.js';
import { readPiEntries, syncPiEntries, type PiEntries } from './pi-entries.js';
import { inspectSession } from './session-view.js';
import { steerTurn } from './steering.js';
import {
  expectedManifest,
  piArgs,
  prepareWorkerDir,
  readinessRecord,
  resumeArgs,
  workerConfig,
  workerEnv,
  type Launch,
} from './launch.js';
import type { Worker } from './worker.js';
import { hookAliases, watchWorker } from './worker-events.js';
import { turnOutcome } from './turn-outcome.js';

/** How long a ready worker may go without a heartbeat, and how often that is checked. */
const HEARTBEAT_TIMEOUT = 2500;
const MONITOR_INTERVAL = 250;
const STARTUP_TIMEOUT = 15000;

export type { Launch } from './launch.js';

type ClaimedWork = NonNullable<ReturnType<Store['claim']>>;

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
  providerCredentials?: CredentialStore;
  providerEnvironment?: NodeJS.ProcessEnv;
}

export class Supervisor extends EventEmitter {
  localCoding?: LocalCoding;
  /** Built-in web search and fetch for interactive coding (operator ruling 2026-10-31). */
  web?: WebSearch;
  /** Desk-session hooks (Phase 4b); absent means none run. */
  hooks?: Hooks;
  tasks!: TaskContext;
  private compactionJobs = new Set<Promise<void>>();
  /** Pauses an operator MCP host that keeps failing. */
  readonly fetchBreaker = new HostBreaker();
  managed?: ManagedWork;
  mcp?: McpWork;
  operatorMcp?: OperatorMcp;
  /** Item 9: the host's pinned persona, given to every worker on this host. */
  persona?: Persona;
  toolkit?: ToolkitWork;
  station?: StationBridge;
  children?: ChildWork;
  coding?: CodingWork;
  repositories?: RepositorySnapshots;
  team?: TeamBridge;
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
  /** The session's coding workspace binding; a child's is narrowed to its own authority. */
  codingBinding(id: string): CodingBinding | undefined {
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
  /** The tools the session's policy admits. */
  tools(id: string): string[] {
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
  declaredMcp(id: string): boolean {
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
  private cap = true;
  /** Whether the service's provider authentication enforces an output cap. */
  get outputCap(): boolean {
    return this.cap;
  }
  private authInitialized = false;
  providerCapabilities() {
    return {
      output_token_cap: this.cap,
      durable_tasks: true,
      warning: this.cap
        ? null
        : 'No provider-enforced output cap; tasks must explicitly disable token budgeting',
    };
  }
  assertTaskProviderSupported(limits: TaskLimits, outputCap = this.cap) {
    if (!outputCap && (limits.token_units !== null || limits.output_token_bound !== null))
      throw new ServiceError(
        'provider_capability',
        'This provider authentication has no output cap; set limits.token_units to null and omit output_token_bound',
      );
  }
  assertSessionProviderSupported(id: string, outputCap = this.cap) {
    const parent = this.children?.owned(id)?.parent_session ?? id;
    const task = this.tasks.work?.forSession(parent);
    if (task) this.assertTaskProviderSupported(task.limits, outputCap);
  }
  readonly bootId = randomUUID();
  private readonly bridgeRoutes: BridgeRoute[] = bridgeRoutes(this);
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
          if (Date.now() - worker.lastBeat > (options.heartbeatTimeout ?? HEARTBEAT_TIMEOUT))
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
    }, MONITOR_INTERVAL);
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
    if (this.authInitialized && this.cap !== outputCap)
      throw new Error(
        'Provider output-cap capability changed; restart the service before using the new authentication',
      );
    this.cap = outputCap;
    this.authInitialized = true;
    return auth;
  }
  /** After a restart, stop what is left of the previous service's workers, or mark them for
   * reconciliation when they cannot be proven stopped. */
  async recover(): Promise<void> {
    await recoverWorkers(this.store);
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
    const worker = this.newWorker(id, epoch, route);
    this.workers.set(id, worker);
    worker.secrets = [worker.token, ...(this.apiKey ? [this.apiKey] : [])];
    // Attach a rejection handler before spawn/identity checks can fail.
    void worker.handshake.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      await this.grant(worker, id);
      this.store.execution.assert(id);
      if (worker.stopping || worker.invalid) throw new Error('Worker startup cancelled');
      if (child) this.store.workerBoundary.claim(child, epoch, route);
      const { sessionDir, pi } = this.launch(worker, route, previous);
      const pid = pi.child.pid;
      if (!pid) throw new Error('Pi failed to spawn');
      const identity = processIdentity(pid);
      if (!identity) throw new Error('Pi process identity unavailable');
      this.store.process(id, epoch, pid, identity);
      const timeout = new Promise<never>((_a, b) => {
        timer = setTimeout(
          () => b(new Error('Worker readiness timed out')),
          this.options.startupTimeout ?? STARTUP_TIMEOUT,
        );
      });
      await Promise.race([worker.handshake, timeout]);
      const file = await this.checkPiState(pi, id, sessionDir, route);
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
        readinessFingerprint(
          readinessRecord({
            session: id,
            epoch,
            bundle: worker.bundle,
            route,
            frame: worker.frame,
            contextAdmissionDigest: this.tasks.admitted?.currentDigest(id) ?? null,
          }),
        ),
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
  /** A worker record with fresh credentials and frame binding, waiting for its handshake. */
  private newWorker(id: string, epoch: number, route: ProviderRoute): Worker {
    let accept!: () => void;
    let reject!: (e: Error) => void;
    const handshake = new Promise<void>((a, b) => {
      accept = a;
      reject = b;
    });
    const binding = randomBytes(16).toString('hex');
    const frame = this.tasks.frame(id, binding);
    return {
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
  }
  /** What the worker gets besides its own tools: managed MCP, Toolkit, declared MCP servers and
   * station work. A child gets none of them. */
  private async grant(worker: Worker, id: string): Promise<void> {
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
  }
  /** Prepare the worker's directory and spawn Pi with the pinned launch (launch.ts). */
  private launch(
    worker: Worker,
    route: ProviderRoute,
    previous: Session,
  ): { sessionDir: string; pi: PiProcess } {
    const { id, epoch, frame } = worker;
    const { workerDir, sessionDir } = prepareWorkerDir(
      this.options.stateDir,
      id,
      worker.mcpServers,
    );
    const config = workerConfig({
      socket: this.options.bridgeSocket,
      token: worker.token,
      session: id,
      epoch,
      bundle: this.bundle,
      frame,
      effects: !!this.options.effectsEnabled && !this.children?.owned(id),
      child: !!this.children?.owned(id),
      worker_binding: this.childBoundary(id, epoch),
      route: route,
      coding: this.codingBinding(id),
      local: this.store.localWorkspace(id),
      localCoding: this.store.localCoding(id),
      grants: worker,
      persona: this.persona,
    });
    const args = piArgs({
      session: id,
      sessionDir,
      epoch,
      bootId: this.bootId,
      extension: this.options.extensionPath,
      tools: this.tools(id),
      route,
    });
    if (previous.pi_session_file && existsSync(previous.pi_session_file)) {
      resumeArgs(args, previous.pi_session_file);
    } else if (
      this.store.db
        .prepare("SELECT 1 FROM events WHERE session_id=? AND kind='model.admitted' LIMIT 1")
        .get(id)
    ) {
      throw new Error('Recorded Pi transcript is missing; reconciliation required');
    }
    const env = workerEnv(workerDir, config, route);
    worker.pi = (this.options.launch ?? ((x) => new PiProcess(x.command, x.args, x.cwd, x.env)))({
      command: process.execPath,
      args,
      cwd: previous.cwd,
      env,
    });
    watchWorker(this, worker, worker.pi);
    return { sessionDir, pi: worker.pi };
  }
  /** Pi's own state must be the managed one: no automatic retry or compaction, this session, a
   * session file inside its directory, and the approved route. Returns the session file. */
  private async checkPiState(
    pi: PiProcess,
    id: string,
    sessionDir: string,
    route: ProviderRoute,
  ): Promise<string> {
    await pi.command('set_auto_retry', { enabled: false });
    await pi.command('set_auto_compaction', { enabled: false });
    const response = await pi.command('get_state');
    const state = object(response.data);
    if (state.autoCompactionEnabled !== false)
      throw new Error('Pi automatic compaction is outside the current managed route');
    if (state.sessionId !== id) throw new Error('Pi state has the wrong session identity');
    const file = typeof state.sessionFile === 'string' ? resolve(state.sessionFile) : null;
    if (!file || !file.startsWith(resolve(sessionDir) + '/'))
      throw new Error('Pi session is outside its managed directory');
    if (object(state.model).provider !== route.provider || object(state.model).id !== route.model)
      throw new Error('Pi selected an unapproved provider route');
    return file;
  }
  /** Fail the worker: deny it every new grant and record why. */
  invalidate(worker: Worker, reason: string): void {
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
  /** A person's own local coding session: not a delegated child and not AgentPod-admitted work,
   * whose strict semantics stay as they are. */
  isInteractiveCoding(id: string): boolean {
    return this.interactiveCoding(id);
  }
  /** Run this desk session's hooks for `event`; other sessions (board, station, children) run none. */
  async hook(
    id: string,
    event: HookEvent,
    payload: Record<string, unknown>,
    names: readonly string[] = [],
  ): Promise<HookOutcome | null> {
    if (!this.hooks || !this.interactiveCoding(id)) return null;
    return this.hooks.fire(id, event, payload, names);
  }
  /** A PreToolUse hook that blocks turns the tool call into an error the model reads. */
  async preToolUse(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    toolCallId: string,
  ): Promise<void> {
    const out = await this.hook(
      id,
      'PreToolUse',
      { tool_name: tool, tool_input: input, tool_use_id: toolCallId },
      [tool, ...hookAliases(tool, input)],
    );
    if (out?.blocked)
      throw new ServiceError('hook_blocked', `Blocked by a PreToolUse hook: ${out.blocked}`);
  }
  private interactiveCoding(id: string): boolean {
    return (
      this.store.localCoding(id) &&
      !this.children?.owned(id) &&
      !this.store.db.prepare('SELECT 1 FROM agentpod_admissions WHERE session_id=?').get(id)
    );
  }
  /** Is this attempt a task step that has acceptance checks to decide it? */
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
  async bridge(
    id: string,
    method: string,
    token: string | undefined,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const w = this.authenticate(id, token, body);
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
    if (method === 'handshake') return this.handshake(id, w, body);
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
      const route = this.bridgeRoutes.find((r) => r.matches(method));
      if (!route) throw new Error('Unsupported worker operation');
      const answer = await route.handle({ id, method, body, w });
      return answer instanceof Unawaited ? answer.value : answer;
    } catch (error) {
      this.store.taskBudgetDenied?.(id, error);
      if (method.startsWith('station.'))
        recordStationRefusal(this.store, this.workers.get(id)?.attempt, id, method, body, error);
      if (isFeedback(method, error)) throw error;
      if (!w.stopping) this.invalidate(w, 'Required control failed: ' + (error as Error).message);
      throw new ServiceError('control_failed', 'Required control unavailable', 503);
    }
  }
  /** The worker's readiness handshake: every field must match what it was launched with. */
  private handshake(id: string, w: Worker, body: Record<string, unknown>): unknown {
    try {
      if (w.manifest) throw new Error('Duplicate handshake');
      const boundary = this.childBoundary(id, w.epoch);
      const expected = expectedManifest({
        session: id,
        epoch: w.epoch,
        bundle: w.bundle,
        frame: w.frame,
        route: w.route,
        coding: this.codingBinding(id),
        tools: this.tools(id),
        boundary,
        grants: w,
        persona: this.persona,
      });
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
  /** The session as clients see it: unhealthy unless its supervised worker is ready. */
  inspect(id: string): Session {
    return inspectSession(this, id, () => this.workers.get(id));
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
  /** Deliver a person's steering message to the active local model turn, once. */
  async steer(id: string, request: string, text: string, controller: Controller) {
    return steerTurn(this.store, () => this.workers.get(id), id, request, text, controller);
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
    const job = runCompaction(
      {
        store: this.store,
        tasks: this.tasks,
        sync: (x) => this.syncEntries(x),
        invalidate: (x, reason) => this.invalidate(x, reason),
        idle: () => this.emit('idle', id),
      },
      w,
      work.id,
    );
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
    // A checked task step is decided by its checks, not by a tool error the model went on
    // to recover from (operator decision, 2026-10-23). The error stays in the journal
    // (tool.finished failed=true). A delegated child turn, whose denied probes are its
    // boundary proof, and any attempt outside a checked step still fail on it, except an
    // interactive coding turn: at a desk a failed command is feedback, and the turn is
    // decided by how it ends (step 0, 2026-10-31).
    const toolErrorsFail = () =>
      !!this.children?.owned(id) ||
      (!this.checkedStepAttempt(work.attempt.id) && !this.interactiveCoding(id));
    const record = (value: Record<string, unknown>) => {
      outcome = turnOutcome(value, outcome, w.route, w.secrets, toolErrorsFail);
    };
    w.pi.on('record', record);
    try {
      const message = await this.turnPrompt(id, work);
      if (message === null) return true;
      const images = takeImages(this.store.db, work.submission.id);
      const response = await w.pi.command('prompt', {
        message,
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
      void this.hook(id, 'Stop', { outcome: outcome ? 'failed' : 'completed' }).catch(() => {});
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
  /** Prepare a claimed turn: refresh project guidance, checkpoint a desk session's folder, and
   * run UserPromptSubmit hooks. The prompt to send, or null when a hook blocked (and failed) it. */
  private async turnPrompt(id: string, work: ClaimedWork): Promise<string | null> {
    // Interactive sessions pick up AGENTS.md edits at the start of each turn (recorded as a new
    // instructions.loaded revision). A discovery failure never blocks the turn.
    try {
      this.tasks.instructions?.refresh(id);
    } catch {
      /* the previously loaded guidance stays in force */
    }
    // The folder as it was before this turn, so /rewind can return to it.
    if (this.interactiveCoding(id)) this.tasks.checkpoints?.capture(id, work.attempt.id);
    // UserPromptSubmit hooks may stop the prompt or add context to it (Phase 4b).
    let message = work.submission.text;
    const gate = await this.hook(id, 'UserPromptSubmit', { prompt: message });
    if (gate?.blocked) {
      this.store.finish(
        work.attempt.id,
        'failed',
        null,
        'Blocked by a UserPromptSubmit hook: ' + gate.blocked,
      );
      return null;
    }
    if (gate?.context) message += '\n\n<hook-context>\n' + gate.context + '\n</hook-context>';
    return message;
  }
  /** Import the worker's new Pi entries into the store. */
  private async syncEntries(w: Worker): Promise<void> {
    await syncPiEntries(this.store, w);
  }
  private readEntries(w: Worker): Promise<PiEntries> {
    return readPiEntries(this.store, w);
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
