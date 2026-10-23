import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  readlinkSync,
} from 'node:fs';
import { isAbsolute, resolve, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { digest, object, ServiceError } from './protocol.js';

export interface StationExecutable {
  path: string;
  sha256: string;
}
export interface StationConfig {
  version: 1;
  kind: 'linux-systemd-station-v1';
  workspace: string;
  workspace_identity: string;
  files: StationExecutable;
  systemd_run: StationExecutable;
  systemctl: StationExecutable;
  runtime_root: string;
  runtime_fingerprint: string;
  runtime_image_digest: string;
  /** OS user the agent's local tools run as (salaam --tools-user). Optional. */
  tools_user?: string;
}
const hashShape = /^[a-f0-9]{64}$/;
export const stationHash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
export function stationUnavailable(): never {
  throw new ServiceError(
    'station_execution_unavailable',
    'Reviewed station execution boundary is unavailable or changed',
  );
}
export function stationPrivateFile(path: string, limit: number): Buffer {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    stationUnavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.nlink !== 1 ||
      before.size > limit
    )
      stationUnavailable();
    const bytes = readFileSync(fd),
      after = fstatSync(fd),
      leaf = lstatSync(path);
    if (
      before.ino !== leaf.ino ||
      before.dev !== leaf.dev ||
      leaf.isSymbolicLink() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      stationUnavailable();
    return bytes;
  } finally {
    closeSync(fd);
  }
}
export function stationWorkspaceIdentity(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
    stationUnavailable();
  const st = lstatSync(path, { bigint: true });
  if (!st.isDirectory()) stationUnavailable();
  return digest({ dev: String(st.dev), inode: String(st.ino) });
}
function executable(value: unknown): StationExecutable {
  const e = object(value);
  if (
    Object.keys(e).sort().join(',') !== 'path,sha256' ||
    typeof e.path !== 'string' ||
    typeof e.sha256 !== 'string' ||
    !hashShape.test(e.sha256) ||
    !isAbsolute(e.path) ||
    resolve(e.path) !== e.path ||
    realpathSync(e.path) !== e.path
  )
    stationUnavailable();
  const fd = openSync(e.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.mode & 0o022 ||
      !(st.mode & 0o111) ||
      st.size > 128 * 1024 * 1024 ||
      ![0, process.getuid?.()].includes(st.uid) ||
      stationHash(readFileSync(fd)) !== e.sha256
    )
      stationUnavailable();
  } finally {
    closeSync(fd);
  }
  return { path: e.path, sha256: e.sha256 };
}
/** Metadata fingerprint of an operator-reviewed, immutable runtime image root.
 * This is drift detection, not a claim that a supplied image provenance is true.
 * Image extraction/digest verification belongs to the canary/runtime preparation. */
export function stationRuntimeFingerprint(root: string): string {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root || root === '/')
    stationUnavailable();
  const entries: unknown[] = [];
  const walk = (path: string, depth: number) => {
    if (depth > 40 || entries.length > 150000) stationUnavailable();
    const st = lstatSync(path, { bigint: true });
    if (
      (!st.isSymbolicLink() &&
        Number(st.mode) & 0o022 &&
        !(
          st.isDirectory() &&
          ['/tmp', '/var/tmp', '/dev/shm'].includes(path.slice(root.length)) &&
          Number(st.mode) & 0o1000
        )) ||
      ![0, process.getuid?.()].includes(Number(st.uid)) ||
      (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink())
    )
      stationUnavailable();
    entries.push([
      path.slice(root.length),
      String(st.dev),
      String(st.ino),
      String(st.mode),
      String(st.size),
      String(st.mtimeNs),
      String(st.ctimeNs),
      st.isSymbolicLink() ? readlinkSync(path) : null,
    ]);
    if (st.isDirectory()) for (const n of readdirSync(path).sort()) walk(join(path, n), depth + 1);
  };
  walk(root, 0);
  return digest(entries);
}
export function readStationConfig(
  path: string,
  workspace: string,
  expected?: string,
): StationConfig {
  try {
    const v = object(JSON.parse(stationPrivateFile(path, 16384).toString('utf8')));
    const keys = Object.keys(v)
      .filter((k) => k !== 'tools_user')
      .sort()
      .join(',');
    if (
      keys !==
        'files,kind,runtime_fingerprint,runtime_image_digest,runtime_root,systemctl,systemd_run,version,workspace,workspace_identity' ||
      (Object.hasOwn(v, 'tools_user') &&
        (typeof v.tools_user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(v.tools_user))) ||
      v.version !== 1 ||
      v.kind !== 'linux-systemd-station-v1' ||
      v.workspace !== workspace ||
      v.workspace_identity !== stationWorkspaceIdentity(workspace) ||
      typeof v.runtime_root !== 'string' ||
      typeof v.runtime_fingerprint !== 'string' ||
      !hashShape.test(v.runtime_fingerprint) ||
      typeof v.runtime_image_digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(v.runtime_image_digest)
    )
      stationUnavailable();
    const c: StationConfig = {
      version: 1,
      kind: v.kind,
      workspace,
      workspace_identity: String(v.workspace_identity),
      files: executable(v.files),
      systemd_run: executable(v.systemd_run),
      systemctl: executable(v.systemctl),
      runtime_root: v.runtime_root,
      runtime_fingerprint: v.runtime_fingerprint,
      runtime_image_digest: v.runtime_image_digest,
      ...(Object.hasOwn(v, 'tools_user') ? { tools_user: v.tools_user as string } : {}),
    };
    if (
      workspace
        .split(sep)
        .some((n) =>
          [
            '.claude',
            '.pi',
            '.codex',
            '.hermes',
            '.openclaw',
            '.config',
            '.local',
            '.ssh',
            '.aws',
          ].includes(n.toLowerCase()),
        )
    )
      stationUnavailable();
    const home = process.env.HOME;
    if (home && (home === workspace || home.startsWith(workspace + sep))) stationUnavailable();
    for (const p of [path, c.runtime_root, c.files.path, c.systemd_run.path, c.systemctl.path])
      if (p === workspace || p.startsWith(workspace + sep)) stationUnavailable();
    if (
      stationRuntimeFingerprint(c.runtime_root) !== c.runtime_fingerprint ||
      (expected !== undefined && digest(c) !== expected)
    )
      stationUnavailable();
    return c;
  } catch {
    stationUnavailable();
  }
}
