import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chooseLocalSandbox, findBwrap, sandboxArgv } from '../../src/command-sandbox.js';
import { hostLocalSandbox } from '../../src/host.js';

// Item 10 proof. Every host runs a real assertion and nothing is skipped: where bubblewrap is
// usable, a real sandbox is proven; where it is not (macOS, or Linux without user namespaces),
// the host's labelled-unsandboxed fallback is proven instead. Where bubblewrap is required (Linux
// CI), its absence is a failure.
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

test('this host gives local commands the sandbox it can, and host plan names it', () => {
  if (process.env.SALAAM_REQUIRE_BWRAP === '1') expect(bwrap).not.toBeNull();
  const chosen = chooseLocalSandbox('workspace-write');
  const linuxWithBwrap = process.platform === 'linux' && !!bwrap;
  expect(chosen.kind).toBe(linuxWithBwrap ? 'bwrap' : 'none');
  expect(hostLocalSandbox()).toEqual(
    linuxWithBwrap
      ? { kind: 'bwrap', label: 'bubblewrap' }
      : { kind: 'none', label: 'unsandboxed' },
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
else
  describe('a host without a usable sandbox (labelled unsandboxed)', () => {
    test('the sandbox kind is none at every level, and sandboxArgv refuses to pretend', () => {
      for (const level of ['read-only', 'workspace-write', 'full-access'] as const)
        expect(chooseLocalSandbox(level)).toEqual({ kind: 'none', level, bwrap: null });
      expect(() =>
        sandboxArgv('workspace-write', '/tmp', ['/bin/true'], null, { network: false }),
      ).toThrow();
    });
  });
