import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseLocalSandbox,
  findBwrap,
  findSeatbelt,
  sandboxArgv,
  seatbeltArgv,
} from '../../src/command-sandbox.js';
import { hostLocalSandbox } from '../../src/host.js';

// Item 10 proof. Every host runs a real assertion and nothing is skipped: Linux proves bubblewrap
// where usable, macOS always proves Seatbelt, and a host with neither proves that local commands
// are refused (operator ruling 2026-10-30, option A). Where bubblewrap is required (Linux CI), its
// absence is a failure; on macOS a missing Seatbelt is a failure.
const bwrap = findBwrap();
const seatbelt = process.platform === 'darwin' ? findSeatbelt() : null;
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

test('this host gives local commands the sandbox it can, and host plan names it', () => {
  if (process.env.SALAAM_REQUIRE_BWRAP === '1') expect(bwrap).not.toBeNull();
  if (process.platform === 'darwin') expect(seatbelt).not.toBeNull();
  const chosen = chooseLocalSandbox('workspace-write');
  const linuxWithBwrap = process.platform === 'linux' && !!bwrap;
  const kind = linuxWithBwrap ? 'bwrap' : seatbelt ? 'seatbelt' : 'none';
  expect(chosen.kind).toBe(kind);
  expect(hostLocalSandbox()).toEqual(
    kind === 'bwrap'
      ? { kind: 'bwrap', label: 'bubblewrap' }
      : kind === 'seatbelt'
        ? { kind: 'seatbelt', label: 'seatbelt' }
        : { kind: 'none', label: 'refused' },
  );
});

if (bwrap)
  describe('a sandboxed local command (bubblewrap)', () => {
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
else if (seatbelt)
  describe('a sandboxed local command (Seatbelt)', () => {
    const fresh = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    const runSb = (
      level: 'read-only' | 'workspace-write',
      root: string,
      script: string,
      network = false,
    ) => {
      const tmp = fresh('sal-sbt-');
      const argv = seatbeltArgv(level, root, tmp, ['/bin/sh', '-c', script], seatbelt, {
        network,
      });
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: root, encoding: 'utf8', timeout: 15000 });
      return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), tmp };
    };
    test('workspace-write can write the workspace and its private tmp, and nowhere else', () => {
      const root = fresh('sal-sbx-'),
        outside = fresh('sal-out-');
      expect(runSb('workspace-write', root, 'echo ok > inside.txt').code).toBe(0);
      expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('ok\n');
      const t = runSb(
        'workspace-write',
        root,
        'echo t > "$TMPDIR/scratch" && cat "$TMPDIR/scratch"',
      );
      expect(t.code, t.out).toBe(0);
      expect(t.out).toContain('t');
      for (const target of [join(outside, 'escape'), join(homedir(), 'salaam-sbx-escape')])
        expect(runSb('workspace-write', root, `echo bad > '${target}'`).code, target).not.toBe(0);
      expect(existsSync(join(outside, 'escape'))).toBe(false);
      expect(existsSync(join(homedir(), 'salaam-sbx-escape'))).toBe(false);
    });
    test('read-only cannot write even the workspace', () => {
      const root = fresh('sal-sbx-');
      expect(runSb('read-only', root, 'echo bad > inside.txt').code).not.toBe(0);
      expect(existsSync(join(root, 'inside.txt'))).toBe(false);
      expect(runSb('read-only', root, 'ls .').code).toBe(0);
    });
    test('there is no network unless the check declares it', () => {
      const root = fresh('sal-sbx-');
      const curl = '/usr/bin/curl -s -m 5 -o /dev/null http://1.1.1.1';
      expect(runSb('workspace-write', root, curl).code).not.toBe(0);
      // Declared network is allowed through the profile; reachability itself is not asserted.
      const open = runSb('workspace-write', root, `${curl}; echo exit=$?`, true);
      expect(open.out).not.toMatch(/exit=7\b/);
    });
    test('the home directory and its keys are not readable', () => {
      const root = fresh('sal-sbx-');
      expect(runSb('workspace-write', root, `ls '${homedir()}'`).code).not.toBe(0);
      expect(runSb('workspace-write', root, `ls '${join(homedir(), '.ssh')}'`).code).not.toBe(0);
    });
  });
else
  describe('a host without a usable sandbox (refused)', () => {
    test('the sandbox kind is none at every level, and sandboxArgv refuses to pretend', () => {
      for (const level of ['read-only', 'workspace-write', 'full-access'] as const)
        expect(chooseLocalSandbox(level)).toEqual({
          kind: 'none',
          level,
          bwrap: null,
          seatbelt: null,
        });
      expect(() =>
        sandboxArgv('workspace-write', '/tmp', ['/bin/true'], null, { network: false }),
      ).toThrow();
    });
  });
