import { COMMAND_NETWORK_PORT, inSandboxRelaySource } from './command-network.js';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { ServiceError } from '../core/index.js';

/**
 * Item 10: the sandbox a local command runs in. `workspace-write` (the default) and `read-only` run
 * the command under the host's OS sandbox, with the system read-only, a private tmp, the workspace
 * writable or read-only, and no network unless declared:
 * - Linux: bubblewrap, with an empty root and user, PID, IPC, UTS and network namespaces unshared,
 *   dying with its parent;
 * - macOS: Seatbelt (`sandbox-exec`), with a deny-by-default profile.
 * `full-access` runs the command as is and must be chosen explicitly by the operator. A host with
 * no usable sandbox refuses local commands (operator ruling 2026-10-30, option A) unless the host
 * config sets `unsandboxed_commands: "allow"`; then it runs them unsandboxed and says so:
 * "unsandboxed" in host plan and in every approval, and kind `none` in the approved arguments and
 * the execution result.
 */
export const SANDBOX_LEVELS = ['read-only', 'workspace-write', 'full-access'] as const;
export type SandboxLevel = (typeof SANDBOX_LEVELS)[number];
export interface Bwrap {
  path: string;
  version: string;
}
export interface Seatbelt {
  path: string;
  /** The active Apple developer dir (`xcode-select -p`) when it holds a real git. /usr/bin/git is
   * a shim that needs Xcode's licence preferences, which the profile does not open; commands get
   * the real tools first on PATH instead (step 0, 2026-10-31). */
  developerDir?: string;
}
export type SandboxKind = 'bwrap' | 'seatbelt' | 'none';

/**
 * Phase 1 (2026-10-31): read-only paths outside the workspace an operator lets local commands use
 * (a toolchain, a package cache, `~/.gitconfig`). Never the root, home itself or an ancestor of
 * it, and never a credential directory or file, or an ancestor of one. `toolchain` expands to the
 * ones that exist here: the prefix of the node running Salaam, and home's package caches and
 * toolchains. Writes stay inside the workspace whatever is listed.
 */
export const READ_PATHS_TOOLCHAIN = 'toolchain';
const CREDENTIALS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config/gcloud',
  '.config/gh',
  '.docker',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.claude',
  '.codex',
  '.config/salaam',
  'Library/Keychains',
];
const TOOLCHAIN = ['.npm', '.nvm', '.cargo', '.rustup', 'go', '.gitconfig', '.config/git'];
function within(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}
export function resolveReadPaths(entries: readonly string[], home = homedir()): string[] {
  const refuse = (path: string, why: string): never => {
    throw new ServiceError('invalid_field', `local_sandbox_read_paths: ${path} ${why}`);
  };
  const out: string[] = [];
  const add = (path: string) => {
    if (!isAbsolute(path)) refuse(path, 'must be an absolute path');
    if (/["\\\x00-\x1f\x7f]/.test(path)) refuse(path, 'has a character Seatbelt cannot quote');
    const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
    if (p === '/') refuse(p, 'is the whole filesystem');
    if (within(home, p)) refuse(p, 'would expose the whole home directory');
    for (const c of CREDENTIALS) {
      const secret = join(home, c);
      if (within(p, secret) || within(secret, p)) refuse(p, `covers credentials (${c})`);
    }
    if (!out.includes(p)) out.push(p);
  };
  for (const entry of entries) {
    if (typeof entry !== 'string') refuse(String(entry), 'must be a string');
    if (entry !== READ_PATHS_TOOLCHAIN) {
      add(entry);
      continue;
    }
    // The node running Salaam, so `node`/`npx`/`npm` resolve inside the sandbox.
    const nodePrefix = dirname(dirname(realpathSync(process.execPath)));
    if (!within(home, nodePrefix)) add(nodePrefix);
    for (const t of TOOLCHAIN) if (existsSync(join(home, t))) add(join(home, t));
  }
  return out;
}

/** The active developer dir when it has a real git, else undefined. */
function developerDir(): string | undefined {
  try {
    const dir = execFileSync('/usr/bin/xcode-select', ['-p'], {
      timeout: 5000,
      encoding: 'utf8',
    }).trim();
    return isAbsolute(dir) && existsSync(join(dir, 'usr/bin/git')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** The pinned bubblewrap: its absolute path and the version it reports, or null when unusable. */
export function findBwrap(candidates = ['/usr/bin/bwrap', '/bin/bwrap']): Bwrap | null {
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
      // Usable means it can actually make the namespaces we ask for, not just that it exists.
      execFileSync(
        path,
        ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', '--', '/bin/true'],
        {
          timeout: 5000,
          stdio: 'ignore',
        },
      );
      return { path, version };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The workspace repository's control files: what git reads to decide which programs to run
 * (config and what redirects it, hooks, attributes and excludes). A sandboxed command may write
 * the rest of `.git` (commit, branch, checkout, stash), but not these, so it cannot leave a
 * `core.fsmonitor`, a hook or a filter for git to run later outside the sandbox. Found when the
 * command starts:
 * - `entry`: `<root>/.git` itself, kept in place (no rename, delete or replace);
 * - for the repository's git dir (`.git`, or where a `.git` file points when that is inside the
 *   workspace), each submodule git dir under `modules/` and each linked worktree under
 *   `worktrees/`: `config`, `config.worktree`, `commondir` (files) and `hooks`, `info` (folders).
 * `exists` says whether the path was there. A repository the command creates later, or one in a
 * subfolder, is not covered here; Salaam's own git calls are hardened for that (host-git.ts).
 */
export interface GitControlPath {
  path: string;
  dir: boolean;
  exists: boolean;
}
const GIT_CONTROL_FILES = ['config', 'config.worktree', 'commondir'];
const GIT_CONTROL_DIRS = ['hooks', 'info'];
/** At most this many protected paths, so a workspace with thousands of submodules stays usable. */
const GIT_CONTROL_LIMIT = 256;
function isDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}
export function gitControlPaths(root: string): {
  entry: GitControlPath | null;
  paths: GitControlPath[];
} {
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return { entry: null, paths: [] };
  }
  const entryPath = join(real, '.git');
  let stat;
  try {
    stat = lstatSync(entryPath);
  } catch {
    return { entry: null, paths: [] };
  }
  const entry = { path: entryPath, dir: stat.isDirectory(), exists: true };
  const inside = (p: string) => p.startsWith(real + sep);
  const paths: GitControlPath[] = [];
  const seen = new Set<string>();
  const add = (path: string, dir: boolean) => {
    if (paths.length < GIT_CONTROL_LIMIT) paths.push({ path, dir, exists: existsSync(path) });
  };
  /** Where a pointer file (`gitdir: x` in .git, a `commondir`) leads, if it stays inside. */
  const follow = (file: string, base: string, prefix: string): string | null => {
    try {
      const text = readFileSync(file, 'utf8').trim();
      const target = realpathSync(
        resolve(base, text.startsWith(prefix) ? text.slice(prefix.length).trim() : text),
      );
      return inside(target) && isDir(target) ? target : null;
    } catch {
      return null;
    }
  };
  const gitDir = (dir: string, depth: number): void => {
    if (seen.has(dir) || depth > 8) return;
    seen.add(dir);
    for (const f of GIT_CONTROL_FILES) add(join(dir, f), false);
    for (const d of GIT_CONTROL_DIRS) add(join(dir, d), true);
    const common = existsSync(join(dir, 'commondir'))
      ? follow(join(dir, 'commondir'), dir, '')
      : null;
    if (common) gitDir(common, depth + 1);
    // Submodule git dirs; a submodule's name may hold slashes, so look below until a HEAD.
    const modules = (at: string, level: number): void => {
      if (level > 4) return;
      let names: string[];
      try {
        names = readdirSync(at);
      } catch {
        return;
      }
      for (const name of names) {
        const sub = join(at, name);
        if (!isDir(sub)) continue;
        if (existsSync(join(sub, 'HEAD'))) gitDir(sub, depth + 1);
        else modules(sub, level + 1);
      }
    };
    modules(join(dir, 'modules'), 0);
    let worktrees: string[] = [];
    try {
      worktrees = readdirSync(join(dir, 'worktrees'));
    } catch {
      /* no linked worktrees */
    }
    for (const w of worktrees) {
      const wt = join(dir, 'worktrees', w);
      if (!isDir(wt)) continue;
      add(join(wt, 'config.worktree'), false);
      add(join(wt, 'commondir'), false);
    }
  };
  if (entry.dir) gitDir(entryPath, 0);
  else if (stat.isFile()) {
    const target = follow(entryPath, real, 'gitdir:');
    if (target) gitDir(target, 0);
  }
  return { entry, paths };
}

/** bubblewrap arguments that keep the git control files read-only (see gitControlPaths). `.git`
 * is bound onto itself so it is a mount point that cannot be renamed or removed; each control file
 * or folder is bound read-only over itself. A missing `hooks` or `info` folder gets a read-only
 * empty tmpfs (bubblewrap creates the empty folder for the mount, as `git init` would); a missing
 * control file is left alone, since a mount point would have to be created as an empty file and
 * an empty `commondir` breaks git. */
function bwrapGitControl(root: string): string[] {
  const { entry, paths } = gitControlPaths(root);
  if (!entry) return [];
  return [
    ...(entry.dir ? ['--bind', entry.path, entry.path] : ['--ro-bind', entry.path, entry.path]),
    ...paths.flatMap((p) =>
      p.exists
        ? ['--ro-bind', p.path, p.path]
        : p.dir
          ? ['--tmpfs', p.path, '--remount-ro', p.path]
          : [],
    ),
  ];
}

const sbplGitPath = (p: string) => sbplPath(p, 'git path');
/** Seatbelt rules that refuse writes to the git control files (see gitControlPaths), present or
 * not: a path rule needs no file to exist. Later rules win in a profile, so these follow the
 * workspace's allow. */
function seatbeltGitControl(root: string): string[] {
  const { entry, paths } = gitControlPaths(root);
  if (!entry) return [];
  const rules = [
    `(literal ${sbplGitPath(entry.path)})`,
    ...paths.map((p) =>
      p.dir ? `(subpath ${sbplGitPath(p.path)})` : `(literal ${sbplGitPath(p.path)})`,
    ),
  ];
  return [`(deny file-write* ${rules.join(' ')})`];
}

export function sandboxArgv(
  level: SandboxLevel,
  root: string,
  argv: string[],
  bwrap: Bwrap | null,
  options: {
    network: boolean;
    /** Broker network: the host relay's private directory and the node that runs the in-sandbox
     * relay. The network stays unshared; only the relay socket and node are bound in. */
    broker?: { dir: string; node: string };
    /** Operator-allowed read-only paths outside the workspace (resolveReadPaths). */
    readPaths?: readonly string[];
  },
): string[] {
  if (level === 'full-access') return argv;
  if (!bwrap)
    throw new ServiceError(
      'sandbox_unavailable',
      'This host has no usable bubblewrap, so it cannot run a sandboxed command; an operator can choose full access explicitly',
    );
  if (!isAbsolute(root) || root.includes('\0'))
    throw new ServiceError('invalid_field', 'A sandboxed command needs an absolute workspace path');
  // Optional system directories, bound read-only only where the host has them.
  const optional = ['/lib', '/lib64', '/lib32', '/bin', '/sbin', '/etc/alternatives'].flatMap(
    (dir) => ['--ro-bind-try', dir, dir],
  );
  return [
    bwrap.path,
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    ...(options.network ? [] : ['--unshare-net']),
    '--die-with-parent',
    '--new-session',
    '--tmpfs',
    '/',
    // The system read-only; /usr and /etc/ssl always asked for, the rest only where present.
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/etc/ssl',
    '/etc/ssl',
    ...optional,
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    // Operator-allowed toolchains, read-only, at their own paths (a symlink into one resolves).
    ...(options.readPaths ?? []).flatMap((p) => ['--ro-bind-try', p, p]),
    level === 'read-only' ? '--ro-bind' : '--bind',
    root,
    root,
    // The repository's control files stay read-only in a writable workspace.
    ...(level === 'workspace-write' ? bwrapGitControl(root) : []),
    // Broker network: only the host relay's socket directory and the node that bridges to it.
    ...(options.broker
      ? [
          '--bind',
          options.broker.dir,
          '/run/salaam-net',
          '--ro-bind',
          options.broker.node,
          '/run/salaam-node',
        ]
      : []),
    // The empty root itself is read-only too: only the workspace (and the private /tmp) is writable.
    '--remount-ro',
    '/',
    '--chdir',
    root,
    '--',
    ...(options.broker
      ? [
          '/run/salaam-node',
          '-e',
          inSandboxRelaySource,
          '/run/salaam-net/relay.sock',
          String(COMMAND_NETWORK_PORT),
        ]
      : []),
    ...argv,
  ];
}

function brokerPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new ServiceError('invalid_field', 'A broker relay port is 1–65535');
  return port;
}

/** The pinned Seatbelt launcher, or null when this host cannot apply a deny-by-default profile. */
export function findSeatbelt(path = '/usr/bin/sandbox-exec'): Seatbelt | null {
  if (!existsSync(path)) return null;
  try {
    // Usable means it applies a deny-by-default profile and the command still runs.
    execFileSync(
      path,
      [
        '-p',
        '(version 1)(deny default)(allow process-exec process-fork)(allow file-read*)(allow sysctl-read)',
        '/usr/bin/true',
      ],
      { timeout: 5000, stdio: 'ignore' },
    );
    const dev = developerDir();
    return dev ? { path, developerDir: dev } : { path };
  } catch {
    return null;
  }
}

/** A path Seatbelt can quote: absolute, with no quote, backslash or control character. */
function sbplPath(path: string, what: string): string {
  if (!isAbsolute(path) || /["\\\x00-\x1f\x7f]/.test(path))
    throw new ServiceError('invalid_field', `A sandboxed command needs a plain absolute ${what}`);
  return `"${path}"`;
}

/**
 * The deny-by-default Seatbelt profile for a level. Reads: the system, developer tools and
 * package prefixes, the workspace and the private tmp (file metadata anywhere, so paths resolve).
 * Writes: the workspace (workspace-write only), the private tmp and the standard devices. No
 * network unless declared, no mach services, no home directory.
 */
export function seatbeltProfile(
  level: 'read-only' | 'workspace-write',
  root: string,
  tmp: string,
  /** brokerPort: the host relay's loopback port, the only place a broker-network command may connect.
   * readPaths: operator-allowed read-only paths outside the workspace. developerDir: the active
   * developer dir, when it lies outside the system paths below. */
  options: {
    network: boolean;
    brokerPort?: number;
    readPaths?: readonly string[];
    developerDir?: string;
    /** A command the person approved to listen (operator ruling 2026-11-01, option C). Seatbelt
     * cannot limit this to loopback: "localhost" in its filters matches every local address. */
    listen?: boolean;
  },
): string {
  const w = sbplPath(root, 'workspace path'),
    t = sbplPath(tmp, 'tmp path');
  const extra = [
    ...(options.readPaths ?? []),
    ...(options.developerDir ? [options.developerDir] : []),
  ]
    .map((p) => `(subpath ${sbplPath(p, 'read path')})`)
    .join(' ');
  const system = [
    '/usr',
    '/bin',
    '/sbin',
    '/System',
    '/Library/Apple',
    '/Library/Developer/CommandLineTools',
    '/Applications/Xcode.app',
    '/opt/homebrew',
    '/usr/local',
    '/private/etc',
    '/private/var/db/dyld',
    '/private/var/db/timezone',
    '/dev',
  ]
    .map((p) => `(subpath "${p}")`)
    .join(' ');
  const devices = ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty']
    .map((p) => `(literal "${p}")`)
    .join(' ');
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${system} (subpath ${w}) (subpath ${t})${extra ? ' ' + extra : ''})`,
    level === 'workspace-write'
      ? `(allow file-write* (subpath ${w}) (subpath ${t}) ${devices} (regex #"^/dev/fd/"))`
      : `(allow file-write* (subpath ${t}) ${devices} (regex #"^/dev/fd/"))`,
    // The repository's control files stay read-only in a writable workspace.
    ...(level === 'workspace-write' ? seatbeltGitControl(root) : []),
    `(allow file-ioctl ${devices} (regex #"^/dev/fd/"))`,
    ...(options.network ? ['(allow network*)'] : []),
    ...(options.listen && level === 'workspace-write' && !options.network
      ? [
          '(allow network-bind (local ip "localhost:*"))',
          '(allow network-inbound (local ip "localhost:*"))',
        ]
      : []),
    ...(options.brokerPort !== undefined && !options.network
      ? [`(allow network-outbound (remote tcp "localhost:${brokerPort(options.brokerPort)}"))`]
      : []),
  ].join('\n');
}

export function seatbeltArgv(
  level: SandboxLevel,
  root: string,
  tmp: string,
  argv: string[],
  seatbelt: Seatbelt | null,
  options: {
    network: boolean;
    brokerPort?: number;
    readPaths?: readonly string[];
    listen?: boolean;
  },
): string[] {
  if (level === 'full-access') return argv;
  if (!seatbelt)
    throw new ServiceError(
      'sandbox_unavailable',
      'This host has no usable Seatbelt, so it cannot run a sandboxed command; an operator can choose full access explicitly',
    );
  const dev = seatbelt.developerDir;
  // git reads ~/.gitconfig and fails hard when it may not; without the operator allowing it, the
  // command runs with no global git config rather than an error.
  const gitConfig = join(homedir(), '.gitconfig');
  const gitConfigAllowed = (options.readPaths ?? []).some((p) => within(gitConfig, p));
  return [
    seatbelt.path,
    '-p',
    seatbeltProfile(level, root, tmp, { ...options, ...(dev ? { developerDir: dev } : {}) }),
    '/usr/bin/env',
    `TMPDIR=${tmp}/`,
    ...(dev
      ? [`PATH=${join(dev, 'usr/bin')}:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`]
      : []),
    ...(gitConfigAllowed ? [] : ['GIT_CONFIG_GLOBAL=/dev/null']),
    ...argv,
  ];
}

/** The sandbox this host gives local commands: bubblewrap on Linux and Seatbelt on macOS when
 * usable, otherwise none. */
export function chooseLocalSandbox(
  level: SandboxLevel,
  platform: NodeJS.Platform = process.platform,
  find: () => Bwrap | null = findBwrap,
  findSb: () => Seatbelt | null = findSeatbelt,
): { kind: SandboxKind; level: SandboxLevel; bwrap: Bwrap | null; seatbelt: Seatbelt | null } {
  const none = { kind: 'none' as const, level, bwrap: null, seatbelt: null };
  if (level === 'full-access') return none;
  if (platform === 'linux') {
    const bwrap = find();
    return bwrap ? { ...none, kind: 'bwrap', bwrap } : none;
  }
  if (platform === 'darwin') {
    const seatbelt = findSb();
    return seatbelt ? { ...none, kind: 'seatbelt', seatbelt } : none;
  }
  return none;
}
/** How host plan and approvals name a sandbox kind. */
export function sandboxLabel(kind: SandboxKind): string {
  return kind === 'bwrap' ? 'bubblewrap' : kind === 'seatbelt' ? 'seatbelt' : 'unsandboxed';
}
/** The refusal for a local command on a host with no usable sandbox and no operator opt-in. */
export const UNSANDBOXED_REFUSAL =
  'Local commands are refused: this host has no usable command sandbox (bubblewrap on Linux, Seatbelt on macOS). Install or repair bubblewrap, or have the operator set unsandboxed_commands: "allow" in the host config to run them unsandboxed.';
