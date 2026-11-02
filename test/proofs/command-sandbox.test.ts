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
} from '../../src/local/command-sandbox.js';
import { hostLocalSandbox } from '../../src/host/host.js';

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
    // Operator ruling 2026-11-01 asked for loopback-only listening. Seatbelt cannot express it: its
    // network filters accept only "localhost" or "*", and "localhost" matches every local address,
    // so a server bound to 0.0.0.0 was reachable from another machine (measured over the tailnet).
    // Until there is a way to refuse other interfaces, sandboxed commands may not listen at all.
    test('workspace-write cannot listen on any address, loopback included', () => {
      const root = fresh('sal-sbx-');
      for (const bind of ['127.0.0.1', '0.0.0.0']) {
        const r = runSb(
          'workspace-write',
          root,
          `'${process.execPath}' -e "require('net').createServer().listen(0, '${bind}', () => { console.log('listening'); process.exit(0) }).on('error', (e) => { console.log(e.code); process.exit(1) })"`,
        );
        expect(r.out, bind).toContain('EPERM');
        expect(r.out, bind).not.toContain('listening');
      }
    });
    // Option C (operator ruling 2026-11-01): a command the person approved to listen gets the
    // allowance, for that command only; it can serve the host, and outbound stays closed.
    test('a command approved to listen serves the host; outbound network stays closed', async () => {
      const { spawn } = await import('node:child_process');
      const port = 47000 + Math.floor(Math.random() * 1000);
      const root = fresh('sal-sbx-'),
        tmp = fresh('sal-sbt-');
      const argv = seatbeltArgv(
        'workspace-write',
        root,
        tmp,
        [
          process.execPath,
          '-e',
          `require('http').createServer((q, r) => r.end('served')).listen(${port}, '127.0.0.1')`,
        ],
        seatbelt,
        { network: false, listen: true },
      );
      const child = spawn(argv[0]!, argv.slice(1), { cwd: root, stdio: 'pipe' });
      let body = '';
      try {
        for (let i = 0; i < 40 && !body; i++) {
          await new Promise((r) => setTimeout(r, 150));
          body = await fetch(`http://127.0.0.1:${port}/`).then(
            (r) => r.text(),
            () => '',
          );
        }
      } finally {
        child.kill();
      }
      expect(body).toBe('served');
      const out = spawnSync(
        seatbeltArgv(
          'workspace-write',
          root,
          tmp,
          ['/usr/bin/curl', '-s', '-m', '5', '-o', '/dev/null', 'http://1.1.1.1'],
          seatbelt,
          { network: false, listen: true },
        )[0]!,
        seatbeltArgv(
          'workspace-write',
          root,
          tmp,
          ['/usr/bin/curl', '-s', '-m', '5', '-o', '/dev/null', 'http://1.1.1.1'],
          seatbelt,
          { network: false, listen: true },
        ).slice(1),
        { encoding: 'utf8', timeout: 15000 },
      );
      expect(out.status).not.toBe(0);
    }, 30000);
    test('read-only cannot listen at all', () => {
      const root = fresh('sal-sbx-');
      const r = runSb(
        'read-only',
        root,
        `'${process.execPath}' -e "require('net').createServer().listen(0, '127.0.0.1', () => { console.log('listening'); process.exit(0) }).on('error', (e) => { console.log(e.code); process.exit(1) })"`,
      );
      expect(r.out).not.toContain('listening');
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
