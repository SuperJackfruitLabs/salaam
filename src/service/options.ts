// What a host passes when it opens the service.
import type { SandboxLevel } from '../local/index.js';
import type { SupervisorOptions } from '../runtime/index.js';
import type { EffectConnector } from '../execution/index.js';
import type { ExecutionBackend } from '../coding/index.js';
import type { ExternalBackend } from '../workers/index.js';
import type { ToolkitWorkConfig } from '../toolkit/index.js';

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
  /** Phase 4c: the optional small-model command reviewer (a JSON file); absent means off. */
  dangerClassifierConfig?: string;
  /** A host's reviewed pin: one option's name (sessions cannot switch or turn it off), or "off"
   * (the reviewer is forbidden). Absent: sessions choose from the config's options. */
  dangerClassifierPin?: string;
  /** The user's approval rules file (default ~/.config/salaam/permissions.json). */
  permissionsFile?: string;
  /** Your hooks file (Phase 4b); defaults to ~/.config/salaam/hooks.json or $SALAAM_HOOKS_FILE. */
  hooksFile?: string;
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
