import { test, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chooseLocalSandbox, sandboxArgv, seatbeltArgv } from '../../src/command-sandbox.js';
import { gitIdentityEnv } from '../../src/git-helpers.js';

// Phase 1 proof (operator, 2026-10-31): on this host's own sandbox, git works inside the
// workspace and a toolchain outside it is readable only when the operator allowed it. Every host
// runs a real assertion; a host with no usable sandbox proves nothing here because its commands
// are refused (item 10), and says so.
const chosen = chooseLocalSandbox('workspace-write');
function run(root: string, script: string, readPaths: string[] = []) {
  const tmp = realpathSync(mkdtempSync('/tmp/sal-usable-tmp-'));
  try {
    const argv =
      chosen.kind === 'seatbelt'
        ? seatbeltArgv('workspace-write', root, tmp, ['/bin/sh', '-c', script], chosen.seatbelt, {
            network: false,
            readPaths,
          })
        : sandboxArgv('workspace-write', root, ['/bin/sh', '-c', script], chosen.bwrap, {
            network: false,
            readPaths,
          });
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: root, encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
function repo() {
  const root = realpathSync(mkdtempSync('/tmp/sal-usable-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a]);
  git('init', '-q');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  writeFileSync(join(root, 'a.txt'), 'two\n');
  return root;
}

test('git status, diff, log and commit work inside the workspace under this host sandbox', () => {
  if (process.platform === 'darwin') expect(chosen.kind).toBe('seatbelt');
  if (chosen.kind === 'none') {
    expect(chosen.bwrap).toBeNull();
    return;
  }
  const root = repo();
  const status = run(root, 'git status --short');
  expect(status.code, status.out).toBe(0);
  expect(status.out).toContain('a.txt');
  const diff = run(root, 'git diff --stat');
  expect(diff.code, diff.out).toBe(0);
  expect(diff.out).toContain('1 insertion');
  const commit = run(
    root,
    'git -c user.name=t -c user.email=t@t commit -qam second && git log --oneline -1',
  );
  expect(commit.code, commit.out).toBe(0);
  expect(commit.out).toContain('second');
});

test('a toolchain outside the workspace is readable only when the operator allows it', () => {
  if (chosen.kind === 'none') {
    expect(chosen.seatbelt ?? null).toBeNull();
    return;
  }
  const outside = realpathSync(mkdtempSync('/tmp/sal-usable-toolchain-'));
  mkdirSync(join(outside, 'pkg'));
  writeFileSync(join(outside, 'pkg', 'index.js'), 'module.exports = 42;\n');
  const root = repo();
  symlinkSync(join(outside, 'pkg'), join(root, 'node_modules'));
  const refused = run(root, 'cat node_modules/index.js');
  expect(refused.code).not.toBe(0);
  const allowed = run(root, 'cat node_modules/index.js', [outside]);
  expect(allowed.code, allowed.out).toBe(0);
  expect(allowed.out).toContain('module.exports = 42;');
  // Read only: the allowed toolchain still cannot be written.
  const write = run(root, 'echo x > node_modules/new.js', [outside]);
  expect(write.code).not.toBe(0);
});

// Phase 4a: the sandbox cannot read ~/.gitconfig, so Salaam passes the person's own identity in.
test('a commit inside this host sandbox carries the identity from the person’s git config', () => {
  if (chosen.kind === 'none') return void expect(chosen.kind).toBe('none');
  const root = repo();
  const home = realpathSync(mkdtempSync('/tmp/sal-usable-home-'));
  try {
    writeFileSync(
      join(home, '.gitconfig'),
      '[user]\n\tname = Ada Example\n\temail = ada@example.test\n',
    );
    const env = gitIdentityEnv(root, {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(env.GIT_AUTHOR_NAME).toBe('Ada Example');
    const tmp = realpathSync(mkdtempSync('/tmp/sal-usable-tmp-'));
    const script = 'git commit -qam second && git log -1 --format="%an %ae"';
    const argv =
      chosen.kind === 'seatbelt'
        ? seatbeltArgv('workspace-write', root, tmp, ['/bin/sh', '-c', script], chosen.seatbelt, {
            network: false,
          })
        : sandboxArgv('workspace-write', root, ['/bin/sh', '-c', script], chosen.bwrap, {
            network: false,
          });
    const r = spawnSync(argv[0]!, argv.slice(1), {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...env },
    });
    rmSync(tmp, { recursive: true, force: true });
    expect(r.stdout.trim().split('\n').pop()).toBe('Ada Example ada@example.test');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
