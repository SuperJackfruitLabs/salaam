import { test, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  resolveReadPaths,
  sandboxArgv,
  seatbeltArgv,
  seatbeltProfile,
} from '../../src/local/command-sandbox.js';
import { hostLocalSandbox, hostReadPaths, planHost } from '../../src/host/host.js';

// Phase 1 (operator, 2026-10-31): make local commands usable on a Mac. Step 0 found git failing
// under Seatbelt (Apple's /usr/bin/git shim needs Xcode's licence preferences) and every
// toolchain outside the workspace unreadable. The fix keeps the sandbox: the real git from the
// developer dir, no global git config unless the operator allows it, and an operator-set
// read-only allowlist that can never cover home itself or a credential directory.

const home = homedir();
const seatbelt = { path: '/usr/bin/sandbox-exec', developerDir: '/X/Developer' };

test('a Seatbelt command runs the real git, with no global git config unless allowed', () => {
  const argv = seatbeltArgv(
    'workspace-write',
    '/w',
    '/t',
    ['/bin/sh', '-c', 'git status'],
    seatbelt,
    {
      network: false,
    },
  );
  const path = argv.find((a) => a.startsWith('PATH='));
  expect(path?.startsWith('PATH=/X/Developer/usr/bin:')).toBe(true);
  expect(argv).toContain('GIT_CONFIG_GLOBAL=/dev/null');
  const allowed = seatbeltArgv('workspace-write', '/w', '/t', ['/bin/sh'], seatbelt, {
    network: false,
    readPaths: [join(home, '.gitconfig')],
  });
  expect(allowed).not.toContain('GIT_CONFIG_GLOBAL=/dev/null');
  // A Seatbelt without a developer dir leaves PATH alone.
  const plain = seatbeltArgv(
    'workspace-write',
    '/w',
    '/t',
    ['/bin/sh'],
    { path: '/s' },
    { network: false },
  );
  expect(plain.some((a) => a.startsWith('PATH='))).toBe(false);
});

test('allowed read paths are readable in the profile and nothing else is added', () => {
  const p = seatbeltProfile('workspace-write', '/w', '/t', {
    network: false,
    readPaths: ['/opt/toolchain', '/Users/x/.npm'],
  });
  expect(p).toContain('(subpath "/opt/toolchain")');
  expect(p).toContain('(subpath "/Users/x/.npm")');
  // Read only: they never appear in the write rule.
  const write = p.split('\n').find((l) => l.startsWith('(allow file-write*'))!;
  expect(write).not.toContain('/opt/toolchain');
  expect(p).not.toContain(`(subpath "${home}")`);
});

test('bubblewrap binds allowed read paths read-only, and only those', () => {
  const argv = sandboxArgv(
    'workspace-write',
    '/w',
    ['/bin/true'],
    { path: '/usr/bin/bwrap', version: 'x' },
    {
      network: false,
      readPaths: ['/opt/toolchain'],
    },
  );
  const i = argv.indexOf('/opt/toolchain');
  expect(argv[i - 1]).toBe('--ro-bind-try');
  expect(argv[i + 1]).toBe('/opt/toolchain');
});

test.each([
  ['relative', 'node_modules'],
  ['the root', '/'],
  ['home itself', home],
  ['an ancestor of home', dirname(home)],
  ['ssh keys', join(home, '.ssh')],
  ['inside ssh', join(home, '.ssh', 'config')],
  ['the keychain', join(home, 'Library', 'Keychains')],
  ['an ancestor of the keychain', join(home, 'Library')],
  ['npm auth', join(home, '.npmrc')],
  ['cloud credentials', join(home, '.aws')],
  ['a quote', '/opt/a"b'],
])('a read path that is %s is refused', (_what, path) => {
  expect(() => resolveReadPaths([path])).toThrow();
});

test('home itself is refused as home, not only because it holds credentials', () => {
  expect(() => resolveReadPaths([home])).toThrow(/whole home directory/);
  // On a host where home sits directly under / (root's /root), its parent is the whole filesystem.
  expect(() => resolveReadPaths([dirname(home)])).toThrow(/whole (home directory|filesystem)/);
});

test('toolchain expands to the existing toolchain paths, never home or credentials', () => {
  const fakeHome = realpathSync(mkdtempSync('/tmp/sal-home-'));
  mkdirSync(join(fakeHome, '.npm'));
  mkdirSync(join(fakeHome, '.cargo'));
  writeFileSync(join(fakeHome, '.gitconfig'), '[user]\n');
  mkdirSync(join(fakeHome, '.ssh'));
  const paths = resolveReadPaths(['toolchain', '/opt/extra'], fakeHome);
  expect(paths).toContain(join(fakeHome, '.npm'));
  expect(paths).toContain(join(fakeHome, '.cargo'));
  expect(paths).toContain(join(fakeHome, '.gitconfig'));
  expect(paths).toContain('/opt/extra');
  // Absent ones are left out; credentials and home never appear.
  expect(paths).not.toContain(join(fakeHome, '.rustup'));
  expect(paths.some((p) => p === fakeHome || p.startsWith(join(fakeHome, '.ssh')))).toBe(false);
  // The node running Salaam is readable, so `node`/`npx` work inside the sandbox.
  expect(paths.some((p) => realpathSync(process.execPath).startsWith(p + '/'))).toBe(true);
});

test('host plan pins the resolved read paths, and refuses a bad one', async () => {
  const base = {
    mode: 'agentpod',
    state: '/var/lib/salaam/s',
    agentpod_config: '/etc/salaam/pins.json',
  } as const;
  await expect(
    planHost({ ...base, local_sandbox_read_paths: [join(home, '.ssh')] }),
  ).rejects.toThrow(/local_sandbox_read_paths/);
  await expect(planHost({ ...base, local_sandbox_read_paths: 'x' })).rejects.toThrow(
    /list of absolute paths or "toolchain"/,
  );
  // The manifest records the resolved list, and the daemon reads it back from there.
  const pinned = hostLocalSandbox(undefined, undefined, undefined, false, undefined, ['/opt/tc']);
  expect(pinned.read_paths).toEqual(['/opt/tc']);
  expect(hostReadPaths({ local_sandbox: pinned } as never)).toEqual(['/opt/tc']);
  expect(hostReadPaths({ local_sandbox: hostLocalSandbox() } as never)).toEqual([]);
});

// The worker side: a local coding session is told its platform and to edit with its edit tool.
const saved = process.env.SALAAM_WORKER_CONFIG;
afterEach(() => {
  if (saved === undefined) delete process.env.SALAAM_WORKER_CONFIG;
  else process.env.SALAAM_WORKER_CONFIG = saved;
});
test('a local coding session is told its platform, its shell tools, and to edit with salaam_local', async () => {
  process.env.SALAAM_WORKER_CONFIG = JSON.stringify({
    socket: '/nonexistent',
    token: 't',
    session: 's',
    epoch: 1,
    bundle: 'b',
    policy: 'p',
    frame: 'f',
    local: true,
    localCoding: true,
  });
  const handlers: ((e: unknown) => unknown)[] = [];
  const pi = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === 'on'
          ? (event: string, h: (e: unknown) => unknown) => {
              if (event === 'before_agent_start') handlers.push(h);
            }
          : () => undefined,
    },
  );
  const { default: house } = await import('../../src/runtime/house-extension.js');
  house(pi as never);
  let prompt = '';
  for (const h of handlers) {
    const r = (await h({ type: 'before_agent_start', systemPrompt: prompt })) as
      { systemPrompt?: string } | undefined;
    if (r?.systemPrompt) prompt = r.systemPrompt;
  }
  expect(prompt).not.toContain('without OS sandbox isolation');
  if (process.platform === 'darwin') {
    expect(prompt).toContain('macOS');
    expect(prompt).toContain("sed -i ''");
  } else expect(prompt).toContain(process.platform === 'linux' ? 'Linux' : process.platform);
  expect(prompt).toMatch(/edit files with salaam_local/i);
});
