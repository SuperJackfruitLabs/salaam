import { test, expect } from 'vitest';
import { sandboxArgv, SANDBOX_LEVELS, type Bwrap } from '../../src/command-sandbox.js';

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
