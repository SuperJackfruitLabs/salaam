import { spawn } from 'node:child_process';
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
}
export interface AgentPodHostManifest extends AgentPodHostIdentity {
  schema: 2;
}
export interface AgentPodMcpHostManifest extends AgentPodHostIdentity {
  schema: 3;
  managed_mcp: { config: string; profile_digest: string };
}
export type HostManifest = CodingHostManifest | AgentPodHostManifest | AgentPodMcpHostManifest;

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
function privateState(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw Error('Use canonical absolute private state paths');
  // Existing ancestors must resolve to their literal identity; never follow a workspace symlink.
  let existing = path;
  while (!existsSync(existing)) existing = join(existing, '..');
  if (realpathSync(existing) !== existing)
    throw Error('Private state path must not contain symlinks');
  if (existsSync(path)) {
    const st = lstatSync(path);
    if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & 0o077)
      throw Error('Host state must be a private owner-held directory');
  }
  return path;
}
async function planAgentPod(
  c: Record<string, unknown>,
): Promise<AgentPodHostManifest | AgentPodMcpHostManifest> {
  const fields = [
    'mode',
    'state',
    'agentpod_config',
    'provider',
    'model',
    'max_output_tokens',
    'workspace_id',
    'mcp_config',
  ];
  if (Object.keys(c).some((k) => !fields.includes(k)))
    throw Error('Unexpected AgentPod host config field');
  const state = privateState(string(c.state, 'state'));
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
  return {
    ...(managed ? { schema: 3 as const, managed_mcp: managed } : { schema: 2 as const }),
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
    ![1, 2, 3].includes(m.schema) ||
    m.node_version !== 'v26.7.0' ||
    process.version !== m.node_version ||
    realpathSync(process.execPath) !== m.node ||
    realpathSync(ROOT) !== m.repo
  )
    throw new Error('Host runtime/path does not match the reviewed manifest');
  const hashes = hostDigests();
  for (const key of ['source_digest', 'build_digest', 'pi_bundle_digest'] as const)
    if (m[key] !== hashes[key]) throw new Error('Host source/build changed: ' + key);
  if (m.schema === 2 || m.schema === 3) {
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
      ...(m.schema === 3 ? ['managed_mcp'] : []),
    ];
    if (m.mode !== 'agentpod' || Object.keys(m).sort().join(',') !== fields.sort().join(','))
      throw Error('Unsupported AgentPod host manifest fields');
    privateState(m.state);
    if (m.cli_digest !== digest(readFileSync(join(ROOT, 'bin/salaam.mjs'), 'utf8')))
      throw Error('Host CLI changed');
    const pins = readAgentPodPins(m.agentpod_config, m.state);
    if (m.schema === 3) {
      if (Object.keys(object(m.managed_mcp)).sort().join(',') !== 'config,profile_digest')
        throw Error('Unsupported managed MCP host fields');
      new McpAdmission(m.managed_mcp.config, pins, m.managed_mcp.profile_digest);
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
