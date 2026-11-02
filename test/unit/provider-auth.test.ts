import { expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderCredentialStore } from '../../src/providers/auth.js';

test('provider credentials are private, scoped, atomic and serialized through refresh', async () => {
  const dir = mkdtempSync('/tmp/sal-provider-auth-');
  try {
    const store = new ProviderCredentialStore(dir);
    await store.modify('openai', async () => ({
      type: 'oauth',
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires: 1,
      generation: 0,
    }));
    await Promise.all(
      Array.from({ length: 5 }, () =>
        new ProviderCredentialStore(dir).modify('openai', async (current) => {
          await new Promise((r) => setTimeout(r, 5));
          return {
            ...current!,
            generation: Number((current as unknown as { generation: number }).generation) + 1,
          };
        }),
      ),
    );
    expect(await store.read('openai')).toMatchObject({ generation: 5, refresh: 'fixture-refresh' });
    expect(await store.read('google')).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: 'openai', type: 'oauth' }]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'openai.json')).mode & 0o777).toBe(0o600);
    const before = readFileSync(join(dir, 'openai.json'), 'utf8');
    await expect(
      store.modify('openai', async () => {
        throw new Error('refresh failed');
      }),
    ).rejects.toThrow('refresh failed');
    expect(readFileSync(join(dir, 'openai.json'), 'utf8')).toBe(before);
    await store.delete('openai');
    expect(await store.read('openai')).toBeUndefined();
    await expect(store.read('../foreign')).rejects.toThrow('Unknown Pi');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsafe credential files and directory symlinks fail closed', async () => {
  const dir = mkdtempSync('/tmp/sal-provider-auth-');
  try {
    const store = new ProviderCredentialStore(join(dir, 'credentials'));
    await store.modify('google', async () => ({ type: 'api_key', key: 'fixture-google-key' }));
    chmodSync(join(store.dir, 'google.json'), 0o644);
    await expect(store.read('google')).rejects.toThrow('mode 600');
    chmodSync(join(store.dir, 'google.json'), 0o600);
    symlinkSync(join(store.dir, 'google.json'), join(store.dir, 'openai.json'));
    await expect(store.read('openai')).rejects.toThrow('Unsafe');
    symlinkSync(store.dir, join(dir, 'alias'));
    await expect(
      new ProviderCredentialStore(join(dir, 'alias')).modify('google', async () => undefined),
    ).rejects.toThrow('Unsafe credential directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OAuth installation identity is stable and private', async () => {
  const { providerDeviceId } = await import('../../src/providers/auth.js');
  const dir = mkdtempSync('/tmp/sal-provider-id-');
  try {
    const id = providerDeviceId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(providerDeviceId(dir)).toBe(id);
    expect(statSync(join(dir, '.device-id')).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential refresh locks serialize separate CLI and daemon processes', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { ROOT } = await import('../../src/core/config.js');
  const dir = mkdtempSync('/tmp/sal-provider-process-auth-');
  try {
    const store = new ProviderCredentialStore(dir);
    await store.modify('openai', async () => ({
      type: 'oauth',
      access: 'fixture-access',
      refresh: 'fixture-refresh',
      expires: 1,
      generation: 0,
    }));
    await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(process.execPath, [
          join(ROOT, 'test/fixtures/provider-credential-update.mjs'),
          dir,
        ]),
      ),
    );
    expect(await store.read('openai')).toMatchObject({ generation: 4 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI provider setup, metadata status and logout use an isolated credential home', async () => {
  const { spawn, execFile } = await import('node:child_process');
  const { once } = await import('node:events');
  const { promisify } = await import('node:util');
  const { ROOT } = await import('../../src/core/config.js');
  const { existsSync } = await import('node:fs');
  const home = mkdtempSync('/tmp/sal-cli-provider-home-');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR,
  };
  const cli = join(ROOT, 'bin/salaam.mjs');
  const run = async (...args: string[]) =>
    (await promisify(execFile)(process.execPath, [cli, ...args], { env })).stdout;
  try {
    const child = spawn(process.execPath, [cli, 'auth', 'set', 'openai'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = once(child, 'exit');
    child.stdin.end('sk-fixture-cli-provider-key\n');
    expect((await exited)[0]).toBe(0);
    expect(output).not.toContain('sk-fixture-cli-provider-key');
    const path = join(home, '.config/salaam/credentials/openai.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await run('auth', 'status', 'openai'))).toEqual([
      { provider: 'openai', configured: true, type: 'api_key', source: 'stored credential' },
    ]);
    expect(JSON.parse(await run('providers', 'list'))).toHaveLength(42);
    expect(
      JSON.parse(await run('models', 'list', 'openai')).some(
        (model: { id: string }) => model.id === 'gpt-4',
      ),
    ).toBe(true);
    await run('auth', 'logout', 'openai');
    expect(existsSync(path)).toBe(false);
    expect(JSON.parse(await run('auth', 'status', 'openai'))[0].configured).toBe(false);
    expect(existsSync(join(home, '.local/state/salaam/operator.sock'))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
