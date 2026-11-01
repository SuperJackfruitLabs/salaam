import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { SalaamApp } from '../../src/tui.js';
import type { SessionSnapshot } from '../../src/protocol.js';

// Phase 4a: /commit, /branch and /pr become instructions to the model; git runs only through the
// session's own command approvals. /diff opens the per-file review in coding sessions.
const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolated } });
function repo(branch = 'main'): string {
  const root = mkdtempSync(join(tmpdir(), 'salaam-tui-git-'));
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'one');
  git(root, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  if (branch !== 'main') git(root, 'switch', '-q', '-c', branch);
  return root;
}
function app(cwd: string, capabilities = ['local-coding-reviewed', 'local-workspace-read']) {
  const a = new SalaamApp({ state: mkdtempSync(join(tmpdir(), 'salaam-tui-git-state-')) });
  a.client.snapshot = {
    id: 'ses_git',
    cwd,
    capabilities,
    submissions: [],
    attempts: [],
    messages: [],
    approvals: [],
    operations: [],
    children: [],
  } as unknown as SessionSnapshot;
  const sent: string[] = [];
  a.client.submit = async (text: string) => {
    sent.push(text);
    return 'sub';
  };
  const run = (command: string, args = '') =>
    (a as unknown as { runSlashCommand(c: string, a?: string): Promise<void> }).runSlashCommand(
      command,
      args,
    );
  return { a, sent, run };
}

test('/commit sends the commit instruction for this session', async () => {
  const { sent, run } = app(repo());
  await run('commit');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('Commit the current work');
  expect(sent[0]).toMatch(/--no-verify/);
});

test('/branch refuses a name a shell would read specially, before anything is sent', async () => {
  const { sent, run } = app(repo());
  await expect(run('branch', 'x;rm -rf ~')).rejects.toThrow(/branch name/);
  await expect(run('branch')).rejects.toThrow(/Usage/);
  await run('branch', 'feat/x');
  expect(sent).toEqual([expect.stringContaining('git switch -c feat/x')]);
});

test('/pr refuses on the base branch and names the branches otherwise', async () => {
  const onMain = app(repo());
  await expect(onMain.run('pr')).rejects.toThrow(/You are on main/);
  expect(onMain.sent).toHaveLength(0);
  const feature = app(repo('feat/x'));
  try {
    await feature.run('pr');
    expect(feature.sent[0]).toContain('feat/x into main');
  } catch (error) {
    // A machine without gh cannot open a GitHub pull request; that is said, not guessed around.
    expect(String(error)).toMatch(/gh or tea/);
  }
  await expect(feature.run('pr', 'main;id')).rejects.toThrow(/not a valid branch name/);
});

test('git commands need a coding session', async () => {
  const { run, sent } = app(repo(), ['local-workspace-read']);
  for (const c of ['commit', 'pr']) await expect(run(c)).rejects.toThrow(/coding session/);
  expect(sent).toHaveLength(0);
});

test('/diff opens the per-file review in a coding session', async () => {
  const { a, run } = app(repo());
  await run('diff');
  expect(a.view.tab).toBe('changes');
});
