import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
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
import { PI_CLI, HOUSE_EXTENSION, POLICY_DIGEST, bundleDigest } from './config.js';
import { PiProcess, PiCommandError } from './pi.js';
import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
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
import type { CodingWork } from './coding.js';
import type { TaskLimits } from './task-policy.js';

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
  try {
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
  tasks!: TaskContext;
  private compactionJobs = new Set<Promise<void>>();
  managed?: ManagedWork;
  children?: ChildWork;
  coding?: CodingWork;
  private codingBinding(id: string): CodingBinding | undefined {
    return this.children?.owned(id) ? undefined : this.coding?.binding(id);
  }
  private tools(id: string): string[] {
    return workerTools(
      !!this.options.effectsEnabled,
      !!this.children?.owned(id),
      this.codingBinding(id),
    );
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
  private assertSessionProviderSupported(id: string, outputCap = this.outputCap) {
    const parent = this.children?.owned(id)?.parent_session ?? id;
    const task = this.tasks.work?.forSession(parent);
    if (task) this.assertTaskProviderSupported(task.limits, outputCap);
  }
  readonly bootId = randomUUID();
  private workers = new Map<string, Worker>();
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
    );
    if (canonical(checked) !== canonical(this.route)) throw new Error('Invalid provider route');
    if (options.anthropicApiKey) this.apiKey = validateApiKey(options.anthropicApiKey);
    this.bundle = bundleDigest();
    this.monitor = setInterval(() => {
      for (const worker of this.workers.values())
        if (worker.ready && Date.now() - worker.lastBeat > (options.heartbeatTimeout ?? 2500))
          this.invalidate(worker, 'Worker heartbeat expired');
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
    this.store.bindRoute(id, this.route);
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
    // Attach a rejection handler before spawn/identity checks can fail.
    void handshake.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
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
        route: this.route,
        coding: this.codingBinding(id),
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
        this.route.provider,
        '--model',
        this.route.model,
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
        ...(this.route.connection?.configuration ?? {}),
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
      if (
        object(state.model).provider !== this.route.provider ||
        object(state.model).id !== this.route.model
      )
        throw new Error('Pi selected an unapproved provider route');
      if (worker.invalid) throw new Error(worker.invalid);
      // Pi buffers setup-only entries until there is a conversation. Do not
      // persist a cursor into that ephemeral tree before its file exists.
      if (existsSync(file)) await this.syncEntries(worker);
      this.store.state(id, epoch, 'ready', null, workerCapabilities(this.codingBinding(id)), file);
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
    if (method === 'handshake') {
      try {
        if (w.manifest) throw new Error('Duplicate handshake');
        const expected = {
          protocol_version: PROTOCOL_VERSION,
          bundle_digest: w.bundle,
          policy_digest: POLICY_DIGEST,
          session_id: id,
          pi_session_id: id,
          epoch: w.epoch,
          capabilities: workerCapabilities(this.codingBinding(id)),
          tools: this.tools(id),
          active_tools: this.tools(id),
          ...(this.codingBinding(id) ? { coding: this.codingBinding(id) } : {}),
          provider: this.route.provider,
          route: this.route,
          context_digest: textDigest(w.frame),
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
      if (method === 'provider.auth') {
        const auth = await this.providerAuth();
        w.providerOutputCap = this.outputCap;
        this.assertSessionProviderSupported(id);
        return auth;
      }
      if (method === 'coding.files' || method === 'coding.command') {
        if (this.children?.owned(id) || !this.coding || !this.codingBinding(id) || !w.attempt)
          throw new Error('Coding authority is unavailable');
        this.assertActive(id, w.epoch, w.attempt);
        const args = object(body.args);
        if (method === 'coding.files')
          return this.coding.file(
            id,
            w.epoch,
            w.attempt,
            string(body.tool_call_id, 'tool_call_id', 512),
            args,
          );
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
        this.assertActive(id, w.epoch, w.attempt);
        if (method === 'child.spawn') this.assertSessionProviderSupported(id);
        if (method === 'child.spawn')
          return this.children.spawn(
            id,
            w.epoch,
            w.attempt,
            string(body.step_key, 'step_key', 128),
            string(body.prompt, 'prompt', 32768),
            Number(body.budget),
            Array.isArray(body.authority)
              ? body.authority.map((x) => string(x, 'authority', 128))
              : ['salaam_probe'],
          );
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
            this.route.provider,
            this.route.model,
            body.usage,
            this.route.provider !== 'salaam-proof' ? 'estimated' : 'known',
          ),
        );
        return { ok: true };
      }
      if (method === 'model') {
        this.coding?.assertSafe(id);
        this.store.taskGrantCheck?.(id);
        if (
          body.provider !== this.route.provider ||
          body.model !== this.route.model ||
          body.context_digest !== textDigest(this.tasks.frame(id, w.binding))
        )
          throw new Error('Provider or task context is invalid');
        if (this.route.provider !== 'salaam-proof') {
          if (w.providerOutputCap === undefined)
            throw new Error('Provider authentication was not admitted');
          this.assertSessionProviderSupported(id, w.providerOutputCap);
          validateProviderPayload(
            body.payload,
            this.route,
            this.tasks.frame(id, w.binding),
            this.tools(id),
            !w.providerOutputCap,
          );
          if (body.payload_digest !== digest(body.payload))
            throw new Error('Provider payload digest changed');
        }
        if (this.route.provider === 'salaam-proof') {
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
          { input: Buffer.byteLength(JSON.stringify(body.payload)), output: this.route.max_tokens },
        );
        this.store.transaction(() => {
          this.store.event(id, 'model.admitted', {
            attempt_id: w.attempt ?? null,
            epoch: w.epoch,
            provider: body.provider,
            context_digest: body.context_digest,
            payload_digest: body.payload_digest,
            task_version: this.tasks.state(id).version,
          });
        });
      } else if (method === 'policy' || method === 'tool') {
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
      if (
        method.startsWith('coding.') &&
        error instanceof ServiceError &&
        [
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
    const state = {
      ...this.store.session(id),
      provider_route: this.store.providerRoute(id) ?? undefined,
      provider_capabilities: this.providerCapabilities(),
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
  async cancelAttempt(attempt: string): Promise<void> {
    const work = this.store.attempt(attempt);
    const w = this.workers.get(work.session_id);
    if (!w?.pi || w.attempt !== attempt) return;
    try {
      await w.pi.command('abort', {}, 5000);
    } catch {
      await this.stopWorker(w);
    }
  }
  assertIdle(id: string): Worker {
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
    let outcomeError: string | null = null;
    const record = (value: Record<string, unknown>) => {
      if (value.type === 'message_end') {
        const message = object(value.message);
        if (
          message.role === 'assistant' &&
          ['error', 'aborted'].includes(String(message.stopReason))
        )
          outcomeError = String(message.errorMessage ?? message.stopReason);
      }
      if (value.type === 'tool_execution_end' && value.isError === true)
        outcomeError = 'Tool execution failed';
    };
    w.pi.on('record', record);
    try {
      const response = await w.pi.command('prompt', { message: work.submission.text });
      const disposition = object(response.data ?? {}).disposition;
      if (disposition !== 'started') throw new Error('Pi did not start the dispatched prompt');
      this.store.running(work.attempt.id);
      const end = await settled;
      if (w.invalid || end.aborted) throw new Error(w.invalid ?? 'Attempt aborted');
      const entries = await this.readEntries(w);
      const result = object((await w.pi.command('get_last_assistant_text')).data);
      this.store.finish(
        work.attempt.id,
        outcomeError ? 'failed' : 'completed',
        String(result.text ?? ''),
        outcomeError,
        { epoch: w.epoch, ...entries },
      );
    } catch (error) {
      if (!w.stopping && !this.store.cancelled(work.attempt.id))
        this.invalidate(w, 'Attempt interrupted: ' + (error as Error).message);
      this.store.finish(work.attempt.id, 'interrupted', null, (error as Error).message);
    } finally {
      w.pi.off('record', record);
      w.busy = false;
      delete w.attempt;
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
  private async stopWorker(w: Worker): Promise<void> {
    if (w.stopping) {
      await w.pi?.closed;
      return;
    }
    w.stopping = true;
    w.ready = false;
    try {
      this.managed?.invalidateWorker(w.id, w.epoch);
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
