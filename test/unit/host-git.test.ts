import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { listWorkspaceFiles } from '../../src/runtime/mentions.js';
import {
  currentBranch,
  defaultBase,
  forgeTool,
  gitIdentityEnv,
} from '../../src/local/git-helpers.js';
import { localDiff } from '../../src/local/diff.js';
import { hostGitArgs, hostGitEnv, HOST_GIT_CONFIG } from '../../src/local/host-git.js';
import { ShadowCheckpoints } from '../../src/runtime/turn-checkpoints.js';

// A sandboxed command can write the workspace, .git included unless the sandbox protects it, and
// can create a repository where there was none. Every git call Salaam makes on the host, outside
// the sandbox, must run nothing that config names. Each case below is config a sandboxed command
// could have written; the program it names drops a marker file outside the workspace.

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolated } });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sal-hostgit-')));
  made.push(base);
  const root = join(base, 'work'),
    marks = join(base, 'marks');
  mkdirSync(marks);
  git(base, 'init', '-q', '--bare', join(base, 'remote.git'));
  git(base, 'init', '-q', '-b', 'main', root);
  git(root, 'remote', 'add', 'origin', join(base, 'remote.git'));
  writeFileSync(join(root, 'a.txt'), 'one\n');
  writeFileSync(join(root, '.gitattributes'), '*.txt filter=evil diff=evil\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  // The program a malicious config names: records that it ran, and passes content through.
  const evil = join(base, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\ntouch '${marks}'/"$1"\n[ "$1" = clean ] && exec cat\nexit 0\n`);
  chmodSync(evil, 0o755);
  // A stat-dirty worktree, so git looks at file content (and asks fsmonitor) when it can.
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  return { base, root, marks, evil };
}
const ran = (marks: string) => readdirSync(marks).toSorted();
const hookDir = (base: string, evil: string) => {
  const dir = join(base, 'hooks');
  mkdirSync(dir, { recursive: true });
  for (const name of ['post-index-change', 'pre-auto-gc', 'post-checkout', 'reference-transaction'])
    writeFileSync(join(dir, name), `#!/bin/sh\nexec '${evil}' hook-${name}\n`, { mode: 0o755 });
  return dir;
};
/** Every git call Salaam makes on the host, as the user would trigger them. */
async function everyHostCall(root: string, stateDir: string) {
  listWorkspaceFiles(root); // typing @ in the composer
  gitIdentityEnv(root); // before every sandboxed command
  currentBranch(root); // /pr
  defaultBase(root);
  forgeTool(root);
  await localDiff(root); // the diff view, when the session is not sandboxed
  const shadow = new ShadowCheckpoints(stateDir, root); // turn checkpoints
  shadow.capture();
}

describe('host-side git runs nothing a sandboxed command configured', () => {
  test('core.fsmonitor in .git/config (the reported escape)', async () => {
    const f = fixture();
    git(f.root, 'config', 'core.fsmonitor', `${f.evil} fsmonitor`);
    await everyHostCall(f.root, join(f.base, 'state'));
    expect(ran(f.marks)).toEqual([]);
  });

  test('core.fsmonitor and hooks reached through include.path to a workspace file', async () => {
    const f = fixture();
    writeFileSync(
      join(f.root, 'innocent.cfg'),
      `[core]\n\tfsmonitor = ${f.evil} fsmonitor\n\thooksPath = ${hookDir(f.base, f.evil)}\n` +
        `[diff]\n\texternal = ${f.evil} external\n`,
    );
    git(f.root, 'config', 'include.path', join(f.root, 'innocent.cfg'));
    await everyHostCall(f.root, join(f.base, 'state'));
    expect(ran(f.marks)).toEqual([]);
  });

  test('a .git file pointing at a git dir the command wrote', async () => {
    const f = fixture();
    // The real .git moves into the workspace under another name and .git becomes a pointer.
    renameSync(join(f.root, '.git'), join(f.root, 'elsewhere'));
    writeFileSync(join(f.root, '.git'), 'gitdir: elsewhere\n');
    git(f.root, 'config', 'core.fsmonitor', `${f.evil} fsmonitor`);
    expect(readFileSync(join(f.root, 'elsewhere', 'config'), 'utf8')).toContain('fsmonitor');
    await everyHostCall(f.root, join(f.base, 'state'));
    expect(ran(f.marks)).toEqual([]);
  });

  test('a repository the command created where there was none', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'sal-hostgit-')));
    made.push(base);
    const root = join(base, 'work'),
      marks = join(base, 'marks');
    mkdirSync(root);
    mkdirSync(marks);
    const evil = join(base, 'evil.sh');
    writeFileSync(evil, `#!/bin/sh\ntouch '${marks}'/"$1"\nexit 0\n`, { mode: 0o755 });
    writeFileSync(join(root, 'a.txt'), 'x\n');
    git(root, 'init', '-q');
    git(root, 'config', 'core.fsmonitor', `${evil} fsmonitor`);
    git(root, 'config', 'core.hooksPath', hookDir(base, evil));
    await everyHostCall(root, join(base, 'state'));
    expect(ran(marks)).toEqual([]);
  });

  test('the diff view runs no external diff or textconv program', async () => {
    const f = fixture();
    git(f.root, 'config', 'diff.external', `${f.evil} external`);
    git(f.root, 'config', 'diff.evil.textconv', `${f.evil} textconv`);
    git(f.root, 'config', 'diff.evil.command', `${f.evil} command`);
    const text = await localDiff(f.root);
    expect(text).toContain('+two');
    expect(ran(f.marks)).toEqual([]);
  });

  test('git variables in the service environment do not reach host git', () => {
    const env = hostGitEnv(
      { GIT_DIR: '/x' },
      {
        PATH: '/usr/bin',
        GIT_EXTERNAL_DIFF: 'evil',
        GIT_PAGER: 'evil',
        GIT_SSH_COMMAND: 'evil',
        GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='evil'",
        GIT_CONFIG_COUNT: '1',
        GIT_DIR: '/elsewhere',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    );
    expect(
      Object.keys(env)
        .filter((k) => k.startsWith('GIT_'))
        .toSorted(),
    ).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']);
    expect(env.GIT_DIR).toBe('/x');
    expect(env.PATH).toBe('/usr/bin');
    const args = hostGitArgs(['status']);
    expect(args.slice(-1)).toEqual(['status']);
    expect(args[0]).toBe('--no-pager');
    for (const c of HOST_GIT_CONFIG) expect(args).toContain(c);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  );
}
/** Source files that start git without the helper. Every git spawn in src/ goes through
 * src/local/host-git.ts, so a future call cannot forget the hardening. */
test('no file in src/ spawns git except the host-git helper', () => {
  const src = join(import.meta.dirname, '../../src');
  const spawnsGit = /\b(execFileSync|execFile|exec|spawn|spawnSync|execSync|run)\(\s*['"`]git['"`]/;
  const offenders = sourceFiles(src)
    .filter((f) => !f.endsWith(join('local', 'host-git.ts')))
    .filter((f) => spawnsGit.test(readFileSync(f, 'utf8')))
    .map((f) => relative(src, f));
  expect(offenders).toEqual([]);
  expect(existsSync(join(src, 'local', 'host-git.ts'))).toBe(true);
});
