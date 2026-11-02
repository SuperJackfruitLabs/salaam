// How the supervisor launches a Pi worker: its private directory, the configuration the house
// extension reads, the pinned command line and environment, and what its readiness handshake
// must prove. runtime-launch.test.ts pins the launch byte for byte.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOUSE_EXTENSION,
  PI_CLI,
  POLICY_DIGEST,
  PI_VERSION,
  PROTOCOL_VERSION,
  VERSION,
  digest,
  textDigest,
  workerCapabilities,
  type CodingBinding,
  type McpServerProvenance,
  type ProviderRoute,
  type ReadinessFingerprint,
} from '../core/index.js';
import type { McpWorkerBinding } from '../mcp/index.js';
import type { ToolkitWorkerBinding } from '../toolkit/index.js';
import type { StationBinding } from './station.js';
import type { Persona } from './persona.js';

export interface Launch {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Owner-only permissions for the worker's private directories and files. */
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

/** Create the worker's private home: Pi's agent settings (automatic compaction off), its session
 * directory, and the MCP servers it was given (or none). */
export function prepareWorkerDir(
  stateDir: string,
  id: string,
  mcpServers: McpServerProvenance[] | undefined,
): { workerDir: string; sessionDir: string } {
  const workerDir = join(stateDir, 'workers', id);
  mkdirSync(join(workerDir, 'agent'), { recursive: true, mode: PRIVATE_DIR });
  writeFileSync(
    join(workerDir, 'agent', 'settings.json'),
    JSON.stringify({
      compaction: { enabled: false, keepRecentTokens: 512, reserveTokens: 8192 },
    }),
    { mode: PRIVATE_FILE },
  );
  const sessionDir = join(workerDir, 'sessions');
  mkdirSync(sessionDir, { recursive: true, mode: PRIVATE_DIR });
  const provenancePath = join(workerDir, 'mcp-servers.json');
  if (mcpServers)
    writeFileSync(provenancePath, JSON.stringify(mcpServers, null, 2), { mode: PRIVATE_FILE });
  else rmSync(provenancePath, { force: true });
  return { workerDir, sessionDir };
}

/** What the worker was granted, for its configuration and its handshake. */
export interface WorkerGrants {
  mcp?: McpWorkerBinding;
  operatorMcp?: McpServerProvenance[];
  mcpServers?: McpServerProvenance[];
  toolkit?: ToolkitWorkerBinding;
  station?: StationBinding;
}

export interface WorkerConfigInput {
  socket: string;
  token: string;
  session: string;
  epoch: number;
  bundle: string;
  frame: string;
  effects: boolean;
  child: boolean;
  worker_binding: unknown;
  route: ProviderRoute;
  coding: CodingBinding | undefined;
  local: boolean;
  localCoding: boolean;
  grants: WorkerGrants;
  persona: Persona | undefined;
}

/** The configuration the house extension reads from SALAAM_WORKER_CONFIG. Key order is part of
 * the launch: the string Pi receives is pinned. */
export function workerConfig(input: WorkerConfigInput) {
  const { grants } = input;
  return {
    socket: input.socket,
    token: input.token,
    session: input.session,
    epoch: input.epoch,
    bundle: input.bundle,
    policy: POLICY_DIGEST,
    frame: input.frame,
    effects: input.effects,
    child: input.child,
    worker_binding: input.worker_binding,
    route: input.route,
    coding: input.coding,
    local: input.local,
    localCoding: input.localCoding,
    ...(grants.mcp ? { mcp: grants.mcp } : {}),
    ...(grants.operatorMcp ? { operator_mcp: grants.operatorMcp } : {}),
    ...(grants.mcpServers ? { mcp_servers: grants.mcpServers } : {}),
    ...(grants.toolkit ? { toolkit: grants.toolkit } : {}),
    ...(grants.station ? { station: grants.station } : {}),
    ...(input.persona ? { persona: input.persona } : {}),
  };
}

export interface PiArgsInput {
  session: string;
  sessionDir: string;
  epoch: number;
  bootId: string;
  extension: string | undefined;
  tools: string[];
  route: ProviderRoute;
}

/** Pi's command line: RPC mode, no approval prompts, only the house extension and the session's
 * tools, nothing global (extensions, MCP, skills, templates, themes, context files). */
export function piArgs(input: PiArgsInput): string[] {
  return [
    PI_CLI,
    '--mode',
    'rpc',
    '--session-id',
    input.session,
    '--session-dir',
    input.sessionDir,
    '--name',
    `salaam/${input.session}/${input.epoch}/${input.bootId}`,
    '--no-approve',
    '--no-extensions',
    '--extension',
    input.extension ?? HOUSE_EXTENSION,
    '--no-mcp',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--no-builtin-tools',
    '--tools',
    input.tools.join(','),
    '--provider',
    input.route.provider,
    '--model',
    input.route.model,
  ];
}

/** Resume a recorded Pi transcript instead of starting a session by id. */
export function resumeArgs(args: string[], sessionFile: string): void {
  const index = args.indexOf('--session-id');
  args.splice(index, 2, '--session', sessionFile);
}

/** The worker's environment. It does not inherit provider credentials or global Pi resource
 * settings; a provider connection's own configuration comes last. */
export function workerEnv(
  workerDir: string,
  config: ReturnType<typeof workerConfig>,
  route: ProviderRoute,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: workerDir,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: join(workerDir, 'agent'),
    SALAAM_WORKER_CONFIG: JSON.stringify(config),
    ...(route.connection?.configuration ?? {}),
  };
}

export interface ManifestInput {
  session: string;
  epoch: number;
  bundle: string;
  frame: string;
  route: ProviderRoute;
  coding: CodingBinding | undefined;
  tools: string[];
  boundary: unknown;
  grants: WorkerGrants;
  persona: Persona | undefined;
}

/** Every field the worker's handshake must carry, with the value it must have. */
export function expectedManifest(input: ManifestInput): Record<string, unknown> {
  const { grants, coding, tools } = input;
  return {
    protocol_version: PROTOCOL_VERSION,
    bundle_digest: input.bundle,
    policy_digest: POLICY_DIGEST,
    session_id: input.session,
    pi_session_id: input.session,
    epoch: input.epoch,
    capabilities: workerCapabilities(coding, tools),
    tools,
    active_tools: tools,
    ...(coding ? { coding } : {}),
    provider: input.route.provider,
    route: input.route,
    context_digest: textDigest(input.frame),
    ...(input.boundary ? { worker_binding: input.boundary } : {}),
    ...(grants.mcp ? { mcp: grants.mcp } : {}),
    ...(grants.operatorMcp ? { operator_mcp: grants.operatorMcp } : {}),
    ...(grants.mcpServers
      ? { mcp_servers: grants.mcpServers, mcp_servers_digest: digest(grants.mcpServers) }
      : {}),
    ...(grants.toolkit ? { toolkit: grants.toolkit } : {}),
    ...(grants.station ? { station: grants.station } : {}),
    // Item 9: the worker proves it runs with the host's pinned persona.
    ...(input.persona ? { persona_digest: input.persona.digest } : {}),
  };
}

/** What a ready worker's fingerprint records about it. */
export function readinessRecord(input: {
  session: string;
  epoch: number;
  bundle: string;
  route: ProviderRoute;
  frame: string;
  contextAdmissionDigest: string | null;
}): Omit<ReadinessFingerprint, 'digest'> {
  return {
    session_id: input.session,
    worker_epoch: input.epoch,
    version: 1,
    harness: 'salaam',
    harness_version: VERSION,
    pi_version: PI_VERSION,
    bundle_digest: input.bundle,
    policy_digest: POLICY_DIGEST,
    provider: input.route.provider,
    model: input.route.model,
    context_digest: textDigest(input.frame),
    context_admission_digest: input.contextAdmissionDigest,
    verification: 'pinned-readiness-handshake',
  };
}
