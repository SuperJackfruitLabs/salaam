import { repositoryPath, repositoryTree } from '../../src/workers/repository-snapshots.js';
import { test, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { DockerHarnessBackend, harnessRuntimeDigest } from '../../src/harness/backend.js';
import type { DockerCodingExecutor } from '../../src/coding/executor.js';
import { digest } from '../../src/core/protocol.js';

function fixture() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-harness-pin-')),
    runtime = join(dir, 'runtime'),
    config = join(dir, 'config.json');
  mkdirSync(runtime, { mode: 0o700 });
  const pin = {
    id: 'codex',
    target: 'codex-app-server',
    version: '0.163.0',
    runtime_root: runtime,
    runtime_digest: digest([]),
    model: 'claude-sonnet-4-6',
    output: 4096,
    requests: 8,
  };
  const write = (p: unknown = pin) =>
    writeFileSync(config, JSON.stringify({ schema: 1, runtimes: [p] }), { mode: 0o600 });
  write();
  const executor = {
    evidence: { probe: 'passed' },
    engineId: 'fixture',
  } as unknown as DockerCodingExecutor;
  const open = () =>
    new DockerHarnessBackend(
      config,
      join(dir, 'work'),
      '/nonexistent-test.sock',
      executor,
      process.execPath,
    );
  return {
    dir,
    runtime,
    config,
    pin,
    write,
    open,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('a registry file alone advertises no proven runtime and cannot inject commands, environment or an unsupported target/model', () => {
  const f = fixture();
  try {
    expect(f.open().runtimes()).toEqual([]);
    for (const p of [
      { ...f.pin, env: { ANTHROPIC_API_KEY: 'not-a-real-key' } },
      { ...f.pin, command: 'unsafe' },
      { ...f.pin, target: 'unregistered' },
      { ...f.pin, version: '0.164.0' },
      { ...f.pin, model: 'unproved-route' },
      { ...f.pin, requests: 0 },
      { ...f.pin, output: 0 },
    ]) {
      f.write(p);
      expect(() => f.open()).toThrow('exact reviewed');
    }
    f.write();
    chmodSync(f.config, 0o644);
    expect(() => f.open()).toThrow('owner-only');
  } finally {
    f.close();
  }
});
test('complete runtime digests bind executable mode and bytes, reject escaping links, and fail before readiness on a changed artifact', async () => {
  const f = fixture();
  try {
    const original = await harnessRuntimeDigest(f.runtime);
    expect(original).toBe(f.pin.runtime_digest);
    mkdirSync(join(f.runtime, 'codex'));
    writeFileSync(join(f.runtime, 'codex/program'), 'changed', { mode: 0o600 });
    const bytes = await harnessRuntimeDigest(f.runtime);
    expect(bytes).not.toBe(original);
    chmodSync(join(f.runtime, 'codex/program'), 0o700);
    expect(await harnessRuntimeDigest(f.runtime)).not.toBe(bytes);
    await expect(f.open().prepare()).rejects.toThrow('runtime artifact changed');
    writeFileSync(join(f.dir, 'outside'), 'not-mounted');
    symlinkSync('../outside', join(f.runtime, 'escape'));
    await expect(harnessRuntimeDigest(f.runtime)).rejects.toThrow('symlink escapes');
  } finally {
    f.close();
  }
});

// Project executable settings must not enter a harness's working directory.
test('external snapshots exclude executable project configuration before startup', () => {
  for (const path of [
    '.gemini/settings.json',
    '.claude/settings.json',
    '.mcp.json',
    '.codex/config.toml',
    '.salaam/runtime.json',
    'nested/.gemini/settings.json',
  ])
    expect(() => repositoryPath(path)).toThrow(/control/);
  const file = { content: Buffer.from('guidance').toString('base64'), executable: false };
  expect(repositoryTree({ 'AGENTS.md': file, '.gemini/settings.json': file })).toEqual({
    'AGENTS.md': file,
  });
});
