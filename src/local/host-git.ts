// Every git command Salaam itself runs on the host, outside the command sandbox, goes through here.
// A sandboxed command may write the workspace, and the workspace may hold the repository's own
// config (`.git/config`, a file it includes, a `.git` file that points somewhere else, or a
// repository the command created). Git runs programs named in config, so a host-side git call
// that trusted that config would run whatever a sandboxed command put there, outside the sandbox.
import { execFile, execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Config set on the command line, which beats every config file and include, so whatever the
 * repository's config says about these keys is ignored:
 * - core.fsmonitor: a program git runs to list changed files (ls-files, status, diff);
 * - core.hooksPath: a missing directory, so no hook runs (post-index-change runs on index writes);
 * - diff.external: an external diff program (also turned off with --no-ext-diff);
 * - core.pager: as well as --no-pager, in case a subcommand pages anyway;
 * - protocol.allow=never: no transport at all, so core.sshCommand, ext:: and remote helpers never
 *   start (the calls here are local and need none);
 * - credential.helper: empty resets the list, so no helper runs;
 * - gc.auto, maintenance.auto: no automatic maintenance (which runs hooks and child gits).
 * Content filters (clean/smudge/process) and textconv drivers have names chosen by attributes, so
 * they cannot be listed here: a host call that reads worktree content must not run here at all
 * (see localDiff, which runs inside the session's sandbox) and diffs pass HOST_GIT_DIFF_OPTIONS.
 * Child gits (submodule status) inherit these through GIT_CONFIG_PARAMETERS.
 */
export const HOST_GIT_CONFIG: readonly string[] = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'diff.external=',
  'core.pager=cat',
  'protocol.allow=never',
  'credential.helper=',
  'gc.auto=0',
  'maintenance.auto=false',
];
/** Options every host-side diff passes: no external diff driver and no textconv program. */
export const HOST_GIT_DIFF_OPTIONS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

/** git's argv: the overrides first, then the caller's subcommand. */
export function hostGitArgs(args: readonly string[]): string[] {
  return ['--no-pager', ...HOST_GIT_CONFIG.flatMap((c) => ['-c', c]), ...args];
}

/** Which global and system config files git reads: the service's own choice, outside the
 * workspace, so they are kept. */
const KEPT = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']);
/** The environment: the caller's, with every other GIT_* variable removed (GIT_DIR,
 * GIT_EXTERNAL_DIFF, GIT_PAGER, GIT_SSH_COMMAND, GIT_CONFIG_PARAMETERS, GIT_CONFIG_COUNT), then `git`
 * (the caller's own GIT_* settings) and the hardening: no prompts and no optional index writes. */
export function hostGitEnv(
  git: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base))
    if ((!key.startsWith('GIT_') || KEPT.has(key)) && value !== undefined) env[key] = value;
  for (const [key, value] of Object.entries(git)) if (value !== undefined) env[key] = value;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

export interface HostGitOptions {
  cwd: string;
  /** GIT_* settings of the caller's own (GIT_DIR for a private repository, say). */
  gitEnv?: Record<string, string | undefined>;
  /** The environment to start from; GIT_* variables in it are dropped. */
  baseEnv?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  maxBuffer?: number;
  stdio?: ExecFileSyncOptions['stdio'];
}

function spawnOptions(o: HostGitOptions) {
  return {
    cwd: o.cwd,
    env: hostGitEnv(o.gitEnv, o.baseEnv),
    ...(o.input !== undefined ? { input: o.input } : {}),
    ...(o.timeout !== undefined ? { timeout: o.timeout } : {}),
    ...(o.maxBuffer !== undefined ? { maxBuffer: o.maxBuffer } : {}),
  };
}

/** Run git on the host, hardened; returns stdout. Throws as execFileSync does. */
export function hostGitSync(args: readonly string[], o: HostGitOptions): Buffer {
  return execFileSync('git', hostGitArgs(args), {
    ...spawnOptions(o),
    stdio: o.stdio ?? ['ignore', 'pipe', 'ignore'],
  });
}
/** hostGitSync, as text. */
export function hostGitText(args: readonly string[], o: HostGitOptions): string {
  return hostGitSync(args, o).toString('utf8');
}

const exec = promisify(execFile);
/** Run git on the host, hardened, without blocking; resolves to stdout. */
export async function hostGit(args: readonly string[], o: HostGitOptions): Promise<string> {
  return (await exec('git', hostGitArgs(args), { ...spawnOptions(o), encoding: 'utf8' })).stdout;
}
