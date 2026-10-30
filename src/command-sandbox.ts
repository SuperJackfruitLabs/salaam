import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ServiceError } from './protocol.js';

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
}
export type SandboxKind = 'bwrap' | 'seatbelt' | 'none';

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

export function sandboxArgv(
  level: SandboxLevel,
  root: string,
  argv: string[],
  bwrap: Bwrap | null,
  options: { network: boolean },
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
    level === 'read-only' ? '--ro-bind' : '--bind',
    root,
    root,
    // The empty root itself is read-only too: only the workspace (and the private /tmp) is writable.
    '--remount-ro',
    '/',
    '--chdir',
    root,
    '--',
    ...argv,
  ];
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
    return { path };
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
  options: { network: boolean },
): string {
  const w = sbplPath(root, 'workspace path'),
    t = sbplPath(tmp, 'tmp path');
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
    `(allow file-read* (literal "/") ${system} (subpath ${w}) (subpath ${t}))`,
    level === 'workspace-write'
      ? `(allow file-write* (subpath ${w}) (subpath ${t}) ${devices} (regex #"^/dev/fd/"))`
      : `(allow file-write* (subpath ${t}) ${devices} (regex #"^/dev/fd/"))`,
    `(allow file-ioctl ${devices} (regex #"^/dev/fd/"))`,
    ...(options.network ? ['(allow network*)'] : []),
  ].join('\n');
}

export function seatbeltArgv(
  level: SandboxLevel,
  root: string,
  tmp: string,
  argv: string[],
  seatbelt: Seatbelt | null,
  options: { network: boolean },
): string[] {
  if (level === 'full-access') return argv;
  if (!seatbelt)
    throw new ServiceError(
      'sandbox_unavailable',
      'This host has no usable Seatbelt, so it cannot run a sandboxed command; an operator can choose full access explicitly',
    );
  return [
    seatbelt.path,
    '-p',
    seatbeltProfile(level, root, tmp, options),
    '/usr/bin/env',
    `TMPDIR=${tmp}/`,
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
