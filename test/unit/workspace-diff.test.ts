import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDiff } from '../../src/workspace-diff.js';
const file = (content: string) => ({
  content: Buffer.from(content).toString('base64'),
  executable: false,
});
test.each([
  { before: 'old\n', after: 'new\n' },
  { before: 'old', after: 'new' },
  { before: null, after: 'created\n' },
  { before: 'deleted\n', after: null },
  { before: null, after: '' },
  { before: '', after: null },
  { before: 'line\n\n', after: 'line\nchanged\n' },
])('reviewable diff applies exactly for %j', ({ before, after }) => {
  const dir = mkdtempSync('/tmp/sal-diff-'),
    path = 'file with spaces.txt';
  try {
    execFileSync('git', ['init', '--template=', dir], { stdio: 'ignore' });
    if (before !== null) writeFileSync(join(dir, path), before);
    const patch = workspaceDiff({
      path,
      before: before === null ? null : file(before),
      after: after === null ? null : file(after),
    });
    execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'apply', '--check', '-'], {
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', 'apply', '-'], {
      input: patch,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (after === null) expect(existsSync(join(dir, path))).toBe(false);
    else expect(readFileSync(join(dir, path), 'utf8')).toBe(after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('terminal control bytes are represented as a binary/control change', () => {
  expect(workspaceDiff({ path: 'safe', before: null, after: file('\x1b]52;clipboard') })).toContain(
    'Binary or control-character change',
  );
});
