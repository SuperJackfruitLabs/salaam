import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ShadowCheckpoints } from '../../src/turn-checkpoints.js';

function setup() {
  const root = realpathSync(mkdtempSync('/tmp/sal-turn-ck-'));
  const state = realpathSync(mkdtempSync('/tmp/sal-turn-ck-state-'));
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  return { root, state, shadow: new ShadowCheckpoints(state, root) };
}

test('checkpoints live outside the workspace and never touch the user git repository', () => {
  const { root, state, shadow } = setup();
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, '.git', 'marker'), 'x');
  const before = readFileSync(join(root, '.git', 'HEAD'), 'utf8');
  const tree = shadow.capture();
  expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
  expect(shadow.dir.startsWith(state)).toBe(true);
  expect(existsSync(join(root, '.salaam'))).toBe(false);
  expect(readFileSync(join(root, '.git', 'HEAD'), 'utf8')).toBe(before);
  // The user repository has no index written and no objects from the shadow.
  expect(existsSync(join(root, '.git', 'index'))).toBe(false);
  expect(shadow.files(tree).map((f) => f.path)).toEqual(['a.txt', 'src/b.ts']);
});

test('gitignored files, node_modules and env files are not captured', () => {
  const { root, shadow } = setup();
  writeFileSync(join(root, '.gitignore'), 'out/\n');
  mkdirSync(join(root, 'out'));
  writeFileSync(join(root, 'out', 'x.js'), 'x');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'm.js'), 'm');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  writeFileSync(join(root, '.env.local'), 'SECRET=2');
  const paths = shadow.files(shadow.capture()).map((f) => f.path);
  expect(paths).toEqual(['.gitignore', 'a.txt', 'src/b.ts']);
});

test('the same tree has the same digest; any content or mode change moves it', () => {
  const { root, shadow } = setup();
  const one = shadow.capture();
  expect(shadow.capture()).toBe(one);
  writeFileSync(join(root, 'a.txt'), 'changed\n');
  const two = shadow.capture();
  expect(two).not.toBe(one);
  chmodSync(join(root, 'src', 'b.ts'), 0o755);
  expect(shadow.capture()).not.toBe(two);
});

test('changes lists added, modified and deleted files with line counts', () => {
  const { root, shadow } = setup();
  const base = shadow.capture();
  writeFileSync(join(root, 'a.txt'), 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  writeFileSync(join(root, 'new.md'), 'hello\nworld\n');
  execFileSync('rm', [join(root, 'src', 'b.ts')]);
  const now = shadow.capture();
  expect(shadow.changes(base, now)).toEqual([
    { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
    { path: 'new.md', status: 'added', added: 2, removed: 0 },
    { path: 'src/b.ts', status: 'deleted', added: 0, removed: 1 },
  ]);
});

test('restore returns the workspace to the target tree exactly, only when the current tree is the reviewed one', () => {
  const { root, shadow } = setup();
  chmodSync(join(root, 'src', 'b.ts'), 0o755);
  const target = shadow.capture();
  writeFileSync(join(root, 'a.txt'), 'rewritten\n');
  writeFileSync(join(root, 'extra.txt'), 'made later\n');
  execFileSync('rm', [join(root, 'src', 'b.ts')]);
  const current = shadow.capture();
  // A tree other than the reviewed one is refused and nothing is written.
  expect(() => shadow.restore(target, target)).toThrow(/changed since you reviewed/);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('rewritten\n');
  shadow.restore(current, target);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toMatch(/^one\n/);
  expect(existsSync(join(root, 'extra.txt'))).toBe(false);
  expect(statSync(join(root, 'src', 'b.ts')).mode & 0o111).not.toBe(0);
  expect(shadow.capture()).toBe(target);
});

test('restore leaves files the checkpoint does not cover alone', () => {
  const { root, shadow } = setup();
  writeFileSync(join(root, '.env'), 'KEEP=1');
  const target = shadow.capture();
  writeFileSync(join(root, '.env'), 'KEEP=2');
  writeFileSync(join(root, 'a.txt'), 'x\n');
  shadow.restore(shadow.capture(), target);
  expect(readFileSync(join(root, '.env'), 'utf8')).toBe('KEEP=2');
});

test('hunks split a file diff; reverting one hunk keeps the others', () => {
  const { root, shadow } = setup();
  const base = shadow.capture();
  writeFileSync(join(root, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n');
  const now = shadow.capture();
  const hunks = shadow.hunks(base, now, 'a.txt');
  expect(hunks).toHaveLength(2);
  expect(hunks[0]!.text).toContain('-one\n+ONE');
  shadow.revertHunk(now, base, 'a.txt', hunks[1]!);
  expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe(
    'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n',
  );
  // A hunk reviewed against an older tree is refused.
  expect(() => shadow.revertHunk(now, base, 'a.txt', hunks[0]!)).toThrow(
    /changed since you reviewed/,
  );
});

test('accepting a file or hunk moves the review base, never the workspace', () => {
  const { root, shadow } = setup();
  const base = shadow.capture();
  writeFileSync(join(root, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  const now = shadow.capture();
  const hunk = shadow.hunks(base, now, 'a.txt')[0]!;
  const partly = shadow.acceptHunk(base, now, 'a.txt', hunk);
  expect(shadow.changes(partly, now)).toEqual([
    { path: 'a.txt', status: 'modified', added: 1, removed: 1 },
    { path: 'src/b.ts', status: 'modified', added: 1, removed: 1 },
  ]);
  expect(shadow.hunks(partly, now, 'a.txt')[0]!.text).toContain('+TEN');
  const accepted = shadow.acceptFile(partly, now, 'src/b.ts');
  expect(shadow.changes(accepted, now).map((c) => c.path)).toEqual(['a.txt']);
  expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
  // Accepting a deleted file drops it from the base too.
  execFileSync('rm', [join(root, 'src', 'b.ts')]);
  const gone = shadow.capture();
  expect(
    shadow.changes(shadow.acceptFile(accepted, gone, 'src/b.ts'), gone).map((c) => c.path),
  ).toEqual(['a.txt']);
});

test('reverting a file restores it from the base, including a file the turn deleted', () => {
  const { root, shadow } = setup();
  const base = shadow.capture();
  execFileSync('rm', [join(root, 'src', 'b.ts')]);
  writeFileSync(join(root, 'new.md'), 'x\n');
  let now = shadow.capture();
  shadow.revertFile(now, base, 'src/b.ts');
  expect(readFileSync(join(root, 'src', 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
  now = shadow.capture();
  shadow.revertFile(now, base, 'new.md');
  expect(existsSync(join(root, 'new.md'))).toBe(false);
  expect(shadow.capture()).toBe(base);
});

test('paths are confined to the workspace', () => {
  const { shadow } = setup();
  const t = shadow.capture();
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', '.git/config'])
    expect(() => shadow.revertFile(t, t, bad)).toThrow(
      expect.objectContaining({ code: 'unsafe_path' }),
    );
});

test('a kept checkpoint stays reachable under its name in the shadow, never in the user repository', () => {
  const { root, shadow } = setup();
  execFileSync('git', ['init', '-q'], { cwd: root });
  const tree = shadow.capture();
  shadow.keep('session/attempt', tree);
  const git = (args: string[]) =>
    execFileSync('git', args, {
      env: { ...process.env, GIT_DIR: shadow.dir },
      encoding: 'utf8',
    }).trim();
  expect(git(['rev-parse', 'refs/salaam/session/attempt^{tree}'])).toBe(tree);
  expect(execFileSync('git', ['for-each-ref'], { cwd: root, encoding: 'utf8' })).toBe('');
  expect(() => shadow.keep('../escape', tree)).toThrow(/Invalid checkpoint name/);
});

test('Salaam state kept inside the folder is never captured or restored', () => {
  const { root } = setup();
  const state = join(root, 'salaam-state');
  mkdirSync(state);
  writeFileSync(join(state, 'journal.sqlite3'), 'journal');
  const shadow = new ShadowCheckpoints(state, root);
  const target = shadow.capture();
  expect(shadow.files(target).map((f) => f.path)).toEqual(['a.txt', 'src/b.ts']);
  writeFileSync(join(state, 'journal.sqlite3'), 'journal grew');
  writeFileSync(join(root, 'a.txt'), 'x\n');
  shadow.restore(shadow.capture(), target);
  expect(readFileSync(join(state, 'journal.sqlite3'), 'utf8')).toBe('journal grew');
  expect(existsSync(shadow.dir)).toBe(true);
});

test('no checkpoint is taken when the folder is Salaam state itself', () => {
  const { root } = setup();
  expect(() => new ShadowCheckpoints(root, root).capture()).toThrow(/state folder is this folder/);
});
