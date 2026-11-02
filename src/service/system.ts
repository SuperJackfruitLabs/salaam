// The service's own routes: health, the command inventory, shutdown, and the worker bridge.
import { realpathSync } from 'node:fs';
import { SLASH_COMMANDS, VERSION, digest, object, readJson } from '../core/index.js';
import { EXECUTION_STATUS } from '../execution/index.js';
import type { A2AInbound } from '../a2a/index.js';
import type { AgentPodAuthority, AgentPodWork, StationWork } from '../agentpod/index.js';
import type { CodingWork, Workspaces } from '../coding/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { ToolIdentity } from '../local/index.js';
import type { McpWork } from '../mcp/index.js';
import type { Supervisor } from '../runtime/index.js';
import type { Store } from '../store/index.js';
import type { JobWork, OperatorInbox, RecurringWork } from '../tasks/index.js';
import type { ToolkitWork } from '../toolkit/index.js';
import type { ExternalWork } from '../workers/index.js';
import { send, type RouteContext } from './router.js';

export interface SystemService {
  readonly store: Store;
  readonly supervisor: Supervisor;
  readonly agentpod?: AgentPodAuthority;
  readonly agentpodWork?: AgentPodWork;
  readonly agentpodWorkProgression: boolean;
  readonly operatorMcpPath?: string;
  readonly mcp?: McpWork;
  readonly toolkit?: ToolkitWork;
  readonly station?: StationWork;
  readonly toolIdentity: ToolIdentity;
  readonly a2aInbound?: A2AInbound;
  readonly external: ExternalWork;
  readonly recurring: RecurringWork;
  readonly inbox: OperatorInbox;
  readonly jobs: JobWork;
  readonly coding: CodingWork;
  readonly managed: ManagedWork;
  readonly workspaces: Workspaces;
  readonly codingSocket: string | null;
  readonly hostManifestDigest: string | null;
  readonly hostReceipt: Record<string, unknown> | null;
  close(): Promise<void>;
}

type SessionView = ReturnType<Supervisor['inspect']>;

export class SystemController {
  constructor(private readonly s: SystemService) {}

  commandInventory({ res }: RouteContext): void {
    send(res, 200, {
      version: 1,
      surface: 'salaam-tui',
      commands: SLASH_COMMANDS,
      automatic_discovery: false,
    });
  }

  health({ res }: RouteContext): void {
    const sessions = this.s.store.sessions().map((x) => this.s.supervisor.inspect(x.id));
    send(res, 200, {
      ...this.host(),
      ...this.work(),
      ...this.execution(),
      sessions: this.sessions(sessions),
    });
  }

  shutdown({ res }: RouteContext): void {
    send(res, 200, { stopping: true });
    setImmediate(() => {
      void this.s.close().catch(() => {
        console.error('Salaam stopped with a persistence error');
        process.exitCode = 1;
      });
    });
  }

  /** A worker's call over the bridge socket, authenticated by its bearer token. */
  async bridge({ req, res, params }: RouteContext<'worker' | 'method'>): Promise<void> {
    const authorization = req.headers.authorization;
    const value = await this.s.supervisor.bridge(
      params.worker,
      params.method,
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined,
      object(await readJson(req)),
    );
    send(res, 200, value);
  }

  /** Health: the host, its pins and its configured capabilities. */
  private host() {
    const s = this.s;
    return {
      pid: process.pid,
      host_manifest_digest: s.hostManifestDigest,
      host_supervisor_connected: s.hostManifestDigest ? process.connected === true : null,
      host_receipt: s.hostReceipt,
      runtime_node: realpathSync(process.execPath),
      service_version: VERSION,
      context_admission: { version: 1, automatic_discovery: false, child_inheritance: false },
      agentpod_config: s.agentpod?.configPath ?? null,
      agentpod_pins_digest: s.agentpod ? digest(s.agentpod.pins) : null,
      persona: s.supervisor.persona
        ? { digest: s.supervisor.persona.digest, text: s.supervisor.persona.text }
        : null,
      operator_mcp: s.operatorMcpPath
        ? {
            config: s.operatorMcpPath,
            digest: s.supervisor.operatorMcp!.digest,
            servers: s.supervisor.operatorMcp!.provenance(),
          }
        : null,
      managed_mcp: s.mcp ? { profile_digest: s.mcp.options.admission.profileDigest } : null,
      managed_toolkit: s.toolkit ? { configuration_digest: s.toolkit.configurationDigest } : null,
      strict_work: s.agentpodWorkProgression && s.agentpodWork ? { version: 1 } : null,
      station_execution: s.station ? { configuration_digest: s.station.configurationDigest } : null,
      service: 'healthy',
      tool_execution: {
        mode: s.toolIdentity.mode,
        user: s.toolIdentity.user,
        uid: s.toolIdentity.uid,
        warning: s.toolIdentity.warning,
      },
      a2a: {
        inbound_enabled: !!s.a2aInbound,
        listener: s.a2aInbound?.server.address() ?? null,
        wire_version: '1.0',
        remote_execution: 'unobserved',
        inbound_authority: 'one-use-native-analysis-assignment',
      },
    };
  }

  /** Health: external workers, jobs and tasks. */
  private work() {
    const s = this.s;
    return {
      external_workers: {
        control: s.external.status(),
        runtimes: s.external.runtimes(),
        opaque_budget: 'explicit-invocations-only',
        unknown_model_usage: true,
        uncertain_stops: Number(
          s.store.db
            .prepare("SELECT count(*) AS n FROM external_runs WHERE stopped=0 AND state='unknown'")
            .get()!.n,
        ),
      },
      job_execution: {
        durable_jobs: true,
        one_shot_triggers: !!s.coding.executor,
        recurring_schedules: !!s.coding.executor,
        schedule_control_error: s.recurring.controlError,
        inbox_control_error: s.inbox.controlError,
        durable_operator_inbox: true,
        public_triggers: false,
        control_error: s.jobs.controlError,
      },
      task_execution: {
        durable_tasks: s.supervisor.providerCapabilities().durable_tasks,
        explicit_steps: true,
        automatic_progression: 'operator-bounded-opt-in',
        verified_completion: !!s.coding.executor,
        verification_supported: true,
        task_budgets: true,
        task_token_budgets: s.supervisor.providerCapabilities().output_token_cap,
        checkpoints: true,
        deterministic_compaction: 'operator-bounded-idle-only',
      },
    };
  }

  /** Health: the provider route and where commands run. */
  private execution() {
    const s = this.s;
    return {
      local_workspace: {
        inspection: true,
        session_routes: true,
        coding: true,
        reasoning: true,
      },
      provider_route: s.supervisor.route,
      provider_capabilities: s.supervisor.providerCapabilities(),
      effect_connector: s.managed.options.connector?.id ?? null,
      coding_root: s.workspaces.root ?? null,
      coding_socket: s.codingSocket,
      execution: s.workspaces.root
        ? {
            available: !!s.coding.executor,
            coding_tools: true,
            file_tools: true,
            commands: !!s.coding.executor,
            backend: s.coding.executor?.evidence ?? null,
          }
        : EXECUTION_STATUS,
      last_activity_at: new Date(s.store.lastActivityAny()).toISOString(),
    };
  }

  private sessions(sessions: SessionView[]) {
    return sessions.map((x) => ({
      id: x.id,
      state: x.state,
      last_activity_at: iso(this.s.store.lastActivity(x.id)),
      error: x.error,
      capabilities: x.capabilities,
      pending_approvals: this.s.store
        .approvals(x.id)
        .filter((approval) => approval.state === 'pending').length,
      unresolved_operations: this.s.store.hasUnknown(x.id),
    }));
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
