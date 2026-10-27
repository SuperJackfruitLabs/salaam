import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findBwrap, sandboxArgv } from '../../src/command-sandbox.js';

// Item 10 proof: a real bubblewrap sandbox. Runs wherever bubblewrap is usable (Linux with user
// namespaces); elsewhere it is reported as skipped, never as passed.
const bwrap = findBwrap();
const run = (
  level: 'read-only' | 'workspace-write',
  root: string,
  script: string,
  network = false,
) => {
  const argv = sandboxArgv(level, root, ['/bin/sh', '-c', script], bwrap, { network });
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 10000 });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

// Where bubblewrap is required (Linux CI), its absence is a failure, not a skip.
test.runIf(process.env.SALAAM_REQUIRE_BWRAP === '1')(
  'bubblewrap is usable where it is required',
  () => {
    expect(bwrap).not.toBeNull();
  },
);

describe.runIf(!!bwrap)('a sandboxed local command (bubblewrap)', () => {
  test('workspace-write can write the workspace and nowhere else', () => {
    const root = mkdtempSync('/tmp/sal-sbx-');
    expect(run('workspace-write', root, 'echo ok > inside.txt').code).toBe(0);
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('ok\n');
    for (const outside of [
      '/etc/salaam-sbx-escape',
      '/usr/salaam-sbx-escape',
      '/root/salaam-sbx-escape',
    ])
      expect(run('workspace-write', root, `echo bad > ${outside}`).code, outside).not.toBe(0);
    expect(existsSync('/etc/salaam-sbx-escape')).toBe(false);
  });
  test('read-only cannot write even the workspace', () => {
    const root = mkdtempSync('/tmp/sal-sbx-');
    expect(run('read-only', root, 'echo bad > inside.txt').code).not.toBe(0);
    expect(existsSync(join(root, 'inside.txt'))).toBe(false);
  });
  test('there is no network but loopback, unless the check declares it', () => {
    const root = mkdtempSync('/tmp/sal-sbx-');
    const dev = run('workspace-write', root, 'cat /proc/net/dev');
    expect(dev.code).toBe(0);
    const ifaces = dev.out
      .split('\n')
      .slice(2)
      .map((l) => l.split(':')[0]!.trim())
      .filter(Boolean);
    expect(ifaces).toEqual(['lo']);
    const open = run('workspace-write', root, 'cat /proc/net/dev', true);
    expect(open.out.split('\n').slice(2).filter(Boolean).length).toBeGreaterThan(1);
  });
  test('the home directory and its keys are not there', () => {
    const root = mkdtempSync('/tmp/sal-sbx-');
    expect(run('workspace-write', root, `ls ${join(homedir(), '.ssh')}`).code).not.toBe(0);
    expect(run('workspace-write', root, 'cat /etc/shadow').code).not.toBe(0);
  });
});
