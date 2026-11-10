// A read-only git command Salaam runs for itself inside the host's command sandbox: the diff view.
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  COMMAND_PATH,
  privateTmp,
  readOnlySandboxArgv,
  type LocalSandbox,
} from './command-launch.js';
import { hostGitArgs, hostGitEnv } from './host-git.js';

const exec = promisify(execFile);

/** A linked worktree's `.git` file points to a git dir outside the workspace (and that to its
 * common dir); git inside the sandbox reads them, read-only. */
export function gitDirsOutside(root: string): string[] {
  const out: string[] = [];
  try {
    const real = realpathSync(root);
    const text = readFileSync(resolve(real, '.git'), 'utf8').trim();
    if (!text.startsWith('gitdir:')) return [];
    const dir = realpathSync(resolve(real, text.slice('gitdir:'.length).trim()));
    const add = (p: string) => {
      if (p !== real && !p.startsWith(real + sep) && !out.includes(p)) out.push(p);
    };
    add(dir);
    try {
      add(realpathSync(resolve(dir, readFileSync(resolve(dir, 'commondir'), 'utf8').trim())));
    } catch {
      /* no common dir: a submodule's or a plain separate git dir */
    }
  } catch {
    /* .git is a folder, or absent */
  }
  return out;
}

/** Runs `git <args>` in `root` under `sb` (read-only), hardened as a host call would be, and
 * resolves to its stdout. Anything git starts (a clean filter, say) is confined like a sandboxed
 * command: no network, no writes, nothing of the home folder. */
export async function readInSandbox(
  sb: LocalSandbox,
  root: string,
  args: string[],
): Promise<string> {
  const tmp = privateTmp(sb, 'salaam-read-');
  try {
    const readable = { ...sb, readPaths: [...(sb.readPaths ?? []), ...gitDirsOutside(root)] };
    const argv = readOnlySandboxArgv(readable, root, ['git', ...hostGitArgs(args)], tmp);
    const env = hostGitEnv(
      {},
      { PATH: COMMAND_PATH, HOME: process.env.HOME ?? root, LANG: 'C', TMPDIR: '/tmp' },
    );
    const [file = 'git', ...rest] = argv;
    const { stdout } = await exec(file, rest, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
