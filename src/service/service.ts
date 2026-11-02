// The Salaam service: builds the object graph, owns the operator and worker-bridge sockets, and
// runs recovery, timers and shutdown. Requests go to the route tables in routes.ts.
import {
  readFileSync,
  mkdirSync,
  chmodSync,
  chownSync,
  existsSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import {
  DangerClassifier,
  loadDangerClassifierOptions,
  ApprovalRules,
  chooseLocalSandbox,
  resolveReadPaths,
  LocalCoding,
  type LocalSandbox,
  Hooks,
  probeToolsUser,
  serviceToolIdentity,
  type ToolIdentity,
} from '../local/index.js';
import { WebSearch, loadWebSearchConfig } from '../web/index.js';
import {
  loadPersona,
  TaskContext,
  ContextAdmission,
  ProjectInstructions,
  userInstructionsPath,
  Supervisor,
  Dispatcher,
  AgentProfiles,
  TurnCancellations,
  TurnCheckpoints,
} from '../runtime/index.js';
import { acquireStateLock, ServiceError } from '../core/index.js';
import {
  TaskWork,
  TaskBudget,
  RunGrants,
  TaskCritic,
  TaskVerification,
  TaskCheckpoints,
  TaskDriver,
  OperatorInbox,
  RecurringWork,
  JobWork,
  TeamWork,
} from '../tasks/index.js';
import {
  AgentPodWork,
  AgentPodAuthority,
  readAgentPodPins,
  StationWork,
  StationTaskVerification,
} from '../agentpod/index.js';
import {
  Store,
  Artifacts,
  resolvedToolkitCallSql,
  type SessionRevocation,
} from '../store/index.js';
import { ManagedWork, engineRequest } from '../execution/index.js';
import {
  ChildWork,
  RepositorySnapshots,
  WorkerWorkspaces,
  ExternalWork,
} from '../workers/index.js';
import { DockerCodingExecutor, Workspaces, CodingWork } from '../coding/index.js';
import { DockerHarnessBackend } from '../harness/index.js';
import { A2AInbound, A2ABackend, ExternalBackends } from '../a2a/index.js';
import {
  ToolkitResources,
  cancelToolkitCalls,
  recoverToolkitCalls,
  ToolkitOwners,
  ToolkitResolutions,
  ToolkitWork,
  readToolkitConfig,
} from '../toolkit/index.js';
import { OperatorMcp, McpAdmission, McpWork } from '../mcp/index.js';
import type { ServiceOptions } from './options.js';
import { CommandReviewers } from './reviewers.js';
import { Router } from './router.js';
import {
  BRIDGE_NOT_FOUND,
  OPERATOR_NOT_FOUND,
  bridgeRoutes,
  controllers,
  operatorRoutes,
} from './routes.js';

export type { ServiceOptions } from './options.js';

export class SalaamService {
  operatorMcpPath?: string;
  readonly agentpod?: AgentPodAuthority;
  readonly agentpodWork?: AgentPodWork;
  readonly toolkitResources: ToolkitResources;
  readonly toolkitOwners: ToolkitOwners;
  readonly toolkitResolutions: ToolkitResolutions;
  readonly mcp?: McpWork;
  readonly toolkit?: ToolkitWork;
  readonly station?: StationWork;
  readonly cancellations: TurnCancellations;
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
  readonly localCoding: LocalCoding;
  readonly toolIdentity: ToolIdentity;
  readonly codingSocket: string | null;
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private operator: Server;
  private bridgeServer: Server;
  private release: () => void;
  private stopping = false;
  private shutdownFailure?: AggregateError;
  private handlers = new Set<Promise<void>>();
  private revocationStops = new Set<Promise<void>>();
  private authorityTimer?: NodeJS.Timeout;
  readonly hostManifestDigest: string | null;
  readonly hostReceipt: Record<string, unknown> | null;
  private readonly operatorAccess: { group: string; gid: number } | null;
  readonly agentpodWorkProgression: boolean;
  /** Phase 2b: whether interactive sessions here may choose full access (no OS sandbox). */
  readonly allowFullAccessSessions: boolean;
  readonly allowYoloSessions: boolean;
  readonly reviewers = new CommandReviewers();
  private readonly operatorRouter: Router;
  private readonly bridgeRouter: Router;
  private constructor(options: ServiceOptions) {
    this.allowFullAccessSessions = options.allowFullAccessSessions !== false;
    this.allowYoloSessions = options.allowYoloSessions !== false;
    this.agentpodWorkProgression = options.agentpodWorkProgression === true;
    if (this.agentpodWorkProgression && (!options.stationConfig || !options.agentpodConfig))
      throw Error('Strict work requires reviewed AgentPod protected station configuration');
    this.hostManifestDigest = options.hostManifestDigest ?? null;
    this.hostReceipt = options.hostManifestDigest ? (options.hostReceipt ?? null) : null;
    if (options.operatorAccess && !this.agentpodWorkProgression)
      throw Error('Operator group access is only for the strict work launcher profile');
    this.operatorAccess = options.operatorAccess ?? null;
    if (process.platform === 'win32') throw new Error('Windows transport is not implemented');
    this.stateDir = resolve(options.stateDir);
    if (options.managedMcp && !options.agentpodConfig)
      throw Error('Managed MCP requires reviewed AgentPod authority pins');
    if ((options.managedToolkit || options.managedToolkitConfig) && !options.agentpodConfig)
      throw Error('Native Toolkit requires reviewed AgentPod authority pins');
    if (options.stationConfig && !options.agentpodConfig)
      throw Error('Station execution requires reviewed AgentPod authority');
    if (options.managedToolkit && options.managedToolkitConfig)
      throw Error('Use one reviewed native Toolkit assignment');
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
        'AgentPod authority profile does not enable station writes, fixture effects or external runtimes',
      );
    this.codingSocket = options.codingSocket ? resolve(options.codingSocket) : null;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.stateDir = realpathSync(this.stateDir);
    this.toolIdentity = options.toolsUser
      ? probeToolsUser(options.toolsUser, this.stateDir, options.toolsLauncher)
      : serviceToolIdentity();
    const mcpAdmission = options.managedMcp
      ? new McpAdmission(
          options.managedMcp.config,
          readAgentPodPins(resolve(options.agentpodConfig!), this.stateDir),
          options.managedMcp.profile_digest,
        )
      : undefined;
    this.socket = join(this.stateDir, 'operator.sock');
    this.bridgeSocket = join(this.stateDir, 'bridge.sock');
    if (Buffer.byteLength(this.bridgeSocket) > 100)
      throw new Error(
        `State path is too long for a Unix socket (${Buffer.byteLength(this.bridgeSocket)} bytes; the limit is 100): ` +
          'use the default (salaam code, no --state), or a shorter --state or SALAAM_STATE_DIR such as /tmp/salaam-state.',
      );
    this.release = acquireStateLock(this.stateDir);
    try {
      this.store = new Store(join(this.stateDir, 'journal.sqlite'));
      this.store.toolExecution = {
        mode: this.toolIdentity.mode,
        user: this.toolIdentity.user,
        uid: this.toolIdentity.uid,
      };
      try {
        this.artifacts = new Artifacts(join(this.stateDir, 'artifacts'), this.store);
        this.tasks = new TaskContext(this.store, this.artifacts);
        this.tasks.admitted = new ContextAdmission(this.store);
        this.tasks.instructions = new ProjectInstructions(
          this.store,
          this.artifacts,
          options.userInstructions === undefined
            ? userInstructionsPath()
            : options.userInstructions,
        );
        this.tasks.checkpoints = new TurnCheckpoints(
          this.store,
          this.stateDir,
          this.toolIdentity.mode !== 'tools-user',
        );
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
        // Item 8: the completion critic. Its reviewer grant is the narrow built-in one, admitted
        // only while the task's admitted plan still declares a critic.
        this.taskVerification.critic = new TaskCritic(this.store, this.artifacts, {
          admit: (task, request) =>
            this.agents.admitCritic(task.session_id, request, () => {
              if (!this.taskWork.get(task.id).completion_gate?.critic)
                throw new ServiceError('authority_denied', 'The admitted plan declares no critic');
            }),
          spawn: (task, parentAttempt, step, prompt, budget, grant, snapshot) =>
            this.children.spawnCritic(
              task.session_id,
              parentAttempt,
              step,
              prompt,
              budget,
              grant,
              snapshot,
            ),
          workerId: (childId) => this.store.workerBoundary.view(childId).binding.worker_id,
        });
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
        if (options.personaConfig) {
          const persona = loadPersona(options.personaConfig.config);
          if (persona.digest !== options.personaConfig.digest)
            throw Error('Host persona changed; run host plan again');
          this.supervisor.persona = persona;
        }
        if (options.operatorMcpConfig) {
          this.operatorMcpPath = options.operatorMcpConfig;
          this.supervisor.operatorMcp = OperatorMcp.load(
            options.operatorMcpConfig,
            options.operatorMcpEnvironment ?? process.env,
          );
        }
        this.taskWork.providerCheck = (limits, session) =>
          this.supervisor.assertTaskProviderSupported(
            limits,
            session ? this.store.localOutputCap(session) : undefined,
          );
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
        // Item 10: Linux runs local commands under bubblewrap and macOS under Seatbelt when
        // usable; a host with neither refuses them unless the operator allowed them unsandboxed.
        const localSandbox: LocalSandbox = {
          ...chooseLocalSandbox(options.localSandbox ?? 'workspace-write'),
          allowUnsandboxed: options.unsandboxedCommands === 'allow',
          ...(options.localSandboxReadPaths?.length
            ? { readPaths: resolveReadPaths(options.localSandboxReadPaths) }
            : {}),
          ...(options.commandNetwork ? { network: { socket: options.commandNetwork.socket } } : {}),
        };
        this.localCoding = new LocalCoding(
          this.store,
          this.managed,
          (id, epoch, attempt) => this.supervisor.assertActive(id, epoch, attempt),
          this.toolIdentity,
          localSandbox,
        );
        this.localCoding.rules = new ApprovalRules(this.store, options.permissionsFile);
        this.localCoding.interactive = (id) => this.supervisor.isInteractiveCoding(id);
        this.localCoding.allowOutsideSandbox = this.allowFullAccessSessions;
        this.supervisor.localCoding = this.localCoding;
        if (options.dangerClassifierConfig) {
          const loaded = loadDangerClassifierOptions(
            JSON.parse(readFileSync(options.dangerClassifierConfig, 'utf8')),
          );
          for (const o of loaded.options)
            this.reviewers.options.set(o.name, new DangerClassifier(o));
          this.reviewers.default = loaded.default;
        }
        if (options.dangerClassifierPin !== undefined) {
          if (
            options.dangerClassifierPin !== 'off' &&
            !this.reviewers.options.has(options.dangerClassifierPin)
          )
            throw Error(
              `The pinned command reviewer ${options.dangerClassifierPin} is not configured`,
            );
          this.reviewers.pin = options.dangerClassifierPin;
        }
        if (this.reviewers.options.size) {
          this.store.db.exec(
            'CREATE TABLE IF NOT EXISTS danger_classifier_choice(session_id TEXT PRIMARY KEY, choice TEXT NOT NULL)',
          );
          this.localCoding.classifier = {
            review: (s, command, cwd) => {
              const reviewer = this.reviewers.options.get(this.reviewers.choice(this.store, s));
              return reviewer ? reviewer.review(s, command, cwd) : Promise.resolve(null);
            },
          };
        }
        const local = this.localCoding;
        this.supervisor.hooks = new Hooks(
          this.store,
          (session, command, input, timeout) => local.runHook(session, command, input, timeout),
          options.hooksFile,
        );
        const webConfig = options.webSearchConfig
          ? loadWebSearchConfig(options.webSearchConfig)
          : { providers: [] };
        this.supervisor.web = new WebSearch(webConfig);
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
              this.mcp?.cancelInTransaction(attempt, 'agentpod-revocation');
              this.station?.cancelInTransaction(attempt);
              cancelToolkitCalls(this.store, this.managed, attempt, this.toolkitResources);
            },
            (session) =>
              (this.mcp?.stopped(session) ?? true) &&
              this.toolkitResources.stopped(session) &&
              (this.station?.stopped(session) ?? true),
          );
        this.toolkitResources = new ToolkitResources(this.store, this.agentpod);
        this.toolkitOwners = new ToolkitOwners(this.store, this.toolkitResources, this.socket);
        this.toolkitResolutions = new ToolkitResolutions(
          this.store,
          this.managed,
          this.toolkitResources,
          this.toolkitOwners,
        );
        this.store.nativeResourceCheck = (session) => {
          this.toolkitResources.assertSession(session);
          this.station?.assertResources(session);
        };
        if (options.managedToolkit || options.managedToolkitConfig) {
          if (!this.agentpod)
            throw new Error('Native Toolkit requires AgentPod execution authority');
          this.toolkit = new ToolkitWork(
            this.store,
            this.managed,
            this.agentpod,
            this.toolkitResources,
            this.toolkitOwners,
            options.managedToolkit ??
              readToolkitConfig(
                options.managedToolkitConfig!.config,
                options.managedToolkitConfig!.configuration_digest,
                this.agentpod.pins.workspace,
              ),
            {
              configurationCheck: () => {
                if (options.managedToolkitConfig)
                  readToolkitConfig(
                    options.managedToolkitConfig.config,
                    options.managedToolkitConfig.configuration_digest,
                    this.agentpod!.pins.workspace,
                  );
              },
              assertActive: (session, epoch, attempt) =>
                this.supervisor.assertActive(session, epoch, attempt),
              failed: (session, error) => this.supervisor.failControl(session, error),
            },
          );
          this.supervisor.toolkit = this.toolkit;
        }
        this.taskDriver.awaitingAuthorityRenewal = (session) =>
          this.agentpod?.awaitingRenewal(session) ?? false;
        if (options.stationConfig) {
          if (!this.agentpod) throw Error('Station execution requires AgentPod authority');
          this.station = new StationWork(
            this.store,
            this.managed,
            this.artifacts,
            this.agentpod,
            options.stationConfig,
            this.stateDir,
            {
              assertActive: (session, epoch, attempt) =>
                this.supervisor.assertActive(session, epoch, attempt),
              failed: (session, error) => this.supervisor.failControl(session, error),
            },
          );
          this.supervisor.station = this.station;
          // "Approve for this run": one grant store for decisions and the station.
          this.station.grants = this.runGrants();
          this.station.grantScope = (session) => {
            const row = this.store.db
              .prepare('SELECT task_id FROM agentpod_work WHERE session_id=?')
              .get(session) as { task_id?: string } | undefined;
            if (!row?.task_id) return null;
            const task = this.taskWork.get(row.task_id);
            return { task_id: task.id, plan_revision: task.plan_revision, task_state: task.state };
          };
          const station = this.station;
          this.taskVerification.installStation(
            (v) => new StationTaskVerification(v.store, v.tasks, v, station, v.artifacts),
          );
          this.agentpodWork = new AgentPodWork(
            this.store,
            this.agentpod,
            this.taskWork,
            this.taskVerification,
          );
          const cancelOwned = this.store.cancelChildren;
          this.store.cancelChildren = (attempt) => {
            cancelOwned?.(attempt);
            this.station!.cancelInTransaction(attempt);
          };
        }
        if (options.managedMcp) {
          this.mcp = new McpWork(this.store, this.managed, this.artifacts, {
            admission: mcpAdmission!,
            current: (session) => this.agentpod!.binding(session),
            assertActive: (session, epoch, attempt) =>
              this.supervisor.assertActive(session, epoch, attempt),
            failed: (session, error) => this.supervisor.failControl(session, error),
          });
          this.supervisor.mcp = this.mcp;
        }
        this.cancellations = new TurnCancellations(
          this.store,
          this.managed,
          (id) => this.supervisor.attemptActive(id),
          async (attempt) => {
            this.managed.abortCancelled(attempt);
            this.mcp?.abortAttempt(attempt);
            this.toolkit?.abortAttempt(attempt);

            const stopped = await Promise.allSettled([
              this.station?.abortAttempt(attempt),
              this.toolkitResources.stopAttempt(attempt),
              (async () => {
                this.coding.cancelAttempt(attempt);
                const owned = this.children.owned(this.store.attempt(attempt).session_id);
                if (owned && this.store.workerBoundary.view(owned.id).binding.external)
                  await this.external.cancel(owned);
                else {
                  await this.children.cancelOwned(attempt);
                  await this.supervisor.cancelAttempt(attempt);
                }
              })(),
            ]);
            const failures = stopped.filter((r) => r.status === 'rejected');
            if (failures.length)
              throw new AggregateError(
                failures.map((r) => r.reason),
                'Turn resource stop is unconfirmed',
              );
          },
        );
        this.cancellations.cancelAdditional = (attempt) => {
          this.mcp?.cancelInTransaction(attempt);
          this.station?.cancelInTransaction(attempt);
          cancelToolkitCalls(this.store, this.managed, attempt, this.toolkitResources);
        };
        this.cancellations.additionalResources = (session, attempt) => [
          ...(this.station?.unconfirmed(session, attempt) ?? []),
          ...(this.mcp && !this.mcp.stopped(session) ? ['managed-mcp:' + session] : []),
          ...(this.store.db
            .prepare(
              "SELECT 1 FROM toolkit_resources r JOIN toolkit_calls c ON c.resource_id=r.id WHERE c.attempt_id=? AND c.cancel_requested=1 AND r.state!='stopped' LIMIT 1",
            )
            .get(attempt)
            ? ['managed-toolkit:' + session]
            : []),
          ...this.store.db
            .prepare(
              `SELECT id FROM toolkit_calls c WHERE attempt_id=? AND state IN ('delivered','dispatching','outcome_unknown') AND NOT ${resolvedToolkitCallSql('c')}`,
            )
            .all(attempt)
            .map((row) => 'toolkit-call:' + row.id),
        ];
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
    const routes = controllers(this);
    this.operatorRouter = new Router(
      operatorRoutes(routes),
      OPERATOR_NOT_FOUND,
      () => this.stopping,
    );
    this.bridgeRouter = new Router(bridgeRoutes(routes), BRIDGE_NOT_FOUND, () => this.stopping);
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
      await service.toolkitResources.recover();
      await service.station?.initialize();
      recoverToolkitCalls(service.store, service.managed);
      await service.supervisor.recover();
      service.cancellations.recover();
      await service.external.recover();
      service.store.recoverWork();
      service.taskWork.recover();
      service.tasks.recover();
      service.workspaces.recover();
      service.coding.recover();
      service.children.recover();
      service.workerWorkspaces.recover();
      service.managed.recover();
      service.mcp?.recover();
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
      service.shareOperatorSocket();
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
  scheduleRevocationStop(receipt: SessionRevocation): void {
    const cleanup = this.stopRevoked(receipt).finally(() => this.revocationStops.delete(cleanup));
    this.revocationStops.add(cleanup);
  }
  private async stopRevoked(receipt: SessionRevocation): Promise<void> {
    const jobs: Promise<unknown>[] = receipt.attempt_ids.map(async (attempt) => {
      this.managed.abortCancelled(attempt);
      this.mcp?.abortAttempt(attempt);
      this.toolkit?.abortAttempt(attempt);
      await this.station?.abortAttempt(attempt);
    });
    for (const session of receipt.session_ids) {
      jobs.push(this.toolkitResources.stopSession(session));
      if (this.mcp) jobs.push(this.mcp.stopSession(session));
      if (this.toolkit) jobs.push(this.toolkit.stopSession(session));
      if (this.station) jobs.push(this.station.stopSession(session));
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
  /** The launcher profile's only widening: group traverse on state and rw on operator.sock.
   * The bridge socket, journal, keys and every file below state stay owner-only. */
  private shareOperatorSocket(): void {
    if (!this.operatorAccess) return;
    const { gid } = this.operatorAccess;
    chownSync(this.socket, process.getuid!(), gid);
    chmodSync(this.socket, 0o660);
    chownSync(this.stateDir, process.getuid!(), gid);
    chmodSync(this.stateDir, 0o710);
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
  private grantStore?: RunGrants;
  /** One "Approve for this run" grant store, shared by decisions and the station. */
  runGrants(): RunGrants {
    return (this.grantStore ??= new RunGrants(this.store));
  }
  private async handle(req: IncomingMessage, res: ServerResponse, bridge: boolean): Promise<void> {
    await (bridge ? this.bridgeRouter : this.operatorRouter).dispatch(req, res);
  }
  async close(): Promise<void> {
    if (this.stopping) {
      await this.closed;
      if (this.shutdownFailure) throw this.shutdownFailure;
      return;
    }
    this.stopping = true;
    this.toolkitResolutions.stop();
    clearInterval(this.authorityTimer);
    const errors: unknown[] = [];
    const attempt = async (cleanup: () => unknown) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => this.inbox.close());
    await attempt(() => this.recurring.close());
    await attempt(() => this.jobs.close());
    await attempt(() => this.taskDriver.close());
    this.taskVerification.station?.stop();
    await attempt(() => this.dispatcher.pause());
    await attempt(() => this.managed.pause());
    await attempt(() => this.children.pause());
    await attempt(() => this.a2aInbound?.close());
    await Promise.all([...this.revocationStops].map((stop) => attempt(() => stop)));
    await attempt(() => this.external.close());
    await attempt(() => this.localCoding.close());
    await attempt(() => this.coding.close());
    await attempt(() => this.mcp?.close());
    await attempt(() => this.toolkit?.close());
    await attempt(() => this.station?.close());
    await attempt(() => this.taskVerification.station?.drain());
    await attempt(() => this.toolkitResources.close());
    await attempt(() => this.toolkitResolutions.close());
    await attempt(() => this.children.close());
    await attempt(() => this.supervisor.close());
    await attempt(() => this.supervisor.operatorMcp?.close());
    await attempt(() => this.dispatcher.drain());
    await attempt(() => this.managed.close());
    await attempt(() =>
      Promise.all(
        [this.operator, this.bridgeServer].map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              if (!server.listening) {
                resolve();
                return;
              }
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      ),
    );
    await Promise.all([...this.handlers].map((handler) => attempt(() => handler)));
    await attempt(() => this.store.close());
    // A replacement must not mistake an empty resource map for proof that this
    // process stopped all of its workers. OS death releases a retained lock.
    if (!errors.length) await attempt(() => this.release());
    if (errors.length)
      this.shutdownFailure = new AggregateError(
        errors,
        'Service shutdown could not confirm all resources and final states; state ownership retained until process exit',
      );
    this.resolveClosed();
    if (this.shutdownFailure) throw this.shutdownFailure;
  }
}
