import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { planHost } from './host.js';
import { canonical, digest } from './protocol.js';
import {
  stationHash,
  stationRuntimeFingerprint,
  stationWorkspaceIdentity,
} from './station-config.js';

export interface BindInput {
  organization_id: string;
  node_id: string;
  station_key: string;
  workspace: string;
  tools_user: string;
  files: string;
  runtime_root: string;
  runtime_image_digest: string;
  operator_group?: string;
  dir?: string;
  state?: string;
  provider?: string;
  model?: string;
  mcp_config?: string;
  /** Defaults to /usr/bin/systemd-run and /usr/bin/systemctl. */
  systemd_run?: string;
  systemctl?: string;
  /** Tests only: where the default per-station directories live. */
  roots?: { config: string; state: string };
}

const userName = /^[a-z_][a-z0-9_-]{0,31}$/;
function pin(path: string) {
  const real = realpathSync(path);
  return { path: real, sha256: stationHash(readFileSync(real)) };
}
/** Write a private file only when its content changes; report whether it did. */
function put(path: string, value: unknown): boolean {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  const tmp = path + '.tmp',
    fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return true;
}

/** Bind one AgentPod station to a launcher-profile strict work host. Root on Linux.
 * Every output is derived from the inputs; nothing is edited by hand. */
export async function bindHost(input: BindInput) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw Error('host bind runs as root on Linux');
  const workspace = input.workspace;
  if (!isAbsolute(workspace) || realpathSync(workspace) !== workspace)
    throw Error('Use the canonical absolute workspace path');
  const key = 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  if (input.station_key !== key)
    throw Error('Station key does not name this workspace (expected ' + key + ')');
  if (!userName.test(input.tools_user)) throw Error('tools user must be a user name');
  try {
    execFileSync('/usr/bin/getent', ['passwd', input.tools_user], { stdio: 'ignore' });
  } catch {
    throw Error('tools user does not exist');
  }
  if (input.tools_user === 'root') throw Error('tools user must not be root');
  const id = key.slice('salaam:'.length),
    roots = input.roots ?? { config: '/etc/salaam/stations', state: '/var/lib/salaam/stations' },
    dir = resolve(input.dir ?? join(roots.config, id)),
    state = resolve(input.state ?? join(roots.state, id, 'state'));
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  mkdirSync(join(state, '..'), { recursive: true, mode: 0o700 });
  const pinsPath = join(dir, 'agentpod-pins.json'),
    stationPath = join(dir, 'station-config.json'),
    configPath = join(dir, 'host-config.json'),
    manifestPath = join(dir, 'host.json');
  let changed = put(pinsPath, {
    version: 1,
    organization_id: input.organization_id,
    node_id: input.node_id,
    station_key: key,
    workspace,
  });
  const runtime = realpathSync(input.runtime_root);
  changed =
    put(stationPath, {
      version: 1,
      kind: 'linux-systemd-station-v1',
      workspace,
      workspace_identity: stationWorkspaceIdentity(workspace),
      files: pin(input.files),
      systemd_run: pin(input.systemd_run ?? '/usr/bin/systemd-run'),
      systemctl: pin(input.systemctl ?? '/usr/bin/systemctl'),
      runtime_root: runtime,
      runtime_fingerprint: stationRuntimeFingerprint(runtime),
      runtime_image_digest: input.runtime_image_digest,
      tools_user: input.tools_user,
    }) || changed;
  const config = {
    mode: 'agentpod',
    state,
    agentpod_config: pinsPath,
    station_config: stationPath,
    strict_work_version: 1,
    ...(input.operator_group ? { operator_group: input.operator_group } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.mcp_config ? { operator_mcp_config: realpathSync(input.mcp_config) } : {}),
  };
  changed = put(configPath, config) || changed;
  const manifest = await planHost(config);
  const before = existsSync(manifestPath)
    ? canonical(JSON.parse(readFileSync(manifestPath, 'utf8')))
    : null;
  if (before !== canonical(manifest)) {
    put(manifestPath, manifest);
    changed = true;
  }
  return {
    version: 1,
    station_key: key,
    dir,
    state,
    manifest: manifestPath,
    manifest_digest: digest(manifest),
    unit: 'salaam-host@' + id + '.service',
    changed,
  };
}
