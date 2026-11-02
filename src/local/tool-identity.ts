import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { ServiceError } from '../core/index.js';
import type { LocalEdit } from './edits.js';

/**
 * The OS identity that agent-initiated local commands and file effects run as.
 * `service-user` is the single-user default; `tools-user` switches through a
 * runas-restricted `sudo -n -u <user>` rule so the daemon needs no capability.
 */
export interface ToolIdentity {
  mode: 'service-user' | 'tools-user';
  user: string;
  uid: number;
  /** argv prefix that runs a program as the tool identity; empty for service-user. */
  prefix: string[];
  warning: string | null;
}
export const sharedUserWarning = (user: string) =>
  `Tool execution runs as ${user}, the same OS user that holds the provider credential. Set --tools-user to separate them.`;

export function serviceToolIdentity(): ToolIdentity {
  const user = userInfo().username;
  return {
    mode: 'service-user',
    user,
    uid: process.getuid?.() ?? -1,
    prefix: [],
    warning: sharedUserWarning(user),
  };
}

const run = (argv: string[], input?: string) =>
  spawnSync(argv[0]!, argv.slice(1), {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C' },
    input,
    encoding: 'utf8',
    timeout: 10000,
    killSignal: 'SIGKILL',
    maxBuffer: 1 << 20,
  });

/** Fail closed unless the tools user exists, is reachable without a password, and cannot read state. */
export function probeToolsUser(
  user: string,
  stateDir: string,
  prefix = ['sudo', '-n', '-u', user, '--'],
): ToolIdentity {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user))
    throw new Error('--tools-user must be a plain Unix user name');
  if (process.platform !== 'linux' && prefix[0] === 'sudo')
    throw new Error('--tools-user is supported on Linux hosts only');
  const id = run([...prefix, '/usr/bin/id', '-u']);
  const uid = Number(String(id.stdout).trim());
  if (id.status !== 0 || !Number.isSafeInteger(uid))
    throw new Error(
      `Cannot run as tools user ${user} (sudo -n -u ${user} failed); see docs/security.md host setup`,
    );
  if (uid === 0 || uid === process.getuid?.())
    throw new Error('The tools user must be an unprivileged user distinct from the service user');
  if (run([...prefix, '/usr/bin/test', '-r', stateDir]).status === 0)
    throw new Error(`Tools user ${user} can read the Salaam state directory; restrict it to 0700`);
  return { mode: 'tools-user', user, uid, prefix, warning: null };
}

export function toolArgv(identity: ToolIdentity, argv: string[]): string[] {
  return [...identity.prefix, ...argv];
}

/** Kill a tool process group owned by the tools user; the daemon cannot signal another uid. */
export function killToolGroup(identity: ToolIdentity, pgid: number): void {
  if (identity.mode !== 'tools-user' || !Number.isSafeInteger(pgid) || pgid < 2) return;
  run(toolArgv(identity, ['/bin/kill', '-KILL', '--', '-' + pgid]));
}

const here = fileURLToPath(import.meta.url);
/** Source runs (tests) use the built helper; packages ship it beside this file. */
export const EDIT_HELPER = here.endsWith('.ts')
  ? join(dirname(here), '..', '..', 'dist/src/local/edit-helper.js')
  : join(dirname(here), '..', 'local', 'edit-helper.js');

export interface ToolEdit extends LocalEdit {
  remove?: boolean;
}
/** Apply reviewed edits as the tools user. Reports each applied path; any failure throws. */
export function applyEditsAsTools(
  identity: ToolIdentity,
  root: string,
  edits: ToolEdit[],
  applied: (path: string) => void,
): void {
  if (!existsSync(EDIT_HELPER)) throw new ServiceError('tool_identity', 'Edit helper is missing');
  const result = run(
    toolArgv(identity, [process.execPath, EDIT_HELPER, root]),
    JSON.stringify(edits),
  );
  for (const line of String(result.stdout ?? '').split('\n')) {
    if (line.startsWith('applied ')) applied(JSON.parse(line.slice(8)) as string);
  }
  if (result.status !== 0)
    throw new ServiceError(
      'tool_identity',
      `Edit as ${identity.user} failed: ${String(result.stderr ?? '')
        .trim()
        .slice(0, 400)}`,
    );
}
