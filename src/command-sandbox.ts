import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { ServiceError } from './protocol.js';

/**
 * Item 10: the sandbox a local command runs in. `workspace-write` (the default) and `read-only` run
 * the command under bubblewrap: an empty root, the system read-only, a private /tmp, the workspace
 * bound read-write or read-only, no network unless declared, and user, PID, IPC, UTS and network
 * namespaces unshared, dying with its parent. `full-access` runs it as is and must be chosen
 * explicitly by the operator. A host without a usable bubblewrap refuses the sandboxed levels; it
 * never falls back silently.
 */
export const SANDBOX_LEVELS = ['read-only', 'workspace-write', 'full-access'] as const;
export type SandboxLevel = (typeof SANDBOX_LEVELS)[number];
export interface Bwrap {
  path: string;
  version: string;
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
