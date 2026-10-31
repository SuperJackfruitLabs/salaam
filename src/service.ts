import { WebSearch, loadWebSearchConfig } from './web-search.js';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { loadPersona } from './persona.js';
import {
  mkdirSync,
  chmodSync,
  chownSync,
  existsSync,
  unlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { providerRoute } from './provider-config.js';
import { TaskContext } from './task-context.js';
import { ContextAdmission } from './context-admission.js';
import { ProjectInstructions, userInstructionsPath } from './project-instructions.js';
import { SLASH_COMMANDS } from './tui-commands.js';
import { TaskWork } from './task-work.js';
import { TaskBudget } from './task-budget.js';
import { AgentPodWorkDecisions } from './agentpod-work-decisions.js';
import { RunGrants } from './run-grants.js';
import { TaskCritic } from './task-critic.js';
import { AgentPodWork } from './agentpod-work.js';
import { agentpodWorkAdmission } from './agentpod-work-protocol.js';
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
import { AgentPodAuthority, readAgentPodPins } from './agentpod-authority.js';
import { ToolkitResources } from './toolkit-resources.js';
import { OperatorMcp } from './operator-mcp.js';
import { cancelToolkitCalls, recoverToolkitCalls } from './toolkit-calls.js';
import { ToolkitOwners } from './toolkit-owners.js';
import { ToolkitResolutions, resolvedToolkitCallSql } from './toolkit-resolutions.js';
import { A2ABackend, ExternalBackends } from './a2a-backend.js';
import { VERSION } from './config.js';
import { TurnCancellations } from './turn-cancellations.js';
import { McpAdmission } from './mcp-admission.js';
import { McpWork } from './mcp-work.js';
import { ToolkitWork, type ToolkitWorkConfig } from './toolkit-work.js';
import { permissionPolicy, configurePermissions } from './autonomy.js';
import { expandPrompt, storeImages, type PromptImage } from './mentions.js';
import { ApprovalRules } from './approval-rules.js';
import { chooseLocalSandbox, type SandboxLevel, resolveReadPaths } from './command-sandbox.js';
import { LocalCoding, type LocalSandbox } from './local-coding.js';
import { localDiff } from './local-diff.js';
import { reviewUndo, applyUndo, reconcileUndo } from './local-undo.js';
import { forkPiSession } from './pi-sessions.js';
import { TurnCheckpoints, type RewindMode } from './turn-rewind.js';
import { StationWork } from './station-work.js';
import { readToolkitConfig } from './toolkit-config.js';
import { probeToolsUser, serviceToolIdentity, type ToolIdentity } from './tool-identity.js';

export interface ServiceOptions extends Omit<SupervisorOptions, 'stateDir' | 'bridgeSocket'> {
  /** The user-level AGENTS.md for interactive sessions; null turns it off. Default:
   * /salaam/AGENTS.md or ~/.config/salaam/AGENTS.md. */
  userInstructions?: string | null;
  hostManifestDigest?: string;
  /** Receipt fields for the launcher profile; reported only by a manifest-served host. */
  hostReceipt?: Record<string, unknown>;
  /** Launcher profile: one group may traverse state and use the operator socket. */
  operatorAccess?: { group: string; gid: number };
  agentpodConfig?: string;
  /** Operator-declared MCP file (never a workspace path); absent means none declared. */
  operatorMcpConfig?: string;
  /** Item 9: the host's pinned persona file and the digest host plan reviewed. */
  personaConfig?: { config: string; digest: string };
  /** Environment that ${VAR} references resolve from; defaults to process.env. */
  operatorMcpEnvironment?: NodeJS.ProcessEnv;
  managedMcp?: { config: string; profile_digest: string };
  /** Internal trusted host seam; never accepted from ACP or a worker. */
  managedToolkit?: ToolkitWorkConfig;
  managedToolkitConfig?: { config: string; configuration_digest: string };
  /** Explicit acceptance opt-in; not advertised by default host manifests. */
  agentpodWorkProgression?: boolean;
  stationConfig?: { config: string; configuration_digest: string };
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
  /** Unprivileged OS user for agent-initiated local commands and edits (Linux, sudo -n -u). */
  toolsUser?: string;
  /** Item 10: the sandbox level for agent-initiated local commands (default workspace-write).
   * full-access is unsandboxed and must be chosen explicitly. */
  localSandbox?: SandboxLevel;
  /** Host config `unsandboxed_commands: "allow"`: run local commands unsandboxed on a host with no
   * usable sandbox. Absent, they are refused (operator ruling 2026-10-30, option A). */
  unsandboxedCommands?: 'allow';
  /** Read-only paths outside the workspace local commands may read (resolved, `toolchain` expanded). */
  localSandboxReadPaths?: string[];
  /** Web search config file: optional providers (searxng, brave, tavily, exa) and their key
   * references. Keyless official APIs answer without one (operator ruling 2026-10-31). */
  webSearchConfig?: string;
  /** The user's approval rules file (default ~/.config/salaam/permissions.json). */
  permissionsFile?: string;
  /** Host config `command_network: "broker"`: sandboxed local commands reach the network only
   * through this stk local-commands socket (operator rulings 2026-10-30). */
  commandNetwork?: { socket: string };
  /** Phase 2b: may an interactive session choose full access? Default true for local desk use;
   * a host started from a manifest passes its reviewed `full_access_sessions` setting. */
  allowFullAccessSessions?: boolean;
  /** Whether an interactive session may choose YOLO (no sandbox, no approvals). Desk default allows
   * it; a host started from a manifest passes its reviewed `yolo_sessions` setting. */
  allowYoloSessions?: boolean;
  /** Internal test seam: argv prefix replacing `sudo -n -u <toolsUser> --`. */
  toolsLauncher?: string[];
  codingSocket?: string;
  codingBackend?: ExecutionBackend;
  expectedExecution?: { profile_digest: string; engine_id: string };
}
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
  private readonly hostManifestDigest: string | null;
  private readonly hostReceipt: Record<string, unknown> | null;
  private readonly operatorAccess: { group: string; gid: number } | null;
  private readonly agentpodWorkProgression: boolean;
  /** Phase 2b: whether interactive sessions here may choose full access (no OS sandbox). */
  private readonly allowFullAccessSessions: boolean;
  private readonly allowYoloSessions: boolean;
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
        this.supervisor.localCoding = this.localCoding;
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
          this.taskVerification.installStation(this.station);
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
  private runGrants(): RunGrants {
    return (this.grantStore ??= new RunGrants(this.store));
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
      if (!bridge && req.method === 'POST' && req.url === '/managed-toolkit/v1/verify') {
        this.send(res, 200, await this.toolkitOwners.verify(req));
        return;
      }
      if (!bridge && req.method === 'POST' && req.url === '/managed-toolkit/v1/control') {
        this.send(res, 200, await this.toolkitOwners.control(req));
        return;
      }
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
          const attached = this.agentpod.authenticate(
            string(body.admission_id, 'admission_id', 128),
            string(body.token, 'token', 128),
          );
          this.send(res, 200, {
            ...attached,
            ...(this.agentpodWorkProgression &&
            this.agentpodWork &&
            attached.binding.run.source === 'superpipeline'
              ? { work_control: { version: 1, owner: 'superpipeline' } }
              : {}),
            ...(this.mcp ? { managed_mcp: this.mcp.status(attached.session_id).assignment } : {}),
          });
          return;
        }
        if (parts[2] === 'status') {
          this.send(res, 200, this.agentpod.inspect(body.binding));
          return;
        }
        if (parts[2] === 'work-capability') {
          if (Object.keys(body).length)
            throw new ServiceError('invalid_work_payload', 'Empty capability request required');
          this.send(res, 200, {
            version: 1,
            enabled: !!this.agentpodWork && this.agentpodWorkProgression,
          });
          return;
        }
        // Item 11b: restore a checkpoint's files, exactly as approved, for an ended run.
        if (parts[2] === 'work-restore') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict work is not enabled');
          if (
            Object.keys(body).sort().join(',') !==
            'approved_by,binding,checkpoint_id,request_id,restore_digest'
          )
            throw new ServiceError('invalid_work_payload', 'Closed restore request required');
          const restoreDigest = string(body.restore_digest, 'restore_digest', 64);
          if (!/^[a-f0-9]{64}$/.test(restoreDigest))
            throw new ServiceError('invalid_work_payload', 'A restore names its exact digest');
          this.send(
            res,
            200,
            await this.agentpodWork.restore(
              body.binding,
              string(body.request_id, 'request_id', 128),
              string(body.checkpoint_id, 'checkpoint_id', 128),
              restoreDigest,
              string(body.approved_by, 'approved_by', 128),
            ),
          );
          return;
        }
        // Item 11: read-only checkpoints of the bound run and one checkpoint's diff.
        if (parts[2] === 'work-checkpoints' || parts[2] === 'work-checkpoint-diff') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict work is not enabled');
          const keys = parts[2] === 'work-checkpoints' ? 'binding' : 'binding,checkpoint_id';
          if (Object.keys(body).sort().join(',') !== keys)
            throw new ServiceError('invalid_work_payload', 'Closed checkpoint request required');
          this.send(
            res,
            200,
            parts[2] === 'work-checkpoints'
              ? this.agentpodWork.checkpoints(body.binding)
              : await this.agentpodWork.checkpointDiff(
                  body.binding,
                  string(body.checkpoint_id, 'checkpoint_id', 128),
                ),
          );
          return;
        }
        if (parts[2] === 'work-status' || parts[2] === 'work-progress') {
          if (!this.agentpodWork || !this.agentpodWorkProgression)
            throw new ServiceError('work_disabled', 'Strict progression is not enabled');
          if (parts[2] === 'work-status') {
            if (Object.keys(body).join(',') !== 'binding')
              throw new ServiceError('invalid_work_payload', 'Closed status request required');
            this.send(res, 200, await this.agentpodWork.status(body.binding, this.taskDriver));
          } else {
            if (
              Object.keys(body).sort().join(',') !==
                'binding,compact,max_steps,request_id,work_request_id' ||
              body.compact !== false
            )
              throw new ServiceError(
                'invalid_work_payload',
                'Closed bounded progression request required',
              );
            this.send(
              res,
              200,
              this.agentpodWork.progress(
                body.binding,
                string(body.request_id, 'request_id', 128),
                string(body.work_request_id, 'work_request_id', 128),
                integer(body.max_steps, 'max_steps'),
                this.taskDriver,
              ),
            );
          }
          return;
        }
        if (parts[2] === 'work-abandon') {
          if (!this.agentpodWork || !this.agentpodWorkProgression)
            throw new ServiceError(
              'work_disabled',
              'Strict work historical success retirement is not enabled',
            );
          if (
            Object.keys(body).sort().join(',') !==
            'binding,producer_terminal_digest,request_id,work_request_id'
          )
            throw new ServiceError(
              'invalid_work_payload',
              'Closed explicit failure request required',
            );
          this.send(
            res,
            200,
            this.agentpodWork.abandon(
              body.binding,
              string(body.request_id, 'request_id', 128),
              string(body.work_request_id, 'work_request_id', 128),
              string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
            ),
          );
          return;
        }
        if (parts[2] === 'work-fail') {
          if (!this.agentpodWork || !this.agentpodWorkProgression)
            throw new ServiceError(
              'work_disabled',
              'Strict work failure retirement is not enabled',
            );
          if (
            Object.keys(body).sort().join(',') !==
            'binding,producer_terminal_digest,request_id,work_request_id'
          )
            throw new ServiceError(
              'invalid_work_payload',
              'Closed explicit failure request required',
            );
          this.send(
            res,
            200,
            this.agentpodWork.fail(
              body.binding,
              string(body.request_id, 'request_id', 128),
              string(body.work_request_id, 'work_request_id', 128),
              string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
              this.taskDriver,
            ),
          );
          return;
        }
        if (parts[2] === 'work-expire') {
          if (!this.agentpodWork || !this.agentpodWorkProgression)
            throw new ServiceError('work_disabled', 'Strict work expiry is not enabled');
          if (
            Object.keys(body).sort().join(',') !==
            'binding,decision_request_id,producer_terminal_digest,request_id,work_request_id'
          )
            throw new ServiceError(
              'invalid_work_payload',
              'Closed explicit expiry request required',
            );
          this.send(
            res,
            200,
            this.agentpodWork.expire(
              body.binding,
              string(body.request_id, 'request_id', 128),
              string(body.work_request_id, 'work_request_id', 128),
              string(body.decision_request_id, 'decision_request_id', 128),
              string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
              this.taskDriver,
            ),
          );
          return;
        }
        if (parts[2] === 'work-settle') {
          if (!this.agentpodWork || !this.agentpodWorkProgression)
            throw new ServiceError('work_disabled', 'Strict work settlement is not enabled');
          if (
            Object.keys(body).sort().join(',') !==
            'binding,producer_terminal_digest,request_id,work_request_id'
          )
            throw new ServiceError(
              'invalid_work_payload',
              'Closed explicit settlement request required',
            );
          this.send(
            res,
            200,
            this.agentpodWork.settle(
              body.binding,
              string(body.request_id, 'request_id', 128),
              string(body.work_request_id, 'work_request_id', 128),
              string(body.producer_terminal_digest, 'producer_terminal_digest', 64),
              this.taskDriver,
            ),
          );
          return;
        }
        if (parts[2] === 'work-trace') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict work is not enabled');
          if (
            Object.keys(body).sort().join(',') !== 'binding,schema_version,traceparent' ||
            body.schema_version !== 'salaam-work-trace/v1'
          )
            throw new ServiceError(
              'invalid_trace_context',
              'Closed versioned trace context required',
            );
          this.send(res, 200, this.agentpodWork.trace(body.binding, body.traceparent));
          return;
        }
        if (parts[2] === 'work-evidence-artifacts') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict work is not enabled');
          if (
            Object.keys(body).sort().join(',') !== 'artifact_ids,binding,schema_version' ||
            body.schema_version !== 'salaam-execution-artifacts/v1'
          )
            throw new ServiceError(
              'unsupported_evidence_version',
              'Closed versioned artifact selection required',
            );
          this.send(res, 200, this.agentpodWork.evidenceArtifacts(body.binding, body.artifact_ids));
          return;
        }
        if (parts[2] === 'work-evidence') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict work is not enabled');
          if (
            Object.keys(body).sort().join(',') !== 'binding,schema_version' ||
            body.schema_version !== 'salaam-execution-evidence/v1'
          )
            throw new ServiceError(
              'unsupported_evidence_version',
              'Explicit supported evidence version required',
            );
          this.send(res, 200, this.agentpodWork.evidence(body.binding));
          return;
        }
        if (parts[2] === 'work-completion') {
          if (!this.agentpodWork)
            throw new ServiceError(
              'verification_unavailable',
              'Reviewed protected station backend required',
            );
          if (Object.keys(body).join(',') !== 'binding')
            throw new ServiceError('invalid_work_payload', 'Closed completion request required');
          this.send(res, 200, await this.agentpodWork.completion(body.binding));
          return;
        }
        if (parts[2] === 'work-read') {
          if (!this.agentpodWork)
            throw new ServiceError('work_disabled', 'Strict progression is not enabled');
          if (Object.keys(body).sort().join(',') !== 'answer,binding')
            throw new ServiceError('invalid_board_read', 'Closed board read answer required');
          this.send(res, 200, this.agentpodWork.answerBoardRead(body.binding, body.answer));
          return;
        }
        if (parts[2] === 'work-decisions' || parts[2] === 'work-decision') {
          if (!this.agentpodWork)
            throw new ServiceError(
              'verification_unavailable',
              'Reviewed protected station backend required',
            );
          const answering = parts[2] === 'work-decision';
          if (Object.keys(body).sort().join(',') !== (answering ? 'answer,binding' : 'binding'))
            throw new ServiceError('invalid_work_decision', 'Closed decision payload required');
          const decisions = new AgentPodWorkDecisions(
            this.agentpodWork,
            this.managed,
            this.runGrants(),
          );
          this.send(
            res,
            200,
            answering ? decisions.answer(body.binding, body.answer) : decisions.list(body.binding),
          );
          return;
        }
        if (parts[2] === 'work-admit') {
          // This is the private owner socket, never the worker bridge. The native
          // node authenticates its Hub reservation; board/card/stage are that
          // trusted producer's assertion. Runtime pins and byte digests are local.
          if (!this.agentpodWork)
            throw new ServiceError(
              'verification_unavailable',
              'Reviewed protected station work backend required',
            );
          if (Object.keys(body).sort().join(',') !== 'admission,input,plan')
            throw new ServiceError('invalid_work_payload', 'Closed work payload required');
          const admission = agentpodWorkAdmission(body.admission),
            input = object(body.input);
          if (
            Object.keys(input).sort().join(',') !== 'incoming_handoff,instructions,references' ||
            typeof input.instructions !== 'string' ||
            input.instructions.length < 1 ||
            input.instructions.length > 65536 ||
            !Array.isArray(input.references) ||
            input.references.length > 64 ||
            input.references.some(
              (v) => typeof v !== 'string' || v.length < 1 || v.length > 4096,
            ) ||
            (input.incoming_handoff !== null &&
              (typeof input.incoming_handoff !== 'string' || input.incoming_handoff.length > 65536))
          )
            throw new ServiceError('invalid_work_payload', 'Closed work input required');
          if (canonical(this.taskWork.parse(body.plan)) !== canonical(body.plan))
            throw new ServiceError(
              'invalid_work_payload',
              'Fully expanded canonical task plan required',
            );
          const owner = this.agentpod.inspect(admission.binding);
          this.send(
            res,
            200,
            this.agentpodWork.admit(
              owner.session_id,
              admission,
              {
                board_id: admission.work.board_id,
                card_id: admission.work.card_id,
                stage_key: admission.work.stage_key,
              },
              input,
              body.plan,
            ),
          );
          return;
        }
        if (parts[2] === 'mcp-assign') {
          if (!this.mcp)
            throw new ServiceError('mcp_disabled', 'No reviewed managed MCP host profile', 403);
          const current = this.agentpod.inspect(body.binding);
          const old = this.mcp.status(current.session_id).assignment;
          const assigned = this.mcp.assign(current.session_id, body.assignment);
          if (old && old.assignment_digest !== assigned.assignment_digest) {
            this.supervisor.failControl(
              current.session_id,
              new Error('MCP assignment changed; restart required'),
            );
            await Promise.all([
              this.supervisor.stopSession(current.session_id),
              this.mcp.stopSession(current.session_id),
            ]);
          }
          this.send(res, 200, await this.mcp.ready(current.session_id));
          return;
        }
        const request = string(body.request_id, 'request_id', 128);
        if (parts[2] === 'admit') {
          this.send(
            res,
            200,
            this.agentpod.admit(
              body.binding,
              request,
              body.continue_from === undefined
                ? undefined
                : string(body.continue_from, 'continue_from', 128),
              body.approval_rules,
            ),
          );
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
              body.approval_rules,
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
          this.send(res, 200, current ? await this.taskDriver.viewAsync(current.id) : null);
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
          this.send(res, 200, await this.taskDriver.viewAsync(taskId));
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
            this.send(res, 201, await this.taskDriver.viewAsync(task.id));
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
              await this.taskVerification.finishAsync(
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
              result = await this.taskDriver.viewAsync(taskId);
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
              result = await this.taskDriver.viewAsync(taskId);
            } else {
              await this.taskDriver.cancel(taskId, request, expected, controller);
              result = await this.taskDriver.viewAsync(taskId);
            }
            this.send(res, 200, result);
            return;
          }
          if (taskId && parts.length === 4 && parts[3] === 'revise') {
            this.send(
              res,
              200,
              (this.taskWork.revise(taskId, request, expected, body.plan, controller),
              await this.taskDriver.viewAsync(taskId)),
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
                await this.taskDriver.viewAsync(taskId)),
              );
              return;
            }
          }
        }
      }
      if (url.pathname === '/v1/command-inventory' && req.method === 'GET') {
        this.send(res, 200, {
          version: 1,
          surface: 'salaam-tui',
          commands: SLASH_COMMANDS,
          automatic_discovery: false,
        });
        return;
      }
      if (url.pathname === '/v1/health' && req.method === 'GET') {
        const sessions = this.store.sessions().map((x) => this.supervisor.inspect(x.id));
        this.send(res, 200, {
          pid: process.pid,
          host_manifest_digest: this.hostManifestDigest,
          host_supervisor_connected: this.hostManifestDigest ? process.connected === true : null,
          host_receipt: this.hostReceipt,
          runtime_node: realpathSync(process.execPath),
          service_version: VERSION,
          context_admission: { version: 1, automatic_discovery: false, child_inheritance: false },
          agentpod_config: this.agentpod?.configPath ?? null,
          agentpod_pins_digest: this.agentpod ? digest(this.agentpod.pins) : null,
          persona: this.supervisor.persona
            ? { digest: this.supervisor.persona.digest, text: this.supervisor.persona.text }
            : null,
          operator_mcp: this.operatorMcpPath
            ? {
                config: this.operatorMcpPath,
                digest: this.supervisor.operatorMcp!.digest,
                servers: this.supervisor.operatorMcp!.provenance(),
              }
            : null,
          managed_mcp: this.mcp
            ? { profile_digest: this.mcp.options.admission.profileDigest }
            : null,
          managed_toolkit: this.toolkit
            ? { configuration_digest: this.toolkit.configurationDigest }
            : null,
          strict_work: this.agentpodWorkProgression && this.agentpodWork ? { version: 1 } : null,
          station_execution: this.station
            ? { configuration_digest: this.station.configurationDigest }
            : null,
          service: 'healthy',
          tool_execution: {
            mode: this.toolIdentity.mode,
            user: this.toolIdentity.user,
            uid: this.toolIdentity.uid,
            warning: this.toolIdentity.warning,
          },
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
          local_workspace: {
            inspection: true,
            session_routes: true,
            coding: true,
            reasoning: true,
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
          last_activity_at: new Date(this.store.lastActivityAny()).toISOString(),
          sessions: sessions.map((x) => ({
            id: x.id,
            state: x.state,
            last_activity_at: iso(this.store.lastActivity(x.id)),
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
        if (
          body.local_coding !== undefined &&
          (typeof body.local_coding !== 'boolean' || !body.local_workspace)
        )
          throw new ServiceError('invalid_field', 'local_coding requires a local workspace');
        if (body.local_workspace !== undefined && typeof body.local_workspace !== 'boolean')
          throw new ServiceError('invalid_field', 'local_workspace must be a boolean', 400);
        if (body.local_workspace && body.coding)
          throw new ServiceError(
            'invalid_field',
            'Choose local inspection or an owned coding workspace',
            400,
          );
        if (body.route !== undefined && !body.local_workspace)
          throw new ServiceError(
            'invalid_field',
            'Session route selection requires a local workspace',
            400,
          );
        const selected =
          body.route === undefined
            ? this.supervisor.route
            : (() => {
                const input = object(body.route);
                return providerRoute(
                  string(input.provider, 'provider'),
                  input.model === undefined ? undefined : string(input.model, 'model'),
                  input.max_tokens === undefined
                    ? undefined
                    : integer(input.max_tokens, 'max_tokens'),
                  undefined,
                  undefined,
                  input.reasoning as import('./provider-config.js').ReasoningLevel | undefined,
                );
              })();
        if (body.local_workspace) {
          const saved = this.store.cachedRequest<import('./protocol.js').Session>(
            'local-operator',
            string(body.request_id, 'request_id', 128),
            {
              kind: 'create',
              cwd,
              local: {
                workspace: true,
                route: selected,
                ...(body.local_coding ? { coding: true } : {}),
              },
            },
          );
          if (saved) {
            this.send(res, 201, saved);
            return;
          }
          if (this.mcp || this.toolkit || this.station)
            throw new ServiceError(
              'admission_required',
              'Local inspection cannot be combined with managed host capabilities',
            );
        }
        const preparedLocal = body.local_workspace
          ? await this.supervisor.prepareProviderRoute(selected).catch(() => {
              throw new ServiceError(
                'provider_auth_required',
                `Provider authentication or routing configuration is unavailable. Configure ${selected.provider} with sal auth login ${selected.provider} or sal auth set ${selected.provider}, then retry.`,
                400,
              );
            })
          : undefined;
        if (
          preparedLocal?.output_cap === false &&
          body.route !== undefined &&
          object(body.route).max_tokens !== undefined
        )
          throw new ServiceError(
            'provider_output_cap_unavailable',
            'This authentication route cannot enforce an output token cap; omit max_tokens for an interactive session.',
            400,
          );
        const local = body.local_workspace
          ? {
              workspace: true as const,
              coding: body.local_coding === true,
              requestedRoute: selected,
              route: preparedLocal!.route,
              outputCap: preparedLocal!.output_cap,
            }
          : undefined;
        const session = this.store.create(
          cwd,
          string(body.request_id, 'request_id', 128),
          body.coding === true,
          local,
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
        // Desk-session approval rules (phase 2a): list, add (from a reviewed operation or written out),
        // and remove. Adding or removing needs the session's control lease, like the permission policy.
        if (parts[3] === 'approval-rules' && (parts.length === 4 || parts.length === 6)) {
          const rules = this.localCoding.rules!;
          if (parts.length === 4 && req.method === 'GET') {
            this.send(res, 200, {
              applies: rules.applies(id),
              rules: rules.list(id),
              problems: rules.problems(id),
            });
            return;
          }
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          if (parts.length === 4 && req.method === 'POST') {
            const scope = string(body.scope, 'scope');
            if (scope !== 'session' && scope !== 'repo')
              throw new ServiceError('invalid_field', 'A rule scope is session or repo', 400);
            const request = string(body.request_id, 'request_id', 128);
            this.send(
              res,
              200,
              body.operation_id !== undefined
                ? rules.addFromOperation(
                    id,
                    string(body.operation_id, 'operation_id', 128),
                    scope,
                    request,
                  )
                : rules.add(id, scope, body.rule, request),
            );
            return;
          }
          if (parts.length === 6 && parts[5] === 'remove' && req.method === 'POST') {
            rules.remove(id, string(parts[4], 'rule', 128));
            this.send(res, 200, { removed: parts[4] });
            return;
          }
        }
        if (parts.length === 4 && parts[3] === 'permissions') {
          if (req.method === 'GET') {
            this.send(res, 200, {
              policy: permissionPolicy(this.store, id),
              configurable: this.store.localWorkspace(id),
              coding: this.store.localCoding(id),
              // Desk coding sessions: approval rules and auto mode can approve commands (Phase 2a/2b).
              command_auto_approval: this.store.localCoding(id),
              full_access_allowed: this.allowFullAccessSessions,
              yolo_allowed: this.allowYoloSessions && !!this.localCoding.rules?.applies(id),
              ...(this.store.localCoding(id)
                ? { command_sandbox: this.localCoding.commandSandbox(id) }
                : {}),
            });
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            this.send(
              res,
              200,
              configurePermissions(
                this.store,
                id,
                string(body.request_id, 'request_id', 128),
                integer(body.expected_revision, 'expected_revision'),
                body.policy,
                {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                },
                {
                  allowFullAccess: this.allowFullAccessSessions,
                  allowYolo: this.allowYoloSessions,
                  deskSession: !!this.localCoding.rules?.applies(id),
                },
              ),
            );
            return;
          }
        }
        if (parts[3] === 'local-tasks' && this.localCoding) {
          if (!this.supervisor.isInteractiveCoding(id))
            throw new ServiceError(
              'background_denied',
              'Background commands are not admitted',
              403,
            );
          if (parts.length === 4 && req.method === 'GET') {
            this.send(res, 200, { tasks: this.localCoding.tasks(id) });
            return;
          }
          if (parts.length === 5 && req.method === 'GET') {
            this.send(res, 200, this.localCoding.taskOutput(id, parts[4]!));
            return;
          }
          if (parts.length === 6 && parts[5] === 'stop' && req.method === 'POST') {
            this.send(res, 200, this.localCoding.stopTask(id, parts[4]!));
            return;
          }
        }
        if (parts.length === 4 && parts[3] === 'local-diff' && req.method === 'GET') {
          if (!this.store.localWorkspace(id))
            throw new ServiceError('local_denied', 'Local workspace required');
          this.send(res, 200, { text: await localDiff(this.store.session(id).cwd) });
          return;
        }
        if (parts.length === 4 && parts[3] === 'steer' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.send(
            res,
            200,
            await this.supervisor.steer(
              id,
              string(body.request_id, 'request_id', 128),
              string(body.text, 'text', 65536),
              {
                client_id: string(body.client_id, 'client_id', 128),
                token: string(body.token, 'token', 128),
              },
            ),
          );
          return;
        }
        if (parts.length === 4 && parts[3] === 'undo-reconcile' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.send(
            res,
            200,
            reconcileUndo(
              this.store,
              id,
              {
                client_id: string(body.client_id, 'client_id', 128),
                token: string(body.token, 'token', 128),
              },
              () => this.supervisor.assertIdle(id),
            ),
          );
          return;
        }
        if (parts.length === 4 && parts[3] === 'undo') {
          if (req.method === 'GET') {
            this.send(res, 200, reviewUndo(this.store, id));
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            this.send(
              res,
              200,
              applyUndo(
                this.store,
                id,
                string(body.request_id, 'request_id', 128),
                string(body.review_digest, 'review_digest', 128),
                {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                },
                () => {
                  this.supervisor.assertIdle(id);
                  if (
                    this.store.db
                      .prepare(
                        "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
                      )
                      .get(id)
                  )
                    throw new ServiceError('session_busy', 'Wait for queued work before undo');
                },
                this.toolIdentity,
              ),
            );
            return;
          }
        }
        if (
          (parts.length === 4 || parts.length === 5) &&
          (parts[3] === 'checkpoints' || parts[3] === 'rewind' || parts[3] === 'review')
        ) {
          const checkpoints = this.tasks.checkpoints!;
          const controller = (body: Record<string, unknown>) => ({
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          const idle = () => {
            this.supervisor.assertIdle(id);
            if (
              this.store.db
                .prepare(
                  "SELECT 1 FROM attempts WHERE session_id=? AND state IN ('accepted','dispatching','running')",
                )
                .get(id)
            )
              throw new ServiceError('session_busy', 'Wait for the current turn to finish');
          };
          if (parts[3] === 'checkpoints' && parts.length === 4 && req.method === 'GET') {
            this.send(res, 200, { checkpoints: checkpoints.list(id) });
            return;
          }
          if (parts[3] === 'rewind' && parts.length === 4 && req.method === 'GET') {
            this.send(
              res,
              200,
              checkpoints.reviewRewind(
                id,
                string(url.searchParams.get('attempt'), 'attempt', 128),
                string(url.searchParams.get('mode'), 'mode', 16) as RewindMode,
              ),
            );
            return;
          }
          if (parts[3] === 'rewind' && parts.length === 4 && req.method === 'POST') {
            if (this.agentpod)
              throw new ServiceError(
                'admission_required',
                'Managed station sessions cannot rewind',
              );
            const body = object(await readJson(req));
            const request = string(body.request_id, 'request_id', 128);
            this.send(
              res,
              200,
              checkpoints.rewind(
                id,
                request,
                string(body.attempt_id, 'attempt_id', 128),
                string(body.mode, 'mode', 16) as RewindMode,
                string(body.review_digest, 'review_digest', 128),
                controller(body),
                idle,
                (leaf, summary) =>
                  this.store.forkLocal(
                    id,
                    request + ':fork',
                    this.store.session(id).revision,
                    controller(body),
                    (source, target) => {
                      const dir = join(this.stateDir, 'workers', target, 'sessions');
                      mkdirSync(dir, { recursive: true, mode: 0o700 });
                      return forkPiSession(source.pi_session_file!, source.cwd, dir, target, {
                        leaf,
                        summary,
                      });
                    },
                    { leaf },
                  ),
              ),
            );
            return;
          }
          if (parts[3] === 'review' && parts.length === 4 && req.method === 'GET') {
            this.send(res, 200, { review: checkpoints.review(id) });
            return;
          }
          if (parts[3] === 'review' && parts[4] === 'hunks' && req.method === 'GET') {
            const q = (name: string) => string(url.searchParams.get(name), name, 1024);
            this.send(res, 200, {
              hunks: checkpoints.hunks(id, q('path'), q('base'), q('current')),
            });
            return;
          }
          if (parts[3] === 'review' && parts.length === 4 && req.method === 'POST') {
            const body = object(await readJson(req));
            const hunk =
              body.hunk === undefined
                ? undefined
                : {
                    text: string(object(body.hunk).text, 'hunk.text', 256 * 1024),
                    patch: string(object(body.hunk).patch, 'hunk.patch', 256 * 1024),
                  };
            this.send(res, 200, {
              review: checkpoints.act(
                id,
                {
                  action: string(body.action, 'action', 16) as 'accept' | 'revert',
                  path: string(body.path, 'path', 1024),
                  ...(hunk ? { hunk } : {}),
                  base: string(body.base, 'base', 128),
                  current: string(body.current, 'current', 128),
                },
                controller(body),
                idle,
              ),
            });
            return;
          }
        }
        if (parts.length === 4 && parts[3] === 'fork' && req.method === 'POST') {
          if (this.agentpod)
            throw new ServiceError(
              'admission_required',
              'Managed station sessions cannot be forked locally',
            );
          const body = object(await readJson(req));
          const session = this.store.forkLocal(
            id,
            string(body.request_id, 'request_id', 128),
            integer(body.expected_revision, 'expected_revision'),
            {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            (source, target) => {
              this.supervisor.assertIdle(id);
              const dir = join(this.stateDir, 'workers', target, 'sessions');
              mkdirSync(dir, { recursive: true, mode: 0o700 });
              return forkPiSession(source.pi_session_file!, source.cwd, dir, target);
            },
          );
          this.send(res, 201, session);
          return;
        }
        if (parts.length === 4 && parts[3] === 'name') {
          if (req.method === 'GET') {
            this.send(res, 200, { name: this.store.sessionName(id) ?? null });
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            this.send(
              res,
              200,
              this.store.nameSession(
                id,
                string(body.request_id, 'request_id', 128),
                string(body.name, 'name', 120),
                {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                },
              ),
            );
            return;
          }
        }
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
              this.mcp?.cancelInTransaction(attempt, 'session-revocation');
              this.station?.cancelInTransaction(attempt);
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
        if (parts[3] === 'context') {
          const contexts = this.tasks.admitted!;
          if (parts.length === 4 && req.method === 'GET') {
            this.send(res, 200, contexts.inspect(id));
            return;
          }
          if (req.method === 'POST' && (parts[4] === 'plan' || parts[4] === 'admit')) {
            const body = object(await readJson(req));
            const authorize = () => {
              this.store.authorizeControl(id, {
                client_id: string(body.client_id, 'client_id', 128),
                token: string(body.token, 'token', 128),
              });
              this.supervisor.assertIdle(id);
            };
            if (parts[4] === 'plan') {
              authorize();
              this.send(res, 200, contexts.plan(id, body.selection));
            } else {
              this.send(
                res,
                200,
                contexts.admit(
                  id,
                  string(body.request_id, 'request_id', 128),
                  integer(body.expected_revision, 'expected_revision'),
                  string(body.digest, 'digest', 128),
                  body.selection,
                  authorize,
                ),
              );
            }
            return;
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
      if (parts[0] === 'v1' && parts[1] === 'toolkit' && parts[2] === 'calls' && parts[3]) {
        const id = parts[3];
        if (parts.length === 4 && req.method === 'GET') {
          this.send(res, 200, this.toolkitResolutions.inspect(id));
          return;
        }
        if (parts.length === 5 && parts[4] === 'resolution' && req.method === 'POST') {
          const body = object(await readJson(req)),
            outcome = string(body.outcome, 'outcome');
          if (outcome !== 'succeeded' && outcome !== 'failed_definite')
            throw new ServiceError('invalid_field', 'Invalid resolution outcome', 400);
          this.send(
            res,
            200,
            await this.toolkitResolutions.resolveRead(
              id,
              string(body.request_id, 'request_id', 128),
              integer(body.expected_revision, 'expected_revision'),
              string(body.context_digest, 'context_digest', 128),
              outcome,
              string(body.evidence, 'evidence', 4096),
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
            await (
              this.toolkitResolutions.owns(id)
                ? this.toolkitResolutions.resolveOperation.bind(this.toolkitResolutions)
                : this.managed.resolve.bind(this.managed)
            )(
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
        parts[1] === 'station' &&
        parts[2] === 'calls' &&
        parts[3] &&
        parts.length === 4 &&
        req.method === 'GET'
      ) {
        if (!this.station)
          throw new ServiceError('station_disabled', 'Station execution is unavailable');
        this.send(res, 200, this.station.view(parts[3]));
        return;
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
              ? await this.taskDriver.viewAsync(this.taskWork.forSession(id)!.id)
              : null,
          });
          return;
        }
        if (parts[3] === 'tool-metadata' && req.method === 'GET') {
          this.send(
            res,
            200,
            this.store.toolMetadata(id, string(url.searchParams.get('call_id'), 'call_id', 512)),
          );
          return;
        }
        if (parts[3] === 'cancellations') {
          if (req.method === 'GET') {
            const request = url.searchParams.get('request_id');
            this.send(
              res,
              200,
              request
                ? this.cancellations.get(id, string(request, 'request_id', 128))
                : this.cancellations.list(id),
            );
            return;
          }
          if (req.method === 'POST') {
            const body = object(await readJson(req));
            this.send(
              res,
              202,
              this.cancellations.begin(
                id,
                string(body.request_id, 'request_id', 128),
                body.target_request_id == null
                  ? null
                  : string(body.target_request_id, 'target_request_id', 128),
                {
                  client_id: string(body.client_id, 'client_id', 128),
                  token: string(body.token, 'token', 128),
                },
              ),
            );
            return;
          }
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
        if (parts[3] === 'route' && req.method === 'POST') {
          const body = object(await readJson(req));
          this.store.authorizeControl(id, {
            client_id: string(body.client_id, 'client_id', 128),
            token: string(body.token, 'token', 128),
          });
          if (!this.tasks.instructions!.applies(id))
            throw new ServiceError(
              'route_switch_unavailable',
              'Only interactive sessions can switch model mid-session',
              409,
            );
          this.supervisor.assertIdle(id);
          const input = object(body.route);
          const requested = providerRoute(
            string(input.provider, 'provider'),
            input.model === undefined ? undefined : string(input.model, 'model'),
            undefined,
            undefined,
            undefined,
            input.reasoning as import('./provider-config.js').ReasoningLevel | undefined,
          );
          const prepared = await this.supervisor.prepareProviderRoute(requested).catch(() => {
            throw new ServiceError(
              'provider_auth_required',
              `Configure ${requested.provider} with sal auth login ${requested.provider} or sal auth set ${requested.provider}, then retry.`,
              400,
            );
          });
          if (prepared.output_cap !== (this.store.localOutputCap(id) ?? true))
            throw new ServiceError(
              'provider_output_cap_changed',
              'That route enforces output caps differently; start a new session for it',
              409,
            );
          this.supervisor.assertIdle(id);
          this.store.switchRoute(id, prepared.route);
          await this.supervisor.stopSession(id);
          void this.supervisor.start(id).catch(() => {});
          this.send(res, 200, this.supervisor.inspect(id));
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
            canonical(session.provider_route) !== canonical(this.supervisor.routeFor(id))
          )
            throw new ServiceError(
              'provider_route_changed',
              'Restart the service with this session’s original provider route, or create a new session',
            );
          if (session.state !== 'ready' && session.state !== 'starting')
            void this.supervisor.start(id).catch(() => {});
          // Show the project instructions an interactive session will use before its first turn.
          try {
            this.tasks.instructions?.refresh(id);
          } catch {
            /* reported on the next turn */
          }
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
          const local = this.store.localCoding(id);
          let text = string(body.text, 'text', 256 * 1024);
          let images: PromptImage[] = [];
          // Desk prompts attach their @mentions (Phase 3b); board work never reads the tree here.
          if (local) {
            if (body.confirm_sensitive !== undefined && typeof body.confirm_sensitive !== 'boolean')
              throw new ServiceError('invalid_field', 'Invalid confirm_sensitive flag', 400);
            ({ text, images } = expandPrompt(
              this.store.session(id).cwd,
              text,
              body.confirm_sensitive === true,
            ));
          }
          const submission = this.store.accept(
            id,
            string(body.request_id, 'request_id', 128),
            integer(body.expected_revision, 'expected_revision'),
            text,
            {
              client_id: string(body.client_id, 'client_id', 128),
              token: string(body.token, 'token', 128),
            },
            body.continues_attempt_id === undefined
              ? null
              : string(body.continues_attempt_id, 'continues_attempt_id', 128),
          );
          // Same tick as the acceptance, so dispatch cannot claim the submission without them.
          storeImages(this.store.db, submission.id, images);
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

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
