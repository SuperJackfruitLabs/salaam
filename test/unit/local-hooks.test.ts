import { expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { LocalCoding, type LocalSandbox } from '../../src/local-coding.js';
import { chooseLocalSandbox } from '../../src/command-sandbox.js';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';

// Phase 4b: a hook runs as one of the session's own sandboxed commands would, with its JSON on
// stdin, bounded output and a timeout, and never as the tools user.
function setup(sandbox?: LocalSandbox, tools?: ConstructorParameters<typeof LocalCoding>[3]) {
  const root = realpathSync(mkdtempSync('/tmp/sal-hook-'));
  const store = new Store(':memory:');
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    reply: () => {},
    failed: () => {},
  });
  const local = new LocalCoding(store, managed, () => {}, tools, sandbox);
  return {
    root,
    session,
    local,
    async close() {
      await local.close();
      await managed.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const platform = chooseLocalSandbox('workspace-write');

test('a hook reads its JSON on stdin and runs in the workspace under the host sandbox', async () => {
  const f = setup(platform.kind === 'none' ? undefined : platform);
  try {
    const r = await f.local.runHook(
      f.session.id,
      'cat > got.json; pwd; echo "$SALAAM_PROJECT_DIR"',
      '{"hook_event_name":"Stop"}',
      10000,
    );
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout.trim().split('\n')).toEqual([f.root, f.root]);
    expect(JSON.parse(readFileSync(join(f.root, 'got.json'), 'utf8'))).toEqual({
      hook_event_name: 'Stop',
    });
  } finally {
    await f.close();
  }
});

test('under the sandbox a hook cannot write outside the workspace', async () => {
  // Every host runs a real assertion: with no usable sandbox a hook is refused instead (below).
  expect(platform.kind).not.toBe('none');
  const f = setup(platform);
  const outside = realpathSync(mkdtempSync('/tmp/sal-hook-out-'));
  try {
    const r = await f.local.runHook(f.session.id, `echo x > ${outside}/escaped`, '{}', 10000);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(outside, 'escaped'))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await f.close();
  }
});

test('a host with no usable sandbox refuses hooks unless the operator allowed unsandboxed commands', async () => {
  const f = setup({ kind: 'none', level: 'workspace-write', bwrap: null });
  try {
    const r = await f.local.runHook(f.session.id, 'echo hi', '{}', 5000);
    expect(r.refused).toMatch(/refused/);
    expect(r.code).toBeNull();
  } finally {
    await f.close();
  }
});

test('hooks never run as the tools user', async () => {
  const f = setup(undefined, {
    mode: 'tools-user',
    user: 'salaam-tools',
    uid: 1234,
    prefix: ['/usr/bin/false'],
    warning: null,
  });
  try {
    const r = await f.local.runHook(f.session.id, 'echo hi', '{}', 5000);
    expect(r.refused).toMatch(/tools user/);
  } finally {
    await f.close();
  }
});

test('a hook past its timeout is killed, and its output is bounded', async () => {
  const f = setup();
  try {
    const started = Date.now();
    const slow = await f.local.runHook(f.session.id, 'sleep 20', '{}', 300);
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    const loud = await f.local.runHook(
      f.session.id,
      'head -c 200000 /dev/zero | tr "\\0" a',
      '{}',
      10000,
    );
    expect(loud.truncated).toBe(true);
    expect(Buffer.byteLength(loud.stdout)).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await f.close();
  }
});
