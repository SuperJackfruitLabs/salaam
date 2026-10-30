import { test, expect } from 'vitest';
import {
  chooseLocalSandbox,
  sandboxArgv,
  sandboxLabel,
  seatbeltArgv,
  seatbeltProfile,
  SANDBOX_LEVELS,
  type Bwrap,
  type Seatbelt,
} from '../../src/command-sandbox.js';

// Item 10: a local command runs under bubblewrap unless the operator chose full access.
const bwrap: Bwrap = { path: '/usr/bin/bwrap', version: 'bubblewrap 0.11.1' };
const cmd = ['/bin/sh', '-c', 'echo hi'];
const flagsOf = (argv: string[]) => argv.slice(0, argv.indexOf('--') + 1);
const pairs = (argv: string[], flag: string) =>
  argv.flatMap((a, i) => (a === flag ? [[argv[i + 1], argv[i + 2]]] : []));

test('workspace-write: an empty root, read-only system, a private /tmp, the workspace writable, no network', () => {
  const argv = sandboxArgv('workspace-write', '/home/u/proj', cmd, bwrap, { network: false });
  expect(argv[0]).toBe('/usr/bin/bwrap');
  const flags = flagsOf(argv);
  for (const f of [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
  ])
    expect(flags, f).toContain(f);
  expect(pairs(flags, '--tmpfs').map((p) => p[0])).toEqual(expect.arrayContaining(['/', '/tmp']));
  for (const dir of ['/usr', '/etc/ssl'])
    expect(pairs(flags, '--ro-bind')).toContainEqual([dir, dir]);
  expect(pairs(flags, '--bind')).toContainEqual(['/home/u/proj', '/home/u/proj']);
  expect(pairs(flags, '--ro-bind').some((p) => p[0] === '/home/u/proj')).toBe(false);
  // Nothing else of the host is bound: no home, no /etc beyond ssl, no sockets.
  const bound = [...pairs(flags, '--bind'), ...pairs(flags, '--ro-bind')].map((p) => p[0]);
  for (const forbidden of ['/home', '/home/u', '/root', '/etc', '/var/run', '/run'])
    expect(bound, forbidden).not.toContain(forbidden);
  // The root is read-only after setup, so a write outside the workspace fails, not lands in a tmpfs.
  expect(
    pairs(flags, '--remount-ro').length +
      flags.filter((x, i) => x === '--remount-ro' && flags[i + 1] === '/').length,
  ).toBeGreaterThan(0);
  expect(flags.indexOf('--remount-ro')).toBeGreaterThan(flags.lastIndexOf('--tmpfs'));
  expect(argv.slice(argv.indexOf('--') + 1)).toEqual(cmd);
  expect(flags.slice(flags.indexOf('--chdir'), flags.indexOf('--chdir') + 2)).toEqual([
    '--chdir',
    '/home/u/proj',
  ]);
});

test('read-only binds the workspace read-only; a declared network keeps the network', () => {
  const ro = sandboxArgv('read-only', '/w', cmd, bwrap, { network: false });
  expect(pairs(flagsOf(ro), '--ro-bind')).toContainEqual(['/w', '/w']);
  expect(pairs(flagsOf(ro), '--bind').some((p) => p[0] === '/w')).toBe(false);
  const net = sandboxArgv('workspace-write', '/w', cmd, bwrap, { network: true });
  expect(flagsOf(net)).not.toContain('--unshare-net');
});

test('full access runs the command as is; any other level without a usable bwrap is refused', () => {
  expect(sandboxArgv('full-access', '/w', cmd, null, { network: false })).toEqual(cmd);
  for (const level of ['read-only', 'workspace-write'] as const)
    expect(() => sandboxArgv(level, '/w', cmd, null, { network: false })).toThrow('bubblewrap');
  expect(SANDBOX_LEVELS).toEqual(['read-only', 'workspace-write', 'full-access']);
  expect(() =>
    sandboxArgv('workspace-write', 'relative', cmd, bwrap, { network: false }),
  ).toThrow();
});

// Item 10, operator ruling 2026-10-30 (option A): macOS runs local commands under Seatbelt.
const seatbelt: Seatbelt = { path: '/usr/bin/sandbox-exec' };

test('a Seatbelt profile denies by default and opens only the system, the workspace and a private tmp', () => {
  const p = seatbeltProfile('workspace-write', '/Users/u/proj', '/private/tmp/salaam-cmd-x', {
    network: false,
  });
  expect(p).toMatch(/^\(version 1\)/);
  expect(p).toContain('(deny default)');
  expect(p).toContain(
    '(allow file-write* (subpath "/Users/u/proj") (subpath "/private/tmp/salaam-cmd-x")',
  );
  expect(p).toContain('(subpath "/Users/u/proj")');
  // No home, no network, no broad mach services.
  expect(p).not.toMatch(/\(allow network/);
  expect(p).not.toMatch(/\(allow mach-lookup\)/);
  expect(p).not.toContain('(subpath "/Users")');
  expect(p).not.toContain('(allow default)');
});

test('read-only Seatbelt writes only its private tmp; a declared network opens the network', () => {
  const ro = seatbeltProfile('read-only', '/w', '/private/tmp/t', { network: false });
  expect(ro).toContain('(allow file-write* (subpath "/private/tmp/t")');
  expect(ro).not.toContain('(allow file-write* (subpath "/w")');
  expect(ro).toContain('(subpath "/w")');
  const net = seatbeltProfile('workspace-write', '/w', '/private/tmp/t', { network: true });
  expect(net).toContain('(allow network*)');
});

test('Seatbelt refuses paths it cannot quote and relative paths; full access runs as is', () => {
  for (const root of ['relative', '/w"x', '/w\\x', '/w\nx'])
    expect(() =>
      seatbeltProfile('workspace-write', root, '/private/tmp/t', { network: false }),
    ).toThrow();
  expect(() => seatbeltProfile('workspace-write', '/w', 'tmp', { network: false })).toThrow();
  expect(
    seatbeltArgv('full-access', '/w', '/private/tmp/t', cmd, null, { network: false }),
  ).toEqual(cmd);
  for (const level of ['read-only', 'workspace-write'] as const)
    expect(() =>
      seatbeltArgv(level, '/w', '/private/tmp/t', cmd, null, { network: false }),
    ).toThrow('Seatbelt');
});

test('Seatbelt argv runs the command under sandbox-exec with its profile and private TMPDIR', () => {
  const argv = seatbeltArgv('workspace-write', '/w', '/private/tmp/t', cmd, seatbelt, {
    network: false,
  });
  expect(argv.slice(0, 2)).toEqual(['/usr/bin/sandbox-exec', '-p']);
  expect(argv[2]).toBe(
    seatbeltProfile('workspace-write', '/w', '/private/tmp/t', { network: false }),
  );
  expect(argv.slice(3, 5)).toEqual(['/usr/bin/env', 'TMPDIR=/private/tmp/t/']);
  expect(argv.slice(5)).toEqual(cmd);
});

test('each platform chooses its own sandbox, and none only when it is unusable', () => {
  const none = () => null;
  expect(chooseLocalSandbox('workspace-write', 'darwin', none, () => seatbelt)).toMatchObject({
    kind: 'seatbelt',
    seatbelt,
  });
  expect(chooseLocalSandbox('workspace-write', 'darwin', () => bwrap, none).kind).toBe('none');
  expect(
    chooseLocalSandbox(
      'workspace-write',
      'linux',
      () => bwrap,
      () => seatbelt,
    ).kind,
  ).toBe('bwrap');
  expect(chooseLocalSandbox('workspace-write', 'linux', none, () => seatbelt).kind).toBe('none');
  expect(
    chooseLocalSandbox(
      'read-only',
      'win32',
      () => bwrap,
      () => seatbelt,
    ).kind,
  ).toBe('none');
  expect(chooseLocalSandbox('full-access', 'darwin', none, () => seatbelt).kind).toBe('none');
  expect([sandboxLabel('bwrap'), sandboxLabel('seatbelt'), sandboxLabel('none')]).toEqual([
    'bubblewrap',
    'seatbelt',
    'unsandboxed',
  ]);
});
