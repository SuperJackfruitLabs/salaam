import { hostGit, HOST_GIT_DIFF_OPTIONS } from './host-git.js';

/** Runs one read-only git command in the workspace and resolves to its stdout. */
export type GitReader = (args: string[]) => Promise<string>;

/** Git on the host, hardened (host-git.ts). Content filters named by attributes can still run here,
 * so a sandboxed session reads its diff through LocalCoding.diff instead, inside its sandbox. */
export const hostGitReader =
  (cwd: string): GitReader =>
  (args) =>
    hostGit(args, {
      cwd,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      gitEnv: { GIT_CONFIG_NOSYSTEM: '1' },
    });

/** Read-only Git views: no external diff, textconv, fsmonitor, hooks or pager. */
export async function localDiff(cwd: string, git: GitReader = hostGitReader(cwd)): Promise<string> {
  const options = [...HOST_GIT_DIFF_OPTIONS, '--no-color'];
  const [unstaged, staged, untracked] = await Promise.all([
    git(['diff', ...options]),
    git(['diff', '--cached', ...options]),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  return `Unstaged changes\n${unstaged || '(none)'}\nStaged changes\n${staged || '(none)'}\nUntracked paths (contents not included)\n${untracked || '(none)'}`;
}
