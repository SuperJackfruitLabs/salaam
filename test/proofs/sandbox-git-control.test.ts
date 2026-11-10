import { describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findBwrap,
  findSeatbelt,
  sandboxArgv,
  seatbeltArgv,
} from '../../src/local/command-sandbox.js';
import type { LocalSandbox } from '../../src/local/command-launch.js';
import { LocalCoding } from '../../src/local/coding.js';
import { Store } from '../../src/store/store.js';
import { ManagedWork } from '../../src/execution/managed.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';

// A sandboxed command may write the workspace, but not the repository's control files: otherwise
// it could leave a core.fsmonitor, a hook or a filter that git later runs outside the sandbox, in
// Salaam's own git calls or in the person's terminal. And a git command Salaam runs on the
// workspace's content for itself (the diff view) runs inside the sandbox. Every host proves the
// sandbox it has; a host with neither is covered by the refusal proof in command-sandbox.test.ts.
const bwrap = process.platform === 'linux' ? findBwrap() : null;
const seatbelt = process.platform === 'darwin' ? findSeatbelt() : null;
const sandbox: LocalSandbox | null = bwrap
  ? { kind: 'bwrap', level: 'workspace-write', bwrap }
  : seatbelt
    ? { kind: 'seatbelt', level: 'workspace-write', bwrap: null, seatbelt }
    : null;
const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...isolated } });
const IDENTITY = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sal-gitctl-')));
  const root = join(base, 'work'),
    marks = join(base, 'marks');
  mkdirSync(marks);
  git(base, 'init', '-q', '-b', 'main', root);
  writeFileSync(join(root, 'a.txt'), 'one\n');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  // A submodule's git dir, and a repository with no hooks folder yet.
  git(root, 'init', '-q', '--bare', join(root, '.git', 'modules', 'lib'));
  rmSync(join(root, '.git', 'hooks'), { recursive: true, force: true });
  // The program a malicious config would name; it lives outside the workspace.
  const evil = join(base, 'evil.sh');
  writeFileSync(evil, `#!/bin/sh\ntouch '${marks}'/"$1"\n[ "$1" = clean ] && exec cat\nexit 0\n`);
  chmodSync(evil, 0o755);
  return { base, root, marks, evil };
}
const ran = (marks: string) => readdirSync(marks).toSorted();

/** Runs a proof under this host's sandbox. A host with none (a Linux container without bubblewrap)
 * proves only that: commands there are refused, which command-sandbox.test.ts proves. */
function proof(prove: (sb: LocalSandbox) => void | Promise<void>): () => Promise<void> {
  return async () => {
    if (sandbox) return prove(sandbox);
    expect({
      platform: process.platform === 'darwin',
      required: process.env.SALAAM_REQUIRE_BWRAP === '1',
      bwrap: findBwrap(),
    }).toEqual({ platform: false, required: false, bwrap: null });
  };
}

/** Runs a shell script as a sandboxed workspace-write command would run. */
function runSandboxed(root: string, script: string) {
  const sh = ['/bin/sh', '-c', script];
  let argv: string[];
  let tmp: string | undefined;
  if (bwrap) argv = sandboxArgv('workspace-write', root, sh, bwrap, { network: false });
  else {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sal-gitctl-t-')));
    argv = seatbeltArgv('workspace-write', root, tmp, sh, seatbelt, { network: false });
  }
  const [file = '/bin/sh', ...rest] = argv;
  const r = spawnSync(file, rest, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', ...IDENTITY },
  });
  rmSync(tmp ?? join(root, '.no-tmp'), { recursive: true, force: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

describe(`git control files inside the sandbox (${sandbox?.kind ?? 'none'})`, () => {
  test(
    'a sandboxed command cannot leave git a program to run on the host',
    proof(() => {
      const f = fixture();
      const G = join(f.root, '.git');
      const before = {
        config: readFileSync(join(G, 'config'), 'utf8'),
        lib: readFileSync(join(G, 'modules', 'lib', 'config'), 'utf8'),
        exclude: readFileSync(join(G, 'info', 'exclude'), 'utf8'),
      };
      const e = f.evil;
      const attempts = [
        `git config core.fsmonitor '${e} fsmonitor'`,
        `printf '[core]\\n\\tfsmonitor = ${e} fsmonitor\\n' >> .git/config`,
        `printf '[core]\\n\\tfsmonitor = ${e} fsmonitor\\n' > .git/config.new && mv .git/config.new .git/config`,
        `mkdir -p .git/hooks && printf '#!/bin/sh\\n${e} hook\\n' > .git/hooks/post-index-change && chmod +x .git/hooks/post-index-change`,
        `echo '* filter=evil' >> .git/info/attributes`,
        `echo 'x' >> .git/info/exclude`,
        `printf '[core]\\n\\tfsmonitor = ${e} fsmonitor-lib\\n' >> .git/modules/lib/config`,
        `mv .git .git-moved`,
        `rm -rf .git/info`,
      ];
      // The sandbox itself works here: an ordinary write in the workspace succeeds.
      expect(runSandboxed(f.root, 'echo ok > inside.txt').code).toBe(0);
      expect(readFileSync(join(f.root, 'inside.txt'), 'utf8')).toBe('ok\n');
      for (const a of attempts) {
        const r = runSandboxed(f.root, a);
        expect({ attempt: a, code: r.code }).not.toEqual({ attempt: a, code: 0 });
      }
      expect(readFileSync(join(G, 'config'), 'utf8')).toBe(before.config);
      expect(readFileSync(join(G, 'modules', 'lib', 'config'), 'utf8')).toBe(before.lib);
      expect(readFileSync(join(G, 'info', 'exclude'), 'utf8')).toBe(before.exclude);
      expect(existsSync(join(G, 'info', 'attributes'))).toBe(false);
      expect(existsSync(join(G, 'hooks', 'post-index-change'))).toBe(false);
      expect(existsSync(join(f.root, '.git-moved'))).toBe(false);
      // The person's own git afterwards, unhardened, runs nothing.
      writeFileSync(join(f.root, 'a.txt'), 'one\ntwo\n');
      git(f.root, 'status', '--porcelain');
      git(f.root, 'diff');
      expect(ran(f.marks)).toEqual([]);
    }),
  );

  test(
    'ordinary git still works inside the sandbox',
    proof(() => {
      const f = fixture();
      const r = runSandboxed(
        f.root,
        [
          'set -e',
          'echo b > b.txt',
          'git add b.txt',
          'git commit -qm b',
          'git switch -qc feature',
          'echo c > c.txt && git add c.txt && git commit -qm c',
          'git switch -q main',
          'git merge -q --no-edit feature',
          'git branch -q other',
          'git tag v1',
          'echo d >> a.txt',
          'git stash -q',
          'git stash pop -q',
          'git checkout -q -b topic',
          'git log --oneline | wc -l',
        ].join('\n'),
      );
      expect(`${r.out}\nexit ${r.code}`).toMatch(/\nexit 0$/);
      expect(r.out.trim().split('\n').pop()?.trim()).toBe('3');
      expect(git(f.root, 'branch', '--show-current').trim()).toBe('topic');
    }),
  );

  test(
    'the diff view runs a repository filter inside the sandbox, not on the host',
    proof(async (sb) => {
      const f = fixture();
      // A filter already in the repository's config, as a person might have (or a command wrote
      // into a repository the sandbox could not protect).
      writeFileSync(join(f.root, '.gitattributes'), '*.txt filter=evil\n');
      git(f.root, 'config', 'filter.evil.clean', `${f.evil} clean`);
      writeFileSync(join(f.root, 'a.txt'), 'one\ntwo\n');
      const store = new Store(':memory:');
      const session = store.create(f.root, 'create', false, {
        workspace: true,
        coding: true,
        route: OFFLINE_ROUTE,
      });
      const managed = new ManagedWork(store, {
        assertActive: () => {},
        reply: () => {},
        failed: () => {},
      });
      const local = new LocalCoding(store, managed, () => {}, undefined, sb);
      try {
        const text = await local.diff(session.id);
        expect(text).toContain('+two');
        // The filter ran confined: it could not write outside the workspace.
        expect(ran(f.marks)).toEqual([]);
      } finally {
        await local.close();
      }
    }),
  );

  test(
    'the diff view still works in a linked worktree whose git dir is outside it',
    proof(async (sb) => {
      const f = fixture();
      const wt = join(f.base, 'wt');
      git(f.root, 'worktree', 'add', '-q', '-b', 'side', wt);
      writeFileSync(join(wt, 'a.txt'), 'one\nthree\n');
      const store = new Store(':memory:');
      const session = store.create(wt, 'create', false, {
        workspace: true,
        coding: true,
        route: OFFLINE_ROUTE,
      });
      const managed = new ManagedWork(store, {
        assertActive: () => {},
        reply: () => {},
        failed: () => {},
      });
      const local = new LocalCoding(store, managed, () => {}, undefined, sb);
      try {
        expect(await local.diff(session.id)).toContain('+three');
      } finally {
        await local.close();
      }
    }),
  );
});
