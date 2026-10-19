import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { mkdirSync, chmodSync, existsSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TaskContext } from './task-context.js';
import { TaskWork } from './task-work.js';
import { TaskBudget } from './task-budget.js';
import { TaskVerification } from './task-verification.js';
import { TaskCheckpoints } from './task-checkpoints.js';
import { TaskDriver } from './task-driver.js';
import { OperatorInbox } from './operator-inbox.js';
import { RecurringWork } from './recurring-work.js';
import { JobWork } from './job-work.js';
import { Store } from './store.js';
import { acquireStateLock } from './state-lock.js';
import { Artifacts } from './artifacts.js';
import { Supervisor, type SupervisorOptions } from './supervisor.js';
import { canonical, digest, integer, object, ServiceError, string } from './protocol.js';
import { readJson } from './transport.js';
import { Dispatcher } from './dispatcher.js';
import { ManagedWork } from './managed.js';
import { ChildWork } from './children.js';
import type { EffectConnector } from './effect-connector.js';
import { EXECUTION_STATUS } from './execution-boundary.js';
import { engineRequest } from './execution-boundary.js';
import { DockerCodingExecutor, type ExecutionBackend } from './coding-executor.js';
import { Workspaces } from './workspaces.js';
import { CodingWork } from './coding.js';
import { AgentProfiles } from './agent-profiles.js';
import { RepositorySnapshots } from './repository-snapshots.js';
import { TeamWork } from './team-work.js';
import { WorkerWorkspaces } from './worker-workspaces.js';
import { ExternalWork } from './external-work.js';
import type { ExternalBackend } from './external-runtime.js';
import { DockerHarnessBackend } from './harness-backend.js';
import { A2AInbound } from './a2a-inbound.js';
import { AgentPodAuthority } from './agentpod-authority.js';
import { A2ABackend, ExternalBackends } from './a2a-backend.js';
import { VERSION } from './config.js';

export interface ServiceOptions extends Omit<SupervisorOptions, 'stateDir' | 'bridgeSocket'> {
  hostManifestDigest?: string;
  agentpodConfig?: string;
  externalBackend?: ExternalBackend;
  harnessConfig?: string;
  a2aConfig?: string;
  a2aListenConfig?: string;
  /** Trusted host admission, installed before any startup/recovery dispatch; throws deny a request. */
  admitModelRequest?: (
    session: string,
    attempt: string | undefined,
    input: number,
    output: number,
  ) => void;
  stateDir: string;
  effectConnector?: EffectConnector;
  approvalTtlMs?: number;
  codingRoot?: string;
  codingSocket?: string;
  codingBackend?: ExecutionBackend;
  expectedExecution?: { profile_digest: string; engine_id: string };
}
export class SalaamService {
  readonly agentpod?: AgentPodAuthority;
  readonly external: ExternalWork;
  a2aInbound?: A2AInbound;
  readonly stateDir: string;
  readonly socket: string;
  readonly bridgeSocket: string;
  readonly store: Store;
  readonly artifacts: Artifacts;
  readonly tasks: TaskContext;
  readonly taskWork: TaskWork;
  readonly taskBudget: TaskBudget;
  readonly taskVerification: TaskVerification;
  readonly taskCheckpoints: TaskCheckpoints;
  readonly taskDriver: TaskDriver;
  readonly jobs: JobWork;
  readonly recurring: RecurringWork;
  readonly inbox: OperatorInbox;
  readonly supervisor: Supervisor;
  readonly dispatcher: Dispatcher;
  readonly managed: ManagedWork;
  readonly children: ChildWork;
  readonly agents: AgentProfiles;
  readonly repositories: RepositorySnapshots;
  readonly team: TeamWork;
  readonly workerWorkspaces: WorkerWorkspaces;
  readonly workspaces: Workspaces;
  readonly coding: CodingWork;
  readonly codingSocket: string | null;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private operator: Server;
  private bridgeServer: Server;
  private release: () => void;
  private stopping = false;
  private handlers = new Set<Promise<void>>();
  private revocationStops = new Set<Promise<void>>();
  private authorityTimer?: NodeJS.Timeout;
  private readonly hostManifestDigest: string | null;
  private constructor(options: ServiceOptions) {
    this.hostManifestDigest = options.hostManifestDigest ?? null;
    if (process.platform === 'win32') throw new Error('Windows transport is not implemented');
    this.stateDir = resolve(options.stateDir);
    if (
      options.agentpodConfig &&
      (options.codingRoot ||
        options.codingBackend ||
        options.codingSocket ||
        options.effectConnector ||
        options.externalBackend ||
        options.harnessConfig ||
        options.a2aConfig ||
        options.a2aListenConfig)
    )
      throw new Error(
        'AgentPod authority profile does not enable station writes, effects, external runtimes or MCP yet',
      );
    this.codingSocket = options.codingSocket ? resolve(options.codingSocket) : null;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(this.stateDir);
    this.socket = join(this.stateDir, 'operator.sock');
    this.bridgeSocket = join(this.stateDir, 'bridge.sock');
    if (Buffer.byteLength(this.bridgeSocket) > 100)
      throw new Error('State path is too long for a Unix socket; choose a shorter --state path');
    this.release = acquireStateLock(this.stateDir);
    try {
      this.store = new Store(join(this.stateDir, 'journal.sqlite'));
      try {
        this.artifacts = new Artifacts(join(this.stateDir, 'artifacts'), this.store);
        this.tasks = new TaskContext(this.store, this.artifacts);
        this.taskWork = new TaskWork(this.store, this.tasks);
        this.taskBudget = new TaskBudget(this.store, this.taskWork);
        if (options.admitModelRequest) {
          const taskAdmission = this.store.taskModelAdmission!;
          this.store.taskModelAdmission = (session, attempt, input, output) => {
            taskAdmission(session, attempt, input, output);
            options.admitModelRequest!(session, attempt, input, output);
          };
        }
        this.workspaces = new Workspaces(this.store, this.artifacts, options.codingRoot);
        if (options.codingSocket && !options.codingRoot)
          throw new Error('Command execution requires an explicit --coding-root');
        const executor =
          options.codingBackend ??
          (options.codingSocket
            ? new DockerCodingExecutor(engineRequest(options.codingSocket))
            : undefined);
        if (
          options.harnessConfig &&
          (options.externalBackend ||
            !(executor instanceof DockerCodingExecutor) ||
            !options.codingSocket ||
            !options.codingRoot)
        )
          throw Error(
            'Harness configuration requires the real configured Docker executor and an exclusive backend',
          );
        if (options.a2aConfig && (options.externalBackend || !options.codingRoot || !executor))
          throw Error(
            'A2A configuration requires an owned coding root/executor and an exclusive backend',
          );
        const externalBackend =
          options.externalBackend ??
          new ExternalBackends([
            ...(options.harnessConfig
              ? [
                  new DockerHarnessBackend(
                    resolve(options.harnessConfig),
                    join(resolve(options.codingRoot!), 'external'),
                    options.codingSocket!,
                    executor as DockerCodingExecutor,
                  ),
                ]
              : []),
            ...(options.a2aConfig ? [new A2ABackend(resolve(options.a2aConfig))] : []),
          ]);
        this.coding = new CodingWork(
          this.store,
          this.workspaces,
          this.artifacts,
          executor,
          (id, error) => this.supervisor.failControl(id, error),
        );
        this.taskVerification = new TaskVerification(
          this.store,
          this.taskWork,
          this.taskBudget,
          this.workspaces,
          this.coding,
          this.artifacts,
        );
        this.taskCheckpoints = new TaskCheckpoints(
          this.store,
          this.taskWork,
          this.taskVerification,
          this.workspaces,
          this.artifacts,
        );
        this.supervisor = new Supervisor(this.store, {
          ...options,
          stateDir: this.stateDir,
          bridgeSocket: this.bridgeSocket,
          effectsEnabled: !!options.effectConnector,
        });
        this.supervisor.tasks = this.tasks;
        this.taskWork.providerCheck = (limits) =>
          this.supervisor.assertTaskProviderSupported(limits);
        this.supervisor.coding = this.coding;
        this.managed = new ManagedWork(this.store, {
          connector: options.effectConnector,
          approvalTtlMs: options.approvalTtlMs,
          assertActive: (id, epoch, attempt) =>
            this.external?.owns(id)
              ? this.external.assertActive(id, epoch, attempt)
              : this.supervisor.assertActive(id, epoch, attempt),
          reply: (id, epoch, request, confirmed) =>
            this.supervisor.replyUI(id, epoch, request, confirmed),
          failed: (id, error) =>
            this.external?.owns(id)
              ? this.external.failControl(id, error)
              : this.supervisor.failControl(id, error),
        });
        this.supervisor.managed = this.managed;
        this.agents = new AgentProfiles(
          this.store,
          this.supervisor.route,
          async (route, session) => {
            const prepared = await this.supervisor.prepareProviderRoute(route);
            const task = this.taskWork.forSession(session);
            if (task) this.supervisor.assertTaskProviderSupported(task.limits, prepared.output_cap);
            return { route: prepared.route, output_cap: prepared.output_cap };
          },
        );
        this.store.workerBoundary.profiles = this.agents;
        this.agents.validateFrame = (session) => {
          this.tasks.frame(session, 'x'.repeat(32));
        };
        this.repositories = new RepositorySnapshots(this.store, this.artifacts, this.workspaces);
        this.supervisor.repositories = this.repositories;
        this.children = new ChildWork(
          this.store,
          this.artifacts,
          this.supervisor,
          this.repositories,
        );
        this.supervisor.children = this.children;
        this.workerWorkspaces = new WorkerWorkspaces(
          this.store,
          this.workspaces,
          this.repositories,
          this.artifacts,
          this.coding,
          this.children,
        );
        this.children.workspaces = this.workerWorkspaces;
        this.agents.assertExecution = () => {
          this.workerWorkspaces.execution();
        };
        this.store.workerBoundary.assertIsolation = (binding) =>
          this.workerWorkspaces.assert(binding);
        this.taskWork.assertStepReview = (task, step) =>
          this.workerWorkspaces.assertStepReview(task, step);
        this.team = new TeamWork(
          this.store,
          this.taskWork,
          this.taskBudget,
          this.children,
          this.agents,
        );
        this.supervisor.team = this.team;
        this.external = new ExternalWork(
          this.store,
          this.artifacts,
          this.children,
          this.taskBudget,
          this.managed,
          this.workspaces,
          externalBackend,
          options.admitModelRequest,
        );
        this.children.external = this.external;
        const guardSubmission = this.store.guardTaskSubmission!;
        this.store.guardTaskSubmission = (session, step) => {
          const child = this.children.owned(session);
          if (child && this.store.workerBoundary.view(child.id).binding.external)
            throw new ServiceError(
              'external_worker_owned',
              'Use the owning team assignment and an explicit continuation',
            );
          guardSubmission(session, step);
        };
        this.dispatcher = new Dispatcher(this.store, this.supervisor);
        this.taskDriver = new TaskDriver(
          this.store,
          this.taskWork,
          this.taskBudget,
          this.taskVerification,
          this.supervisor,
          this.children,
          this.coding,
        );
        this.jobs = new JobWork(
          this.store,
          this.taskWork,
          this.taskDriver,
          this.taskVerification,
          this.managed,
        );
        this.recurring = new RecurringWork(this.jobs);
        this.inbox = new OperatorInbox(this.store, (error) => {
          this.external.failAll(error);
          for (const session of this.store.sessions())
            this.supervisor.failControl(session.id, error);
        });
        this.jobs.requiredControl = () => {
          const error = this.recurring.controlError ?? this.inbox.controlError;
          if (error) throw new ServiceError('host_control_unavailable', error, 503);
        };
        if (options.agentpodConfig)
          this.agentpod = new AgentPodAuthority(
            this.store,
            this.stateDir,
            resolve(options.agentpodConfig),
            (attempt) => {
              this.managed.cancelInTransaction(attempt, 'agentpod-revocation', 'agentpod-node');
            },
          );
      } catch (error) {
        this.store.close();
        throw error;
      }
    } catch (error) {
      this.release();
      throw error;
    }
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.operator = createServer((req, res) => {
      this.serve(req, res, false);
    });
    this.bridgeServer = createServer((req, res) => {
      this.serve(req, res, true);
    });
    for (const server of [this.operator, this.bridgeServer]) {
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
    }
  }
  private serve(req: IncomingMessage, res: ServerResponse, bridge: boolean): void {
    const task = this.handle(req, res, bridge)
      .catch(() => res.destroy())
      .then(() => {});
    this.handlers.add(task);
    void task.finally(() => this.handlers.delete(task));
  }
  static async open(options: ServiceOptions): Promise<SalaamService> {
    const service = new SalaamService(options);
    try {
      if (service.coding.executor instanceof DockerCodingExecutor) {
        const evidence = await service.coding.executor.prepare(service.workspaces.root!);
        const path = join(service.stateDir, 'executor-proof.json');
        const { writeFileSync, openSync, fsyncSync, closeSync } = await import('node:fs');
        const fd = openSync(path, 'w', 0o600);
        try {
          writeFileSync(fd, JSON.stringify(evidence, null, 2) + '\n');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      if (
        options.expectedExecution &&
        (service.coding.executor?.profileDigest !== options.expectedExecution.profile_digest ||
          service.coding.executor?.engineId !== options.expectedExecution.engine_id)
      )
        throw new Error('Host executor does not match reviewed manifest');
      await service.supervisor.providerAuth();
      await service.external.backend?.prepare?.();
      await service.supervisor.recover();
      await service.external.recover();
      service.store.recoverWork();
      service.taskWork.recover();
      service.tasks.recover();
      service.workspaces.recover();
      service.coding.recover();
      service.children.recover();
      service.workerWorkspaces.recover();
      service.managed.recover();
      await service.managed.reconcileAll();
      service.taskCheckpoints.recover();
      await service.jobs.recover();
      await service.recurring.recover();
      service.inbox.reconcile();
      if (options.a2aListenConfig) {
        service.a2aInbound = new A2AInbound(service, resolve(options.a2aListenConfig));
        await service.a2aInbound.listen();
      }
      await service.listen(service.bridgeServer, service.bridgeSocket);
      await service.listen(service.operator, service.socket);
      service.taskDriver.start();
      service.jobs.start();
      service.recurring.start();
      service.inbox.start();
      service.authorityTimer = setInterval(() => {
        try {
          for (const binding of service.agentpod?.expired() ?? []) {
            const status = service.agentpod!.revoke(
              binding,
              'expired:' + binding.hub_session_id,
              'AgentPod authority lease expired',
            );
            service.scheduleRevocationStop(service.store.execution.revocation(status.session_id)!);
          }
        } catch (error) {
          for (const session of service.store.sessions())
            if (
              service.store.db
                .prepare('SELECT 1 FROM agentpod_admissions WHERE session_id=?')
                .get(session.id)
            )
              service.supervisor.failControl(session.id, error as Error);
        }
      }, 250);
      service.authorityTimer.unref();
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private scheduleRevocationStop(
    receipt: import('./execution-authority.js').SessionRevocation,
  ): void {
    const cleanup = this.stopRevoked(receipt).finally(() => this.revocationStops.delete(cleanup));
    this.revocationStops.add(cleanup);
  }
  private async stopRevoked(
    receipt: import('./execution-authority.js').SessionRevocation,
  ): Promise<void> {
    const jobs: Promise<unknown>[] = receipt.attempt_ids.map(async (attempt) => {
      this.managed.abortCancelled(attempt);
    });
    for (const session of receipt.session_ids) {
      jobs.push(Promise.resolve().then(() => this.supervisor.stopSession(session)));
      jobs.push(
        Promise.resolve().then(async () => {
          const child = this.children.owned(session);
          if (child && this.store.workerBoundary.view(child.id).binding.external)
            await this.external.cancel(child);
        }),
      );
      jobs.push(
        Promise.resolve().then(() => {
          for (const run of this.store.db
            .prepare(
              "SELECT id FROM command_runs WHERE session_id=? AND state NOT IN ('succeeded','failed','cancelled','timed_out','output_limited','interrupted')",
            )
            .all(session))
            this.coding.cancel(session, String(run.id), 'session-revocation:' + run.id, () => {});
        }),
      );
    }
    await Promise.allSettled(jobs);
  }
  private async listen(server: Server, path: string): Promise<void> {
    // The exclusive state lock is held before removing a stale socket.
    if (existsSync(path)) unlinkSync(path);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        chmodSync(path, 0o600);
        resolve();
      });
    });
  }
  private send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  private async handle(req: IncomingMessage, res: ServerResponse, bridge: boolean): Promise<void> {
    try {
      if (this.stopping) throw new ServiceError('stopping', 'Service is stopping', 503);
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      if (
        !bridge &&
        req.method === 'GET' &&
        parts[0] === 'v1' &&
        parts[1] === 'a2a' &&
        parts[2] === 'grants' &&
        parts[3] &&
        parts.length === 4
      ) {
        this.send(res, 200, A2AInbound.binding(this, parts[3]));
        return;
      }
      if (!bridge && parts[0] === 'v1' && parts[1] === 'harnesses') {
        if (req.method === 'GET' && parts.length === 2) {
          this.send(res, 200, this.external.runtimes());
          return;
        }
        if (parts[2]) {
          const raw = this.store.db
            .prepare('SELECT * FROM child_tasks WHERE id=?')
            .get(parts[2]) as unknown as import('./protocol.js').ChildTask | undefined;
          if (!raw || !this.store.workerBoundary.view(raw.id).binding.external)
            throw new ServiceError('not_found', 'External worker not found', 404);
          if (req.method === 'GET' && parts.length === 3) {
            this.send(res, 200, {
              child: this.children.inspect(raw.parent_session, raw.id),
              execution: this.external.view(raw.id),
            });
            return;
          }
          if (req.method === 'POST' && parts.length === 4 && parts[3] === 'reconcile') {
            const body = object(await readJson(req));
            const result = await this.external.reconcile(
              raw,
              string(body.request_id, 'request_id', 128),
              string(body.run_id, 'run_id', 128),
              () =>
                this.store.authorizeControl(raw.parent_session, {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                }),
            );
            this.send(res, 200, result);
            return;
          }
        }
        throw new ServiceError('not_found', 'External worker route not found', 404);
      }
      if (bridge) {
        if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'worker')
          throw new ServiceError('not_found', 'Bridge route not found', 404);
        const authorization = req.headers.authorization;
        const value = await this.supervisor.bridge(
          parts[1]!,
          parts[2]!,
          authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
          object(await readJson(req)),
        );
        this.send(res, 200, value);
        return;
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'agentpod' &&
        parts.length === 3 &&
        req.method === 'POST'
      ) {
        if (!this.agentpod)
          throw new ServiceError(
            'authority_disabled',
            'AgentPod authority requires reviewed --agentpod-config pins',
          );
        const body = object(await readJson(req));
        if (parts[2] === 'attach') {
          this.send(
            res,
            200,
            this.agentpod.authenticate(
              string(body.admission_id, 'admission_id', 128),
              string(body.token, 'token', 128),
            ),
          );
          return;
        }
        if (parts[2] === 'status') {
          this.send(res, 200, this.agentpod.inspect(body.binding));
          return;
        }
        const request = string(body.request_id, 'request_id', 128);
        if (parts[2] === 'admit') {
          this.send(res, 200, this.agentpod.admit(body.binding, request));
          return;
        }
        if (parts[2] === 'renew') {
          this.send(
            res,
            200,
            this.agentpod.renew(
              body.binding,
              request,
              integer(body.lease_sequence, 'lease_sequence'),
            ),
          );
          return;
        }
        if (parts[2] === 'revoke') {
          const status = this.agentpod.revoke(
            body.binding,
            request,
            string(body.reason, 'reason', 1024),
          );
          this.scheduleRevocationStop(this.store.execution.revocation(status.session_id)!);
          this.send(res, 202, status);
          return;
        }
        throw new ServiceError('not_found', 'Unknown AgentPod authority method', 404);
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'job-occurrences' &&
        parts.length === 3 &&
        req.method === 'GET'
      ) {
        this.send(res, 200, this.jobs.occurrence(parts[2]!));
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'inbox') {
        if (req.method === 'GET') {
          this.send(
            res,
            200,
            parts.length === 2
              ? this.inbox.list(
                  integer(Number(url.searchParams.get('offset') ?? 0), 'offset'),
                  url.searchParams.get('session_id') ?? undefined,
                )
              : this.inbox.get(parts[2]!),
          );
          return;
        }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'ack') {
          const body = object(await readJson(req));
          if (
            Object.keys(body).some(
              (k) => !['client_id', 'token', 'request_id', 'expected_revision'].includes(k),
            )
          )
            throw new ServiceError('invalid_field', 'Unexpected inbox field', 400);
          this.send(
            res,
            200,
            this.inbox.ack(
              parts[2]!,
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              {
                client_id: string(body.client_id, 'client_id', 128),
                token: string(body.token, 'token', 128),
              },
            ),
          );
          return;
        }
        throw new ServiceError('not_found', 'Inbox route not found', 404);
      }
      if (parts[0] === 'v1' && parts[1] === 'schedules') {
        const offset = integer(Number(url.searchParams.get('offset') ?? 0), 'offset');
        if (req.method === 'GET') {
          this.send(
            res,
            200,
            parts.length === 2
              ? this.recurring.list(offset)
              : parts[3] === 'occurrences'
                ? this.recurring.occurrences(parts[2]!, offset)
                : this.recurring.view(parts[2]!),
          );
          return;
        }
        if (
          req.method === 'POST' &&
          (parts.length === 2 || (parts.length === 4 && ['update', 'run'].includes(parts[3]!)))
        ) {
          const body = object(await readJson(req));
          const allowed = [
            'client_id',
            'token',
            'request_id',
            'expected_revision',
            ...(parts.length === 2
              ? ['task_id', 'name', 'max_steps', 'compact', 'schedule']
              : parts[3] === 'run'
                ? ['occurrence_key']
                : ['schedule', 'state']),
          ];
          if (Object.keys(body).some((k) => !allowed.includes(k)))
            throw new ServiceError(
              'invalid_field',
              'Unexpected schedule field; triggers cannot change template authority',
              400,
            );
          const actor = {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            request = string(body.request_id, 'request_id', 128),
            expected = integer(body.expected_revision, 'expected_revision');
          const result =
            parts.length === 2
              ? this.recurring.create(
                  string(body.task_id, 'task_id', 128),
                  request,
                  expected,
                  string(body.name, 'name', 256),
                  integer(body.max_steps, 'max_steps'),
                  body.compact as boolean,
                  body.schedule,
                  actor,
                )
              : parts[3] === 'run'
                ? this.recurring.trigger(
                    parts[2]!,
                    request,
                    expected,
                    string(body.occurrence_key, 'occurrence_key', 128),
                    actor,
                  )
                : this.recurring.update(
                    parts[2]!,
                    request,
                    expected,
                    body.schedule,
                    body.state,
                    actor,
                  );
          this.send(res, parts[3] === 'run' ? 202 : 200, result);
          return;
        }
        throw new ServiceError('not_found', 'Schedule route not found', 404);
      }
      if (parts[0] === 'v1' && parts[1] === 'jobs') {
        if (req.method === 'GET' && parts.length === 2) {
          this.send(
            res,
            200,
            this.jobs.list(integer(Number(url.searchParams.get('offset') ?? 0), 'offset')),
          );
          return;
        }
        if (req.method === 'GET' && parts.length === 3) {
          this.send(res, 200, this.jobs.view(parts[2]!));
          return;
        }
        if (
          req.method === 'POST' &&
          (parts.length === 2 || (parts.length === 4 && ['run', 'cancel'].includes(parts[3]!)))
        ) {
          const body = object(await readJson(req));
          const allowed = new Set([
            'client_id',
            'token',
            'request_id',
            'expected_revision',
            ...(parts.length === 2
              ? ['task_id', 'name', 'max_steps', 'compact']
              : parts[3] === 'run'
                ? ['occurrence_key']
                : []),
          ]);
          if (Object.keys(body).some((key) => !allowed.has(key)))
            throw new ServiceError(
              'invalid_field',
              'Unexpected job field; triggers cannot change reviewed authority',
              400,
            );
          const controller = {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          };
          const request = string(body.request_id, 'request_id', 128),
            expected = integer(body.expected_revision, 'expected_revision');
          if (parts.length === 2) {
            const compact = body.compact ?? false;
            if (typeof compact !== 'boolean')
              throw new ServiceError('invalid_field', 'compact must be boolean', 400);
            const job = this.jobs.create(
              string(body.task_id, 'task_id', 128),
              request,
              expected,
              string(body.name, 'name', 256),
              integer(body.max_steps, 'max_steps'),
              compact,
              controller,
            );
            this.send(res, 201, this.jobs.view(job.id));
          } else if (parts[3] === 'run')
            this.send(
              res,
              202,
              this.jobs.trigger(
                parts[2]!,
                request,
                expected,
                string(body.occurrence_key, 'occurrence_key', 128),
                controller,
              ),
            );
          else
            this.send(res, 200, await this.jobs.cancel(parts[2]!, request, expected, controller));
          return;
        }
        throw new ServiceError('not_found', 'Job route not found', 404);
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'integrations' &&
        parts[2] &&
        parts.length === 4 &&
        parts[3] === 'resolve' &&
        req.method === 'POST'
      ) {
        const body = object(await readJson(req)),
          controller = {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          },
          parent = this.workerWorkspaces.owner(parts[2]);
        this.send(
          res,
          200,
          this.workerWorkspaces.resolve(
            parts[2],
            string(body.request_id, 'request_id', 128),
            integer(body.workspace_revision, 'workspace_revision'),
            string(body.workspace_digest, 'workspace_digest', 128),
            () => this.store.authorizeControl(parent, controller),
          ),
        );
        return;
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'integrations' &&
        parts[2] &&
        parts.length === 3 &&
        req.method === 'GET'
      ) {
        this.send(res, 200, this.workerWorkspaces.inspect(parts[2]));
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'workers' && parts[2] && parts.length === 4) {
        const child = this.store.db
          .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
          .get(parts[2]);
        if (!child) throw new ServiceError('not_found', 'Worker not found', 404);
        const parent = String(child.parent_session);
        if (parts[3] === 'proposal' && req.method === 'GET') {
          this.send(
            res,
            200,
            this.workerWorkspaces.proposal(
              parent,
              parts[2],
              integer(Number(url.searchParams.get('offset') ?? '0'), 'offset'),
            ),
          );
          return;
        }
        if (parts[3] === 'integrate' && req.method === 'POST') {
          const body = object(await readJson(req)),
            controller = {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            };
          this.send(
            res,
            200,
            this.workerWorkspaces.integrate(
              parent,
              parts[2],
              string(body.request_id, 'request_id', 128),
              integer(body.workspace_revision, 'workspace_revision'),
              string(body.workspace_digest, 'workspace_digest', 128),
              string(body.patch_digest, 'patch_digest', 128),
              () => this.store.authorizeControl(parent, controller),
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'tasks') {
        if (parts[2] && parts[3] === 'team') {
          const task = this.taskWork.get(parts[2]);
          if (req.method === 'GET' && parts.length === 4) {
            this.send(res, 200, this.team.view(task.id));
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            const request = string(body.request_id, 'request_id', 128);
            const controller = {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            };
            const authorize = () => this.store.authorizeControl(task.session_id, controller);
            let result: unknown;
            if (parts.length === 5 && parts[4] === 'assign') {
              if (body.runtime !== undefined && body.requests !== undefined)
                throw new ServiceError(
                  'worker_budget_scope',
                  'Use invocations for an external runtime; requests always means model requests',
                  400,
                );
              result = this.team.assign(
                task.id,
                string(body.step_id, 'step_id', 128),
                string(body.profile_id, 'profile_id', 128),
                integer(
                  body.runtime === undefined ? body.requests : body.invocations,
                  body.runtime === undefined ? 'requests' : 'invocations',
                ),
                request,
                integer(body.expected_revision, 'expected_revision'),
                controller,
                body.runtime === undefined ? undefined : string(body.runtime, 'runtime', 128),
              );
            } else if (parts.length === 5 && parts[4] === 'send') {
              result = this.team.send(
                task.id,
                'operator',
                string(body.recipient, 'recipient', 128),
                string(body.text, 'text', 4096),
                request,
                authorize,
              );
            } else if (parts.length === 6 && parts[4]) {
              const assignment = this.team.get(parts[4]);
              if (assignment.task_id !== task.id)
                throw new ServiceError('team_message_scope', 'Assignment belongs to another task');
              if (parts[5] === 'run')
                result = this.team.run(
                  assignment.id,
                  request,
                  integer(body.expected_revision, 'expected_revision'),
                  integer(body.generation, 'generation'),
                  body.instruction == null ? null : string(body.instruction, 'instruction', 4096),
                  body.continues_attempt_id == null
                    ? null
                    : string(body.continues_attempt_id, 'continues_attempt_id', 128),
                  controller,
                );
              else if (parts[5] === 'reject')
                result = this.team.reject(
                  assignment.id,
                  request,
                  integer(body.expected_revision, 'expected_revision'),
                  integer(body.generation, 'generation'),
                  string(body.reason, 'reason', 4096),
                  controller,
                );
              else if (parts[5] === 'receive')
                result = this.team.receive(assignment.id, request, authorize);
              else if (parts[5] === 'ack')
                result = this.team.acknowledge(
                  assignment.id,
                  string(body.message_id, 'message_id', 128),
                  request,
                  authorize,
                );
              else throw new ServiceError('not_found', 'Team action not found', 404);
            } else throw new ServiceError('not_found', 'Team route not found', 404);
            this.send(res, 200, result);
            return;
          }
          throw new ServiceError('not_found', 'Team route not found', 404);
        }
        if (req.method === 'GET' && parts.length === 2) {
          const session = string(url.searchParams.get('session_id'), 'session_id', 128);
          this.store.session(session);
          const current = this.taskWork.forSession(session);
          this.send(res, 200, current ? this.taskDriver.view(current.id) : null);
          return;
        }
        const taskId = parts[2];
        if (
          req.method === 'GET' &&
          taskId &&
          parts.length === 4 &&
          ['checkpoints', 'restores'].includes(parts[3]!)
        ) {
          this.taskWork.get(taskId);
          this.send(
            res,
            200,
            parts[3] === 'checkpoints'
              ? this.taskCheckpoints.list(taskId)
              : this.taskCheckpoints.restores(taskId),
          );
          return;
        }

        if (req.method === 'GET' && taskId && parts.length === 3) {
          this.send(res, 200, this.taskDriver.view(taskId));
          return;
        }
        if (req.method === 'GET' && taskId && parts.length === 4 && parts[3] === 'history') {
          this.send(
            res,
            200,
            this.taskWork.history(
              taskId,
              integer(Number(url.searchParams.get('offset') ?? '0'), 'offset'),
            ),
          );
          return;
        }
        if (req.method === 'POST') {
          const body = object(await readJson(req));
          const controller = {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          };
          const request = string(body.request_id, 'request_id', 128);
          const expected = integer(body.expected_revision, 'expected_revision');
          if (parts.length === 2) {
            const task = this.taskWork.create(
              string(body.session_id, 'session_id', 128),
              request,
              expected,
              body.plan,
              controller,
            );
            this.send(res, 201, this.taskDriver.view(task.id));
            return;
          }
          if (
            taskId &&
            parts.length === 4 &&
            ['verify', 'finish', 'checkpoint', 'restore', 'auto', 'cancel'].includes(parts[3]!)
          ) {
            const task = this.taskWork.get(taskId),
              authorize = () => this.store.authorizeControl(task.session_id, controller);
            let result: unknown;
            if (parts[3] === 'verify')
              result = this.taskVerification.start(
                taskId,
                string(body.check_key, 'check_key', 64),
                body.step_id == null ? null : string(body.step_id, 'step_id', 128),
                request,
                expected,
                authorize,
              );
            else if (parts[3] === 'finish') {
              const exception = body.exception == null ? null : object(body.exception);
              this.taskVerification.finish(
                taskId,
                request,
                expected,
                exception
                  ? {
                      reason: string(exception.reason, 'reason', 4096),
                      evidence_artifact: string(
                        exception.evidence_artifact,
                        'evidence_artifact',
                        128,
                      ),
                    }
                  : null,
                authorize,
              );
              result = this.taskDriver.view(taskId);
            } else if (parts[3] === 'checkpoint')
              result = this.taskCheckpoints.capture(taskId, request, expected, authorize);
            else if (parts[3] === 'restore')
              result = this.taskCheckpoints.restore(
                taskId,
                string(body.checkpoint_id, 'checkpoint_id', 128),
                request,
                expected,
                integer(body.workspace_revision, 'workspace_revision'),
                string(body.workspace_digest, 'workspace_digest', 128),
                authorize,
              );
            else if (parts[3] === 'auto') {
              if (body.compact !== undefined && typeof body.compact !== 'boolean')
                throw new ServiceError('invalid_field', 'compact must be boolean', 400);
              this.taskDriver.configure(
                taskId,
                request,
                expected,
                integer(body.max_steps, 'max_steps'),
                body.compact === true,
                controller,
              );
              result = this.taskDriver.view(taskId);
            } else {
              await this.taskDriver.cancel(taskId, request, expected, controller);
              result = this.taskDriver.view(taskId);
            }
            this.send(res, 200, result);
            return;
          }
          if (taskId && parts.length === 4 && parts[3] === 'revise') {
            this.send(
              res,
              200,
              (this.taskWork.revise(taskId, request, expected, body.plan, controller),
              this.taskDriver.view(taskId)),
            );
            return;
          }
          if (taskId && parts.length === 6 && parts[3] === 'steps' && parts[4]) {
            if (parts[5] === 'run') {
              this.send(
                res,
                202,
                this.taskWork.run(
                  taskId,
                  parts[4],
                  request,
                  expected,
                  body.instruction == null ? null : string(body.instruction, 'instruction', 4096),
                  body.continues_attempt_id == null
                    ? null
                    : string(body.continues_attempt_id, 'continues_attempt_id', 128),
                  controller,
                ),
              );
              return;
            }
            if (parts[5] === 'complete') {
              this.send(
                res,
                200,
                (this.taskWork.complete(
                  taskId,
                  parts[4],
                  request,
                  expected,
                  string(body.review, 'review', 4096),
                  controller,
                ),
                this.taskDriver.view(taskId)),
              );
              return;
            }
          }
        }
      }
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        const sessions = this.store.sessions().map((x) => this.supervisor.inspect(x.id));
        this.send(res, 200, {
          host_manifest_digest: this.hostManifestDigest,
          host_supervisor_connected: this.hostManifestDigest ? process.connected === true : null,
          runtime_node: realpathSync(process.execPath),
          service_version: VERSION,
          agentpod_config: this.agentpod?.configPath ?? null,
          agentpod_pins_digest: this.agentpod ? digest(this.agentpod.pins) : null,
          service: 'healthy',
          a2a: {
            inbound_enabled: !!this.a2aInbound,
            listener: this.a2aInbound?.server.address() ?? null,
            wire_version: '1.0',
            remote_execution: 'unobserved',
            inbound_authority: 'one-use-native-analysis-assignment',
          },
          external_workers: {
            control: this.external.status(),
            runtimes: this.external.runtimes(),
            opaque_budget: 'explicit-invocations-only',
            unknown_model_usage: true,
            uncertain_stops: Number(
              this.store.db
                .prepare(
                  "SELECT count(*) AS n FROM external_runs WHERE stopped=0 AND state='unknown'",
                )
                .get()!.n,
            ),
          },
          job_execution: {
            durable_jobs: true,
            one_shot_triggers: !!this.coding.executor,
            recurring_schedules: !!this.coding.executor,
            schedule_control_error: this.recurring.controlError,
            inbox_control_error: this.inbox.controlError,
            durable_operator_inbox: true,
            public_triggers: false,
            control_error: this.jobs.controlError,
          },
          task_execution: {
            durable_tasks: this.supervisor.providerCapabilities().durable_tasks,
            explicit_steps: true,
            automatic_progression: 'operator-bounded-opt-in',
            verified_completion: !!this.coding.executor,
            verification_supported: true,
            task_budgets: true,
            task_token_budgets: this.supervisor.providerCapabilities().output_token_cap,
            checkpoints: true,
            deterministic_compaction: 'operator-bounded-idle-only',
          },
          provider_route: this.supervisor.route,
          provider_capabilities: this.supervisor.providerCapabilities(),
          effect_connector: this.managed.options.connector?.id ?? null,
          coding_root: this.workspaces.root ?? null,
          coding_socket: this.codingSocket,
          execution: this.workspaces.root
            ? {
                available: !!this.coding.executor,
                coding_tools: true,
                file_tools: true,
                commands: !!this.coding.executor,
                backend: this.coding.executor?.evidence ?? null,
              }
            : EXECUTION_STATUS,
          sessions: sessions.map((x) => ({
            id: x.id,
            state: x.state,
            error: x.error,
            capabilities: x.capabilities,
            pending_approvals: this.store
              .approvals(x.id)
              .filter((approval) => approval.state === 'pending').length,
            unresolved_operations: this.store.hasUnknown(x.id),
          })),
        });
        return;
      }
      if (url.pathname === '/v1/shutdown' && req.method === 'POST') {
        this.send(res, 200, { stopping: true });
        setImmediate(() => {
          void this.close().catch(() => {
            console.error('Salaam stopped with a persistence error');
            process.exitCode = 1;
          });
        });
        return;
      }
      if (url.pathname === '/v1/sessions' && req.method === 'GET') {
        this.send(
          res,
          200,
          this.store.sessions().map((x) => this.supervisor.inspect(x.id)),
        );
        return;
      }
      if (url.pathname === '/v1/sessions' && req.method === 'POST') {
        if (this.agentpod)
          throw new ServiceError(
            'admission_required',
            'This daemon requires a trusted AgentPod admission; unbound session creation is disabled',
          );
        const body = object(await readJson(req));
        const cwd = realpathSync(string(body.cwd, 'cwd'));
        if (!statSync(cwd).isDirectory())
          throw new ServiceError('invalid_workspace', 'Workspace must be a directory', 400);
        if (body.coding !== undefined && typeof body.coding !== 'boolean')
          throw new ServiceError('invalid_field', 'coding must be a boolean', 400);
        if (body.coding && !this.workspaces.root)
          throw new ServiceError('coding_disabled', 'Start with an explicit --coding-root');
        const session = this.store.create(
          cwd,
          string(body.request_id, 'request_id', 128),
          body.coding === true,
        );
        if (body.coding) this.workspaces.import(session.id, cwd);
        if (this.store.session(session.id).state === 'stopped')
          void this.supervisor.start(session.id).catch(() => {});
        this.send(res, 201, session);
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'compactions' && parts[2]) {
        const work = this.tasks.compaction(parts[2]);
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, work);
          return;
        }
        if (parts[3] === 'cancel' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.send(
            res,
            202,
            this.supervisor.cancelCompaction(
              work.id,
              string(body.request_id, 'request_id', 128),
              () =>
                this.store.authorizeControl(work.session_id, {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                }),
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];
        if (parts.length === 4 && parts[3] === 'revocation' && req.method === 'GET') {
          this.send(res, 200, this.store.execution.revocation(id));
          return;
        }
        if (parts.length === 4 && parts[3] === 'revoke' && req.method === 'POST') {
          const body = object(await readJson(req));
          const request = string(body.request_id, 'request_id', 128);
          const receipt = this.store.execution.revoke(
            id,
            request,
            integer(body.expected_revision, 'expected_revision'),
            string(body.reason, 'reason', 1024),
            {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            (attempt) => {
              this.managed.cancelInTransaction(attempt, request, 'session-revocation');
            },
          );
          // The receipt commits before any asynchronous process/executor cleanup.
          // Cleanup failure never restores authority or implies a confirmed stop.
          this.scheduleRevocationStop(receipt);
          this.send(res, 202, receipt);
          return;
        }
        if (parts[3] === 'agents') {
          if (req.method === 'GET') {
            const profile = url.searchParams.get('profile');
            this.send(
              res,
              200,
              profile
                ? {
                    ...this.agents.inspect(id, profile),
                    digest: digest(this.agents.inspect(id, profile)),
                  }
                : this.agents.list(id).map((p) => ({ ...p, digest: digest(p) })),
            );
            return;
          }
          const body = object(await readJson(req));
          const controller = {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          };
          const request = string(body.request_id, 'request_id', 128);
          if (parts[4] === 'admit') {
            const facts =
              body.fact_ids === undefined
                ? []
                : Array.isArray(body.fact_ids)
                  ? body.fact_ids.map((x) => string(x, 'fact_id', 128))
                  : (() => {
                      throw new ServiceError('invalid_field', 'fact_ids must be an array');
                    })();
            this.send(
              res,
              201,
              await this.agents.admit(
                id,
                request,
                string(body.profile_id, 'profile_id', 128),
                string(body.expected_digest, 'expected_digest', 64),
                facts,
                controller,
              ),
            );
            return;
          }
          if (parts[4] === 'revoke') {
            this.send(
              res,
              200,
              this.agents.revoke(id, string(body.grant_id, 'grant_id', 128), request, controller),
            );
            return;
          }
          throw new ServiceError('not_found', 'Agent operation not found', 404);
        }
        if (parts[3] === 'activity' && req.method === 'GET') {
          this.store.session(id);
          const rows = this.store.db
            .prepare(
              "SELECT seq,kind,payload FROM events WHERE session_id=? AND kind IN ('tool.started','tool.finished') ORDER BY seq DESC LIMIT 200",
            )
            .all(id);
          let bytes = 0;
          const page = [];
          for (const row of rows) {
            bytes += Buffer.byteLength(String(row.payload)) + 128;
            if (bytes > 1024 * 1024) break;
            page.push({ seq: row.seq, kind: row.kind, payload: JSON.parse(String(row.payload)) });
          }
          this.send(res, 200, page.reverse());
          return;
        }
        if (parts[3] === 'workspace') {
          if (req.method === 'GET') {
            this.send(
              res,
              200,
              parts[4] === 'diff'
                ? this.workspaces.diff(
                    id,
                    integer(Number(url.searchParams.get('offset') ?? 0), 'offset'),
                  )
                : this.workspaces.inspect(id),
            );
            return;
          }
          if (req.method === 'POST' && parts[4] === 'refresh') {
            const body = object(await readJson(req));
            this.send(
              res,
              200,
              this.workspaces.refresh(
                id,
                string(body.request_id, 'request_id', 128),
                integer(body.expected_revision, 'expected_revision'),
                string(body.digest, 'digest', 128),
                () => {
                  this.store.authorizeControl(id, {
                    client_id: string(body.client_id, 'client_id', 128),
                    token: string(body.token, 'token', 128),
                  });
                  this.supervisor.assertIdle(id);
                },
              ),
            );
            return;
          }
        }
        if (parts[3] === 'commands') {
          if (req.method === 'GET') {
            this.send(
              res,
              200,
              parts[4]
                ? parts[5] === 'logs'
                  ? this.coding.logs(
                      id,
                      parts[4],
                      integer(Number(url.searchParams.get('offset') ?? 0), 'offset'),
                    )
                  : this.coding.get(id, parts[4])
                : this.coding.list(id, url.searchParams.get('summary') === '1'),
            );
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            const authorize = () => {
              this.store.authorizeControl(id, {
                client_id: string(body.client_id, 'client_id', 128),
                token: string(body.token, 'token', 128),
              });
            };
            if (!parts[4]) {
              this.send(
                res,
                202,
                this.coding.start(id, null, body, () => {
                  authorize();
                  this.supervisor.assertIdle(id);
                }),
              );
              return;
            }
            if (parts[5] === 'cancel') {
              this.send(
                res,
                202,
                this.coding.cancel(
                  id,
                  parts[4],
                  string(body.request_id, 'request_id', 128),
                  authorize,
                ),
              );
              return;
            }
            if (parts[5] === 'reconcile') {
              authorize();
              this.send(res, 202, this.coding.reconcile(id, parts[4]));
              return;
            }
          }
        }
        if (parts[3] === 'task' && req.method === 'GET') {
          this.send(res, 200, this.tasks.state(id));
          return;
        }
        if (parts[3] === 'history' && req.method === 'GET') {
          this.send(
            res,
            200,
            this.tasks.history(
              id,
              Object.fromEntries(
                [...url.searchParams].map(([k, v]) => [k, k === 'offset' ? Number(v) : v]),
              ),
            ),
          );
          return;
        }
        if (
          (parts[3] === 'task' || parts[3] === 'compact' || parts[3] === 'artifacts') &&
          req.method === 'POST'
        ) {
          const body = object(await readJson(req));
          const authorize = () => {
            this.store.authorizeControl(id, {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            });
            this.supervisor.assertIdle(id);
          };
          const request = string(body.request_id, 'request_id', 128);
          if (parts[3] === 'artifacts') {
            this.send(
              res,
              201,
              this.tasks.putArtifact(id, request, string(body.text, 'text', 256 * 1024), authorize),
            );
            return;
          }
          const expected = integer(body.expected_version, 'expected_version');
          this.send(
            res,
            parts[3] === 'compact' ? 202 : 200,
            parts[3] === 'task'
              ? this.tasks.update(id, request, expected, object(body.fact), authorize)
              : this.supervisor.compact(id, request, expected, authorize),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'approvals') {
        if (parts.length === 2 && req.method === 'GET') {
          const id = url.searchParams.get('session');
          this.managed.expire();
          this.send(res, 200, id ? this.store.approvals(id) : this.managed.pending());
          return;
        }
        if (parts[2] && parts.length === 3 && req.method === 'GET') {
          this.managed.expire();
          this.send(res, 200, this.managed.approval(parts[2]));
          return;
        }
        if (parts[2] && parts[3] === 'decision' && req.method === 'POST') {
          const body = object(await readJson(req));
          const decision = string(body.decision, 'decision');
          if (decision !== 'approve' && decision !== 'deny')
            throw new ServiceError('invalid_field', 'Decision must be approve or deny', 400);
          this.send(
            res,
            200,
            this.managed.decide(
              parts[2],
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              string(body.operation_digest, 'operation_digest', 128),
              decision,
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'operations' && parts[2]) {
        const id = parts[2];
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, this.managed.operation(id));
          return;
        }
        if (parts[3] === 'reconcile' && req.method === 'POST') {
          const body = object(await readJson(req));
          const request = string(body.request_id, 'request_id', 128);
          const input = { kind: 'reconcile-operation', id };
          const saved = this.store.cachedRequest('local-operator', request, input);
          if (saved !== undefined) {
            this.send(res, 200, saved);
            return;
          }
          const result = await this.managed.reconcile(id);
          this.send(
            res,
            200,
            this.store.request('local-operator', request, input, () => result),
          );
          return;
        }
        if (parts[3] === 'resolution' && req.method === 'POST') {
          const body = object(await readJson(req));
          const outcome = string(body.outcome, 'outcome');
          if (outcome !== 'succeeded' && outcome !== 'failed_definite')
            throw new ServiceError('invalid_field', 'Invalid resolution outcome', 400);
          this.send(
            res,
            200,
            this.managed.resolve(
              id,
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              string(body.operation_digest, 'operation_digest', 128),
              outcome,
              string(body.evidence, 'evidence', 4096),
            ),
          );
          return;
        }
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'attempts' &&
        parts[2] &&
        parts.length === 3 &&
        req.method === 'GET'
      ) {
        this.send(res, 200, this.store.attempt(parts[2]));
        return;
      }
      if (
        parts[0] === 'v1' &&
        parts[1] === 'attempts' &&
        parts[2] &&
        parts[3] === 'cancel' &&
        req.method === 'POST'
      ) {
        const body = object(await readJson(req));
        const attempt = parts[2];
        const receipt = this.managed.cancel(
          attempt,
          string(body.request_id, 'request_id', 128),
          integer(body.expected_revision, 'expected_revision'),
          {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          },
        );
        this.coding.cancelAttempt(attempt);
        const owned = this.children.owned(this.store.attempt(attempt).session_id);
        void (
          owned && this.store.workerBoundary.view(owned.id).binding.external
            ? this.external.cancel(owned)
            : this.children.cancelOwned(attempt).then(() => this.supervisor.cancelAttempt(attempt))
        ).catch((error) =>
          this.supervisor.failControl(this.store.attempt(attempt).session_id, error),
        );
        this.send(res, 202, receipt);
        return;
      }
      if (parts[0] === 'v1' && parts[1] === 'children' && parts[2]) {
        const child = this.store.db
          .prepare('SELECT parent_session FROM child_tasks WHERE id=?')
          .get(parts[2]) as { parent_session: string } | undefined;
        if (!child) throw new ServiceError('not_found', 'Child not found', 404);
        if (req.method === 'GET' && parts.length === 3) {
          this.send(res, 200, this.children.inspect(child.parent_session, parts[2]));
          return;
        }
        if (req.method === 'GET' && parts[3] === 'result') {
          const row = this.children.inspect(child.parent_session, parts[2]);
          this.send(
            res,
            200,
            this.children.consume(child.parent_session, row.id, row.result_id ?? ''),
          );
          return;
        }
        if (req.method === 'POST' && parts[3] === 'ack') {
          const body = object(await readJson(req));
          this.send(
            res,
            200,
            this.children.acknowledge(
              child.parent_session,
              parts[2],
              string(body.result_id, 'result_id', 128),
              string(body.request_id, 'request_id', 128),
            ),
          );
          return;
        }
      }
      if (parts[0] === 'v1' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2];
        if (parts[3] === 'children' && req.method === 'GET') {
          this.store.session(id);
          this.send(res, 200, this.children.list(id));
          return;
        }
        if (parts[3] === 'usage' && req.method === 'GET') {
          this.send(res, 200, this.store.usage.summary(id));
          return;
        }
        if (parts.length === 3 && req.method === 'GET') {
          this.send(res, 200, this.supervisor.inspect(id));
          return;
        }
        if (parts[3] === 'snapshot' && req.method === 'GET') {
          this.send(res, 200, {
            ...this.store.snapshot(id),
            inbox: this.inbox.list(0, id).items,
            recurring_occurrence:
              this.store.db
                .prepare('SELECT * FROM recurring_occurrences WHERE session_id=?')
                .get(id) ?? null,
            ...this.supervisor.inspect(id),
            job: this.jobs.forSession(id) ? this.jobs.view(this.jobs.forSession(id)!.id) : null,
            work_task: this.taskWork.forSession(id)
              ? this.taskDriver.view(this.taskWork.forSession(id)!.id)
              : null,
          });
          return;
        }
        if (parts[3] === 'control' && req.method === 'POST') {
          const body = object(await readJson(req));
          const action = string(body.action, 'action');
          if (!['acquire', 'renew', 'release', 'takeover'].includes(action))
            throw new ServiceError('invalid_field', 'Invalid control action', 400);
          this.send(
            res,
            200,
            this.store.control(
              id,
              string(body.request_id, 'request_id', 128),
              string(body.client_id, 'client_id', 128),
              action as 'acquire' | 'renew' | 'release' | 'takeover',
              integer(body.expected_epoch, 'expected_epoch'),
              body.token === undefined ? undefined : string(body.token, 'token', 128),
            ),
          );
          return;
        }
        if (parts[3] === 'resume' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          this.store.execution.assert(id);
          const session = this.supervisor.inspect(id);
          if (
            session.provider_route &&
            canonical(session.provider_route) !== canonical(this.supervisor.route)
          )
            throw new ServiceError(
              'provider_route_changed',
              'Restart the service with this session’s original provider route, or create a new session',
            );
          if (session.state !== 'ready' && session.state !== 'starting')
            void this.supervisor.start(id).catch(() => {});
          this.send(res, 202, this.supervisor.inspect(id));
          return;
        }
        if (parts[3] === 'events' && req.method === 'GET') {
          const raw = url.searchParams.get('after') ?? '0';
          if (!/^\d+$/.test(raw))
            throw new ServiceError('invalid_cursor', 'Invalid event cursor', 400);
          const after = integer(Number(raw), 'after');
          if (after > this.store.session(id).seq)
            throw new ServiceError('invalid_cursor', 'Cursor is ahead of session', 400);
          this.events(req, res, id, after);
          return;
        }
        if (parts[3] === 'submissions' && req.method === 'POST') {
          const body = object(await readJson(req));
          const submission = this.store.accept(
            id,
            string(body.request_id, 'request_id', 128),
            integer(body.expected_revision, 'expected_revision'),
            string(body.text, 'text', 256 * 1024),
            {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            body.continues_attempt_id === undefined
              ? null
              : string(body.continues_attempt_id, 'continues_attempt_id', 128),
          );
          this.send(res, 202, submission);
          return;
        }
        if (parts[3] === 'probe' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          if (body.nested !== undefined && typeof body.nested !== 'boolean')
            throw new ServiceError('invalid_field', 'Invalid nested flag', 400);
          this.send(res, 200, await this.supervisor.probe(id, body.nested === true));
          return;
        }
      }
      throw new ServiceError('not_found', 'Route not implemented', 404);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const value =
        error instanceof ServiceError
          ? error
          : new ServiceError('internal_error', 'Service operation failed', 500);
      this.send(res, value.status, { code: value.code, error: value.message });
    }
  }
  private events(req: IncomingMessage, res: ServerResponse, id: string, after: number): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    let cursor = after;
    let active = true;
    let scheduled = false;
    let blocked = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const write = (text: string) => {
      if (!res.write(text)) {
        blocked = true;
        drainTimer = setTimeout(() => res.destroy(), 10000);
        res.once('drain', () => {
          clearTimeout(drainTimer);
          blocked = false;
          schedule();
        });
      }
    };
    const pump = () => {
      scheduled = false;
      if (!active || blocked) return;
      try {
        const events = this.store.events(id, cursor);
        for (const event of events) {
          write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
          cursor = event.seq;
          if (blocked) return;
        }
        if (events.length === 256) schedule();
      } catch {
        res.destroy();
      }
    };
    const schedule = () => {
      if (!scheduled && active) {
        scheduled = true;
        setImmediate(pump);
      }
    };
    const change = (event: { session_id: string }) => {
      if (event.session_id === id) schedule();
    };
    this.store.changes.on('event', change);
    const preview = (value: { session_id: string }) => {
      if (value.session_id === id && !blocked && active)
        write(`event: preview\ndata: ${JSON.stringify(value)}\n\n`);
    };
    this.supervisor.on('preview', preview);
    schedule();
    const heartbeat = setInterval(() => {
      if (!blocked) write(': heartbeat\n\n');
    }, 15000);
    heartbeat.unref();
    const cleanup = () => {
      active = false;
      clearInterval(heartbeat);
      clearTimeout(drainTimer);
      this.store.changes.off('event', change);
      this.supervisor.off('preview', preview);
    };
    res.on('close', cleanup);
    req.on('error', cleanup);
  }
  async close(): Promise<void> {
    if (this.stopping) {
      await this.closed;
      return;
    }
    this.stopping = true;
    clearInterval(this.authorityTimer);
    this.inbox.close();
    this.recurring.close();
    this.jobs.close();
    await this.taskDriver.close();
    this.dispatcher.pause();
    this.managed.pause();
    this.children.pause();
    const errors: unknown[] = [];
    try {
      await this.a2aInbound?.close();
      await Promise.allSettled(this.revocationStops);
      await this.external.close();
      await this.coding.close();
      try {
        await this.children.close();
        await this.supervisor.close();
      } catch (error) {
        errors.push(error);
      }
      await this.dispatcher.drain();
      await this.managed.close();
      await Promise.all(
        [this.operator, this.bridgeServer].map(
          (server) =>
            new Promise<void>((resolve) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close(() => resolve());
              server.closeAllConnections();
            }),
        ),
      );
      await Promise.all(this.handlers);
      try {
        this.store.close();
      } catch (error) {
        errors.push(error);
      }
    } finally {
      this.release();
      this.resolveClosed();
    }
    if (errors.length)
      throw new AggregateError(errors, 'Service shutdown could not persist all final states');
  }
}
