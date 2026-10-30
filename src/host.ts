import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
  statSync,
  realpathSync,
  constants,
  fstatSync,
  lstatSync,
} from 'node:fs';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { ROOT, bundleDigest } from './config.js';
import { canonical, digest, object, string, ServiceError } from './protocol.js';
import { readAgentPodPins } from './agentpod-authority.js';
import { McpAdmission, readMcpProfile } from './mcp-admission.js';
import { bindProviderConfiguration } from './provider-model.js';
import { resolveProviderAuth } from './provider-auth.js';
import { providerRoute, type ProviderRoute } from './provider-config.js';
import { engineRequest } from './execution-boundary.js';
import { DockerCodingExecutor } from './coding-executor.js';
import { acquireStateLock } from './state-lock.js';
import { call } from './transport.js';
import { readStationConfig } from './station-config.js';
import { readToolkitConfig } from './toolkit-config.js';
import { OperatorMcp } from './operator-mcp.js';
import { chooseLocalSandbox, sandboxLabel, type SandboxKind } from './command-sandbox.js';
import { loadPersona } from './persona.js';
interface HostIdentity {
  node: string;
  node_version: string;
  repo: string;
  source_digest: string;
  build_digest: string;
  pi_bundle_digest: string;
  state: string;
  provider: ProviderRoute;
}
export interface CodingHostManifest extends HostIdentity {
  schema: 1;
  coding_root: string;
  coding_socket: string;
  profile_digest: string;
  engine_id: string;
}
interface AgentPodHostIdentity extends HostIdentity {
  mode: 'agentpod';
  agentpod_config: string;
  pins_digest: string;
  workspace: string;
  cli_digest: string;
  local_sandbox?: HostLocalSandbox;
}
export interface AgentPodHostManifest extends AgentPodHostIdentity {
  schema: 2;
}
export interface AgentPodMcpHostManifest extends AgentPodHostIdentity {
  schema: 3;
  managed_mcp: { config: string; profile_digest: string };
}
export interface AgentPodToolkitHostManifest extends AgentPodHostIdentity {
  schema: 4;
  managed_toolkit: { config: string; configuration_digest: string };
  managed_mcp?: AgentPodMcpHostManifest['managed_mcp'];
}
export interface AgentPodStationHostManifest extends AgentPodHostIdentity {
  schema: 5;
  station_execution: { config: string; configuration_digest: string };
  managed_toolkit?: AgentPodToolkitHostManifest['managed_toolkit'];
  managed_mcp?: AgentPodMcpHostManifest['managed_mcp'];
}
export interface AgentPodStrictWorkHostManifest extends Omit<
  AgentPodStationHostManifest,
  'schema'
> {
  schema: 6;
  strict_work: { version: 1 };
  /** Launcher profile: a root host whose operator socket one unprivileged group may use. */
  operator_access?: OperatorAccess;
  /** Operator-declared MCP servers (docs/mcp.md), pinned by declaration digest. */
  operator_mcp?: { config: string; digest: string };
  /** Item 9: the operator's persona file, pinned by content digest. */
  persona?: { config: string; digest: string };
  /** How long a strict approval offer stays answerable; the daemon default when absent. */
  approval_ttl_ms?: number;
}
/** Item 10: the command sandbox this host gives local commands, as reviewed at host plan. With no
 * usable sandbox the host refuses local commands (label "refused") unless the operator set
 * `unsandboxed_commands: "allow"`, which the manifest pins (operator ruling 2026-10-30, option A). */
export interface HostLocalSandbox {
  kind: SandboxKind;
  label: string;
  unsandboxed_commands?: 'allow';
}
export function hostLocalSandbox(
  platform: NodeJS.Platform = process.platform,
  find?: Parameters<typeof chooseLocalSandbox>[2],
  findSb?: Parameters<typeof chooseLocalSandbox>[3],
  allowUnsandboxed = false,
): HostLocalSandbox {
  const { kind } = chooseLocalSandbox('workspace-write', platform, find, findSb);
  return {
    kind,
    label: kind === 'none' && !allowUnsandboxed ? 'refused' : sandboxLabel(kind),
    ...(allowUnsandboxed ? { unsandboxed_commands: 'allow' as const } : {}),
  };
}
/** Whether the reviewed manifest lets local commands run unsandboxed on a host without a sandbox. */
export function hostAllowsUnsandboxed(m: HostManifest): boolean {
  return (
    (m as { local_sandbox?: HostLocalSandbox }).local_sandbox?.unsandboxed_commands === 'allow'
  );
}
export interface OperatorAccess {
  group: string;
  gid: number;
}
const groupName = /^[a-z_][a-z0-9_-]{0,31}$/;
/** Resolve a system group by name. The launcher profile never accepts a numeric id alone. */
export function resolveOperatorGroup(group: unknown): OperatorAccess {
  if (typeof group !== 'string' || !groupName.test(group))
    throw Error('operator_group must be a system group name');
  let line: string;
  try {
    line = execFileSync('/usr/bin/getent', ['group', group], { encoding: 'utf8' }).trim();
  } catch {
    throw Error('operator_group does not exist');
  }
  const [name, , id] = line.split(':');
  const gid = Number(id);
  if (name !== group || !Number.isInteger(gid) || gid <= 0)
    throw Error('operator_group must name a non-root group');
  return { group, gid };
}
/** One minute to one day: long enough for a person to answer, short enough to free the station. */
function approvalTtl(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 60000 || (value as number) > 86400000)
    throw Error('approval_ttl_ms must be an integer from 60000 to 86400000');
  return value as number;
}
export function hostApprovalTtlMs(m: HostManifest): number | undefined {
  return m.schema === 6 ? m.approval_ttl_ms : undefined;
}
export function hostOperatorAccess(m: HostManifest): OperatorAccess | undefined {
  return m.schema === 6 ? m.operator_access : undefined;
}
export type HostManifest =
  | CodingHostManifest
  | AgentPodHostManifest
  | AgentPodMcpHostManifest
  | AgentPodToolkitHostManifest
  | AgentPodStationHostManifest
  | AgentPodStrictWorkHostManifest;
export function hostMcp(m: HostManifest): AgentPodMcpHostManifest['managed_mcp'] | undefined {
  return m.schema === 3 || m.schema === 4 || m.schema === 5 || m.schema === 6
    ? m.managed_mcp
    : undefined;
}

export function hostToolkit(
  m: HostManifest,
): AgentPodToolkitHostManifest['managed_toolkit'] | undefined {
  return m.schema === 4 || m.schema === 5 || m.schema === 6 ? m.managed_toolkit : undefined;
}

function privateDocument(path: string): Record<string, unknown> {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > 65536)
      throw Error('Host manifest must be private (mode 600), owner-held and bounded');
    return object(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
function privateState(path: string, gid?: number): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw Error('Use canonical absolute private state paths');
  // Existing ancestors must resolve to their literal identity; never follow a workspace symlink.
  let existing = path;
  while (!existsSync(existing)) existing = join(existing, '..');
  if (realpathSync(existing) !== existing)
    throw Error('Private state path must not contain symlinks');
  if (existsSync(path)) {
    const st = lstatSync(path);
    // The launcher profile lets exactly one group traverse (x) to the operator socket.
    const shared = gid !== undefined && (st.mode & 0o077) === 0o010 && st.gid === gid;
    if (!st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077 && !shared))
      throw Error('Host state must be a private owner-held directory');
  }
  return path;
}
async function planAgentPod(
  c: Record<string, unknown>,
): Promise<
  | AgentPodHostManifest
  | AgentPodMcpHostManifest
  | AgentPodToolkitHostManifest
  | AgentPodStationHostManifest
  | AgentPodStrictWorkHostManifest
> {
  const fields = [
    'mode',
    'state',
    'agentpod_config',
    'provider',
    'model',
    'max_output_tokens',
    'workspace_id',
    'mcp_config',
    'toolkit_config',
    'station_config',
    'strict_work_version',
    'operator_group',
    'operator_mcp_config',
    'persona_config',
    'approval_ttl_ms',
    'unsandboxed_commands',
  ];
  if (Object.keys(c).some((k) => !fields.includes(k)))
    throw Error('Unexpected AgentPod host config field');
  if (
    c.strict_work_version !== undefined &&
    (c.strict_work_version !== 1 || c.station_config === undefined)
  )
    throw Error('Strict work version1 requires reviewed protected station config');
  let access: OperatorAccess | undefined;
  if (c.operator_group !== undefined) {
    if (c.strict_work_version !== 1)
      throw Error('operator_group is only for the strict work launcher profile');
    if (process.platform !== 'linux' || process.getuid?.() !== 0)
      throw Error('The launcher profile is planned by root on Linux');
    access = resolveOperatorGroup(c.operator_group);
  }
  let operatorMcp: { config: string; digest: string } | undefined;
  if (c.operator_mcp_config !== undefined) {
    if (c.strict_work_version !== 1)
      throw Error('operator_mcp_config is only for the strict work host profile');
    const config = string(c.operator_mcp_config, 'operator_mcp_config');
    if (!isAbsolute(config) || realpathSync(config) !== config)
      throw Error('Use a canonical absolute operator MCP config path');
    operatorMcp = { config, digest: OperatorMcp.load(config).digest };
  }
  let persona: { config: string; digest: string } | undefined;
  if (c.persona_config !== undefined) {
    if (c.strict_work_version !== 1)
      throw Error('persona_config is only for the strict work host profile');
    const config = string(c.persona_config, 'persona_config');
    persona = { config, digest: loadPersona(config).digest };
  }
  let ttl: number | undefined;
  if (c.approval_ttl_ms !== undefined) {
    if (c.strict_work_version !== 1)
      throw Error('approval_ttl_ms is only for the strict work host profile');
    ttl = approvalTtl(c.approval_ttl_ms);
  }
  if (c.unsandboxed_commands !== undefined && c.unsandboxed_commands !== 'allow')
    throw Error('unsandboxed_commands is "allow" or absent');
  const allowUnsandboxed = c.unsandboxed_commands === 'allow';
  const state = privateState(string(c.state, 'state'), access?.gid);
  const config = string(c.agentpod_config, 'agentpod_config');
  if (!isAbsolute(config) || realpathSync(config) !== config)
    throw Error('Use a canonical absolute pins path');
  const pins = readAgentPodPins(config, state);
  for (const path of [ROOT, process.execPath, config, state])
    if (path === pins.workspace || path.startsWith(pins.workspace + sep))
      throw Error('AgentPod private runtime, pins and state must be outside the workspace');
  let route = providerRoute(
    c.provider === undefined ? 'offline' : String(c.provider),
    c.model as string | undefined,
    c.max_output_tokens as number | undefined,
    c.workspace_id as string | undefined,
  );
  if (route.provider !== 'salaam-proof')
    route = bindProviderConfiguration(route, await resolveProviderAuth(route));
  const managed =
    c.mcp_config === undefined
      ? undefined
      : {
          config: string(c.mcp_config, 'mcp_config'),
          profile_digest: digest({
            profile: readMcpProfile(string(c.mcp_config, 'mcp_config'), pins),
            pins_digest: digest(pins),
          }),
        };
  const toolkit =
    c.toolkit_config === undefined
      ? undefined
      : {
          config: string(c.toolkit_config, 'toolkit_config'),
          configuration_digest: digest(
            readToolkitConfig(
              string(c.toolkit_config, 'toolkit_config'),
              undefined,
              pins.workspace,
            ),
          ),
        };
  const station =
    c.station_config === undefined
      ? undefined
      : {
          config: string(c.station_config, 'station_config'),
          configuration_digest: digest(
            readStationConfig(string(c.station_config, 'station_config'), pins.workspace),
          ),
        };
  return {
    ...(station
      ? {
          ...(c.strict_work_version === 1
            ? {
                schema: 6 as const,
                strict_work: { version: 1 as const },
                ...(access ? { operator_access: access } : {}),
                ...(operatorMcp ? { operator_mcp: operatorMcp } : {}),
                ...(persona ? { persona } : {}),
                ...(ttl !== undefined ? { approval_ttl_ms: ttl } : {}),
              }
            : { schema: 5 as const }),
          station_execution: station,
          ...(toolkit ? { managed_toolkit: toolkit } : {}),
          ...(managed ? { managed_mcp: managed } : {}),
        }
      : toolkit
        ? {
            schema: 4 as const,
            managed_toolkit: toolkit,
            ...(managed ? { managed_mcp: managed } : {}),
          }
        : managed
          ? { schema: 3 as const, managed_mcp: managed }
          : { schema: 2 as const }),
    mode: 'agentpod',
    node: realpathSync(process.execPath),
    node_version: process.version,
    repo: realpathSync(ROOT),
    ...hostDigests(),
    state,
    provider: route,
    agentpod_config: config,
    pins_digest: digest(pins),
    workspace: pins.workspace,
    cli_digest: digest(readFileSync(join(ROOT, 'bin/salaam.mjs'), 'utf8')),
    local_sandbox: hostLocalSandbox(undefined, undefined, undefined, allowUnsandboxed),
  };
}
export function hostDigests() {
  const hashDir = (path: string) =>
    digest(
      readdirSync(path)
        .filter((f) => /\.(ts|js)$/.test(f))
        .sort()
        .map((file) => ({ file, content: readFileSync(join(path, file), 'utf8') })),
    );
  return {
    source_digest: hashDir(join(ROOT, 'src')),
    build_digest: hashDir(join(ROOT, 'dist/src')),
    pi_bundle_digest: bundleDigest(),
  };
}
export async function planHost(input: unknown): Promise<HostManifest> {
  const c = object(input);
  if (c.mode === 'agentpod') return planAgentPod(c);
  if (
    Object.keys(c).some(
      (k) =>
        ![
          'state',
          'coding_root',
          'coding_socket',
          'provider',
          'model',
          'max_output_tokens',
          'workspace_id',
        ].includes(k),
    )
  )
    throw new Error('Unexpected host config field; keys and arbitrary arguments are not accepted');
  const state = resolve(string(c.state, 'state')),
    coding_root = resolve(string(c.coding_root, 'coding_root')),
    coding_socket = realpathSync(string(c.coding_socket, 'coding_socket'));
  for (const path of [state, ROOT, process.env.HOME ?? ''])
    if (path === coding_root || path.startsWith(coding_root + sep))
      throw new Error('Coding root must not contain service state, source, or credential home');
  if (!isAbsolute(String(c.state)) || !isAbsolute(String(c.coding_root)))
    throw new Error('Use absolute host paths');
  mkdirSync(coding_root, { recursive: true, mode: 0o700 });
  const executor = new DockerCodingExecutor(engineRequest(coding_socket));
  await executor.prepare(coding_root);
  let route = providerRoute(
    c.provider === undefined ? 'offline' : String(c.provider),
    c.model as string | undefined,
    c.max_output_tokens as number | undefined,
    c.workspace_id as string | undefined,
  );
  if (route.provider !== 'salaam-proof')
    route = bindProviderConfiguration(route, await resolveProviderAuth(route));
  return {
    schema: 1,
    node: realpathSync(process.execPath),
    node_version: process.version,
    repo: realpathSync(ROOT),
    ...hostDigests(),
    state,
    coding_root: realpathSync(coding_root),
    coding_socket,
    provider: route,
    profile_digest: executor.profileDigest,
    engine_id: executor.engineId,
  };
}
export function readHost(path: string): HostManifest {
  const m = privateDocument(path) as unknown as HostManifest;
  if (
    ![1, 2, 3, 4, 5, 6].includes(m.schema) ||
    m.node_version !== 'v26.7.0' ||
    process.version !== m.node_version ||
    realpathSync(process.execPath) !== m.node ||
    realpathSync(ROOT) !== m.repo
  )
    throw new Error('Host runtime/path does not match the reviewed manifest');
  const hashes = hostDigests();
  for (const key of ['source_digest', 'build_digest', 'pi_bundle_digest'] as const)
    if (m[key] !== hashes[key]) throw new Error('Host source/build changed: ' + key);
  if (m.schema === 2 || m.schema === 3 || m.schema === 4 || m.schema === 5 || m.schema === 6) {
    const fields = [
      'schema',
      'mode',
      'node',
      'node_version',
      'repo',
      'source_digest',
      'build_digest',
      'pi_bundle_digest',
      'state',
      'provider',
      'agentpod_config',
      'pins_digest',
      'workspace',
      'cli_digest',
      ...(m.schema === 3 || ([4, 5, 6].includes(m.schema) && Object.hasOwn(m, 'managed_mcp'))
        ? ['managed_mcp']
        : []),
      ...(m.schema === 4 || ([5, 6].includes(m.schema) && Object.hasOwn(m, 'managed_toolkit'))
        ? ['managed_toolkit']
        : []),
      ...([5, 6].includes(m.schema) ? ['station_execution'] : []),
      ...(m.schema === 6 ? ['strict_work'] : []),
      ...(m.schema === 6 && Object.hasOwn(m, 'operator_access') ? ['operator_access'] : []),
      ...(m.schema === 6 && Object.hasOwn(m, 'operator_mcp') ? ['operator_mcp'] : []),
      ...(m.schema === 6 && Object.hasOwn(m, 'persona') ? ['persona'] : []),
      ...(m.schema === 6 && Object.hasOwn(m, 'approval_ttl_ms') ? ['approval_ttl_ms'] : []),
      ...(Object.hasOwn(m, 'local_sandbox') ? ['local_sandbox'] : []),
    ];
    if (m.mode !== 'agentpod' || Object.keys(m).sort().join(',') !== fields.sort().join(','))
      throw Error('Unsupported AgentPod host manifest fields');
    if (
      m.schema === 6 &&
      (Object.keys(object(m.strict_work)).join(',') !== 'version' || m.strict_work.version !== 1)
    )
      throw Error('Unsupported strict work host contract');
    const access = hostOperatorAccess(m);
    if (access !== undefined) {
      const a = object(access);
      if (
        Object.keys(a).sort().join(',') !== 'gid,group' ||
        canonical(resolveOperatorGroup(a.group)) !== canonical({ group: a.group, gid: a.gid })
      )
        throw Error('Host operator group changed');
    }
    privateState(m.state, access?.gid);
    if (m.schema === 6 && Object.hasOwn(m, 'approval_ttl_ms')) approvalTtl(m.approval_ttl_ms);
    if (m.schema === 6 && Object.hasOwn(m, 'operator_mcp')) {
      const o = object(m.operator_mcp);
      if (
        Object.keys(o).sort().join(',') !== 'config,digest' ||
        typeof o.config !== 'string' ||
        !isAbsolute(o.config) ||
        realpathSync(o.config) !== o.config ||
        OperatorMcp.load(o.config).digest !== o.digest
      )
        throw Error('Operator MCP declarations changed');
    }
    if (m.schema === 6 && Object.hasOwn(m, 'persona')) {
      const p = object(m.persona);
      let current: string | null = null;
      try {
        current = loadPersona(String(p.config)).digest;
      } catch {
        current = null;
      }
      if (Object.keys(p).sort().join(',') !== 'config,digest' || current !== p.digest)
        throw Error('Host persona changed; run host plan again');
    }
    if (m.cli_digest !== digest(readFileSync(join(ROOT, 'bin/salaam.mjs'), 'utf8')))
      throw Error('Host CLI changed');
    if (
      Object.hasOwn(m, 'local_sandbox') &&
      canonical(m.local_sandbox) !==
        canonical(hostLocalSandbox(undefined, undefined, undefined, hostAllowsUnsandboxed(m)))
    )
      throw Error('Host command sandbox changed; run host plan again');
    const pins = readAgentPodPins(m.agentpod_config, m.state);
    const managed = hostMcp(m);
    if (m.schema === 3 || ([4, 5, 6].includes(m.schema) && Object.hasOwn(m, 'managed_mcp'))) {
      if (!managed) throw Error('Missing managed MCP host fields');
      if (Object.keys(object(managed)).sort().join(',') !== 'config,profile_digest')
        throw Error('Unsupported managed MCP host fields');
      new McpAdmission(managed.config, pins, managed.profile_digest);
    }
    const native = hostToolkit(m);
    if (m.schema === 4 || ([5, 6].includes(m.schema) && Object.hasOwn(m, 'managed_toolkit'))) {
      if (!native) throw Error('Missing native Toolkit host fields');
      if (Object.keys(object(native)).sort().join(',') !== 'config,configuration_digest')
        throw Error('Unsupported native Toolkit host fields');
      readToolkitConfig(native.config, native.configuration_digest, pins.workspace);
    }
    if (m.schema === 5 || m.schema === 6) {
      if (
        Object.keys(object(m.station_execution)).sort().join(',') !== 'config,configuration_digest'
      )
        throw Error('Unsupported station execution fields');
      readStationConfig(
        m.station_execution.config,
        pins.workspace,
        m.station_execution.configuration_digest,
      );
    }
    if (
      !isAbsolute(m.agentpod_config) ||
      realpathSync(m.agentpod_config) !== m.agentpod_config ||
      pins.workspace !== m.workspace ||
      digest(pins) !== m.pins_digest
    )
      throw Error('AgentPod host pins changed');
    for (const p of [m.node, m.repo, m.state, m.agentpod_config, realpathSync(path)])
      if (p === m.workspace || p.startsWith(m.workspace + sep))
        throw Error('AgentPod private host paths overlap the workspace');
    const route =
      m.provider.provider === 'salaam-proof'
        ? providerRoute()
        : providerRoute(
            m.provider.provider,
            m.provider.model,
            m.provider.max_tokens,
            m.provider.workspace_id,
            m.provider.connection,
          );
    if (canonical(route) !== canonical(m.provider)) throw Error('Invalid reviewed provider route');
  }
  return m;
}
/** What the daemon reports about itself so that a caller which cannot read the
 * manifest (the launcher profile) receives the same receipt as host start. */
export function hostReceipt(m: HostManifest) {
  if (m.schema === 1) return undefined;
  const pins = readAgentPodPins(m.agentpod_config, m.state);
  return {
    version: 1,
    ready: true,
    manifest_digest: digest(m),
    node: m.node,
    cli: join(m.repo, 'bin/salaam.mjs'),
    state: m.state,
    workspace: m.workspace,
    node_id: pins.node_id,
    pins_digest: m.pins_digest,
    strict_work: m.schema === 6 ? m.strict_work : null,
  };
}
/** The tools user a reviewed station config names, for host serve's --tools-user. */
export function hostToolsUser(m: HostManifest): string | undefined {
  if (m.schema !== 5 && m.schema !== 6) return undefined;
  return readStationConfig(
    m.station_execution.config,
    m.workspace,
    m.station_execution.configuration_digest,
  ).tools_user;
}
export function hostUnit(path: string, platform: string): string {
  const m = readHost(path),
    manifest = realpathSync(path),
    args = [m.node, join(m.repo, 'bin/salaam.mjs'), 'host', 'run', '--manifest', manifest];
  if (platform === 'systemd') {
    const q = (v: string) => '"' + v.replace(/[\\"%]/g, (c) => (c === '%' ? '%%' : '\\' + c)) + '"';
    return (
      '[Unit]\nDescription=Salaam execution host\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=' +
      args.map(q).join(' ') +
      '\nWorkingDirectory=' +
      q(m.repo) +
      '\nRestart=on-failure\nRestartSec=5\nUMask=0077\nKillMode=mixed\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n'
    );
  }
  if (platform === 'launchd') {
    const xml = (v: string) =>
      v.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
      );
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.salaam.host</string><key>ProgramArguments</key><array>' +
      args.map((v) => '<string>' + xml(v) + '</string>').join('') +
      '</array><key>WorkingDirectory</key><string>' +
      xml(m.repo) +
      '</string><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>5</integer><key>Umask</key><integer>63</integer></dict></plist>\n'
    );
  }
  throw new Error('Use systemd or launchd');
}
function save(path: string, value: unknown) {
  const tmp = path + '.tmp',
    fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(join(path, '..'), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
/** OS supervision owns this process; this process owns one daemon, with bounded restart/backoff. */
export async function runHost(path: string): Promise<void> {
  const m = readHost(path),
    dir = join(m.state, 'host');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const release = acquireStateLock(dir),
    status = join(dir, 'status.json');
  let stopping = false,
    child: ReturnType<typeof spawn> | undefined,
    restarts = 0,
    healthy = false;
  if (existsSync(status)) {
    const previous = JSON.parse(readFileSync(status, 'utf8'));
    restarts = Number(previous.restarts) || 0;
  }
  const stop = () => {
    stopping = true;
    child?.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    for (let failures = 0; !stopping;) {
      if (digest(readHost(path)) !== digest(m))
        throw Error('Reviewed host manifest changed; restart explicitly');
      healthy = false;
      const started = Date.now();
      child = spawn(
        m.node,
        [join(m.repo, 'bin/salaam.mjs'), 'host', 'serve', '--manifest', resolve(path)],
        {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          env: {
            PATH: join(m.node, '..') + ':/usr/bin:/bin',
            HOME: process.env.HOME,
            LANG: 'en_US.UTF-8',
          },
        },
      );
      const report = (error?: string) =>
        save(status, {
          schema: 1,
          manifest_digest: digest(m),
          supervisor_pid: process.pid,
          daemon_pid: child?.pid,
          restarts,
          healthy,
          stopping,
          updated_at: Date.now(),
          ...(error ? { error } : {}),
        });
      report();
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        try {
          if (digest(readHost(path)) !== digest(m)) throw Error('Reviewed host manifest changed');
        } catch (error) {
          healthy = false;
          report((error as Error).message);
          child?.kill('SIGTERM');
          return;
        }
        checking = true;
        void call<any>(join(m.state, 'operator.sock'), '/v1/health')
          .then((h) => {
            healthy =
              h.service === 'healthy' &&
              !h.job_execution.control_error &&
              !h.job_execution.schedule_control_error &&
              !h.job_execution.inbox_control_error;
            report();
          })
          .catch((error) => {
            healthy = false;
            report((error as Error).message);
          })
          .finally(() => {
            checking = false;
          });
      }, 1000);
      const exit = await Promise.race([
        once(child, 'exit'),
        once(child, 'error').then(([e]) => {
          throw e;
        }),
      ]).finally(() => clearInterval(timer));
      healthy = false;
      report('Daemon exited ' + String(exit[0]));
      child = undefined;
      if (stopping) break;
      restarts++;
      failures = Date.now() - started > 60000 ? 0 : failures + 1;
      if (failures >= 5)
        throw new ServiceError(
          'host_crash_loop',
          'Five daemon exits within bounded startup windows; inspect host status and logs',
        );
      await new Promise<void>((done) => {
        const wake = () => {
          clearTimeout(t);
          process.off('SIGTERM', wake);
          process.off('SIGINT', wake);
          done();
        };
        const t = setTimeout(wake, Math.min(1000 * 2 ** failures, 30000));
        process.once('SIGTERM', wake);
        process.once('SIGINT', wake);
      });
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    child?.kill('SIGTERM');
    release();
  }
}
