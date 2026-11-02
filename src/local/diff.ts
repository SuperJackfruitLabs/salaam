import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
/** Read-only Git views: disable repository diff drivers, textconv and fsmonitor execution. */
export async function localDiff(cwd: string): Promise<string> {
  const git = async (args: string[]) =>
    (
      await exec('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], {
        cwd,
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1' },
      })
    ).stdout;
  const options = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const [unstaged, staged, untracked] = await Promise.all([
    git(['diff', ...options]),
    git(['diff', '--cached', ...options]),
    git(['ls-files', '--others', '--exclude-standard']),
  ]);
  return `Unstaged changes\n${unstaged || '(none)'}\nStaged changes\n${staged || '(none)'}\nUntracked paths (contents not included)\n${untracked || '(none)'}`;
}
