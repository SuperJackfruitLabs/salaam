import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { autoApprovesCommands } from '../../src/runtime/autonomy.js';
import {
  branchInstruction,
  commitInstruction,
  gitIdentityEnv,
  loadGitPrefs,
  prInstruction,
  publishesToRemote,
  validBranchName,
} from '../../src/local/git-helpers.js';

const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolated } });
function repo(): string {
  const base = mkdtempSync(join(tmpdir(), 'salaam-git-'));
  const root = join(base, 'work');
  git(base, 'init', '-q', '--bare', join(base, 'remote.git'));
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'remote', 'add', 'origin', join(base, 'remote.git'));
  return root;
}
const prefsFile = (value: unknown) => {
  const file = join(mkdtempSync(join(tmpdir(), 'salaam-prefs-')), 'git.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
};

describe('publishesToRemote', () => {
  it.each([
    'git push',
    'git push -u origin feat/x',
    'git -C . push origin main',
    'git add -A && git commit -m x && git push',
    'cd sub; git push origin HEAD',
    'git push $(git remote)',
    'gh pr create --title t --body b',
    'tea pr create --title t',
    'tea pulls create --title t',
    '/usr/bin/git push',
    'env A=1 git push',
    'sh -c "git push"',
  ])('%s always asks', (command) => {
    expect(publishesToRemote(command)).toMatch(/remote|pull request/);
  });
  it.each([
    'git status',
    'git log --oneline',
    'npm test',
    'gh pr view 12',
    'gh pr list',
    'echo git',
  ])('%s does not', (command) => {
    expect(publishesToRemote(command)).toBeNull();
  });
});

describe('push and PR creation ask in every mode but YOLO', () => {
  const policy = (mode: string, access?: string) => ({ mode, access, revision: 1 }) as never;
  it('auto with a sandbox asks for a publishing command', () => {
    expect(autoApprovesCommands(policy('auto'), true, false, true)).toBe(false);
    expect(autoApprovesCommands(policy('auto'), true, false, false)).toBe(true);
  });
  it('full access asks for a publishing command', () => {
    expect(autoApprovesCommands(policy('auto', 'full'), false, false, true)).toBe(false);
  });
  it('YOLO still approves it', () => {
    expect(autoApprovesCommands(policy('auto', 'yolo'), false, false, true)).toBe(true);
  });
});

describe('gitIdentityEnv', () => {
  it('reads the identity from git config, including the repo', () => {
    const root = repo();
    git(root, 'config', 'user.name', 'Ada Example');
    git(root, 'config', 'user.email', 'ada@example.test');
    expect(gitIdentityEnv(root, { ...process.env, ...isolated })).toEqual({
      GIT_AUTHOR_NAME: 'Ada Example',
      GIT_AUTHOR_EMAIL: 'ada@example.test',
      GIT_COMMITTER_NAME: 'Ada Example',
      GIT_COMMITTER_EMAIL: 'ada@example.test',
    });
  });
  it('never invents one', () => {
    expect(gitIdentityEnv(repo(), { ...process.env, ...isolated })).toEqual({});
  });
  it('gives nothing when only half is configured', () => {
    const root = repo();
    git(root, 'config', 'user.name', 'Ada Example');
    expect(gitIdentityEnv(root, { ...process.env, ...isolated })).toEqual({});
  });
  it('lets a commit with no readable git config carry the real author', () => {
    const root = repo();
    git(root, 'config', 'user.name', 'Ada Example');
    git(root, 'config', 'user.email', 'ada@example.test');
    const env = gitIdentityEnv(root, { ...process.env, ...isolated });
    git(root, 'config', '--unset', 'user.name');
    git(root, 'config', '--unset', 'user.email');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    git(root, 'add', 'a.txt');
    execFileSync('git', ['commit', '-q', '-m', 'first'], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root, ...isolated, ...env },
    });
    expect(git(root, 'log', '-1', '--format=%an %ae').trim()).toBe('Ada Example ada@example.test');
  });
});

describe('validBranchName', () => {
  it.each(['feat/x', 'fix-1', 'a.b'])('%s is valid', (n) => expect(validBranchName(n)).toBe(true));
  it.each(['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', 'a//b', '@', 'a;rm', '$(id)', 'a/', '.x'])(
    '%s is not',
    (n) => expect(validBranchName(n)).toBe(false),
  );
});

describe('loadGitPrefs', () => {
  it('reads trailers and the session trailer flag', () => {
    const file = prefsFile({ trailers: ['Reviewed-by: Me <me@x>'], session_trailer: true });
    expect(loadGitPrefs(file)).toEqual({
      trailers: ['Reviewed-by: Me <me@x>'],
      sessionTrailer: true,
    });
  });
  it('defaults to no trailers when absent', () => {
    expect(loadGitPrefs('/nonexistent/salaam/git.json')).toEqual({
      trailers: [],
      sessionTrailer: false,
    });
  });
  it('drops malformed trailers', () => {
    const file = prefsFile({ trailers: ['no colon', 'X: ok\nInjected: y', 7, 'Ok-Key: v'] });
    expect(loadGitPrefs(file).trailers).toEqual(['Ok-Key: v']);
  });
});

describe('instructions', () => {
  it('/commit names the trailers and forbids amend, hooks and config', () => {
    const text = commitInstruction({
      trailers: ['Reviewed-by: Me <me@x>'],
      session: 'ses_1',
      sessionTrailer: true,
    });
    expect(text).toContain('Reviewed-by: Me <me@x>');
    expect(text).toContain('Salaam-Session: ses_1');
    expect(text).toMatch(/never.*--amend/i);
    expect(text).toMatch(/--no-verify/);
    expect(text).toMatch(/git config/);
  });
  it('/commit without a session trailer leaves it out', () => {
    expect(
      commitInstruction({ trailers: [], session: 'ses_1', sessionTrailer: false }),
    ).not.toContain('Salaam-Session');
  });
  it('/branch refuses an invalid name', () => {
    expect(() => branchInstruction('a;rm -rf ~')).toThrow(/branch name/);
    expect(branchInstruction('feat/x')).toContain('git switch feat/x');
  });
  it('/pr picks the forge tool, and never forces', () => {
    expect(prInstruction({ tool: 'gh', branch: 'feat/x', base: 'main' })).toContain('gh pr create');
    expect(prInstruction({ tool: 'tea', branch: 'feat/x', base: 'main' })).toContain(
      'tea pr create',
    );
    expect(prInstruction({ tool: 'gh', branch: 'feat/x', base: 'main' })).toMatch(
      /never.*--force/i,
    );
    expect(() => prInstruction({ tool: null, branch: 'feat/x', base: 'main' })).toThrow(
      /gh or tea/,
    );
  });
});
