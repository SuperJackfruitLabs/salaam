import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/config.js';
import { HarnessRpc } from '../../src/harness-rpc.js';

function peer(mode: string, dialect: 'acp' | 'codex' = 'acp', failed?: (error: Error) => void) {
  const dir = mkdtempSync('/tmp/sal-rpc-');
  const rpc = new HarnessRpc(
    {
      executable: process.execPath,
      args: [join(ROOT, 'test/fixtures/harness-peer.mjs'), mode, dialect],
      cwd: dir,
      env: {},
      dialect,
    },
    { failed },
  );
  return {
    rpc,
    async close() {
      await rpc.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const dialect of ['acp', 'codex'] as const)
  test(dialect + ' framing keeps IDs distinct and handles fragmented Unicode replies', async () => {
    const p = peer('fragment', dialect);
    try {
      const results = await Promise.all([
        p.rpc.request('one', { text: 'Salaam سلام' }),
        p.rpc.request('two', { n: 2 }),
      ]);
      expect(results).toEqual([
        { method: 'one', echo: { text: 'Salaam سلام' } },
        { method: 'two', echo: { n: 2 } },
      ]);
    } finally {
      await p.close();
    }
  });
for (const mode of [
  'malformed',
  'dialect',
  'oversize',
  'invalid-utf8',
  'truncated',
  'wrong-id',
  'primitive',
])
  test(mode + ' fails closed before accepting a response', async () => {
    const p = peer(mode);
    try {
      await expect(p.rpc.request('initialize', {})).rejects.toThrow();
      await expect(p.rpc.request('retry', {})).rejects.toThrow();
    } finally {
      await p.close();
    }
  });
test('a timed-out request becomes unknown and cannot be retried on the same connection', async () => {
  const p = peer('silent');
  try {
    await expect(p.rpc.request('session/prompt', {}, 30)).rejects.toMatchObject({
      code: 'harness_outcome_unknown',
    });
    await expect(p.rpc.request('session/prompt', {})).rejects.toMatchObject({
      code: 'harness_outcome_unknown',
    });
  } finally {
    await p.close();
  }
});
test('unsupported method is explicit and does not invent a successful resume', async () => {
  const p = peer('error');
  try {
    await expect(p.rpc.request('session/load', {})).rejects.toMatchObject({
      code: 'harness_rpc_error',
    });
  } finally {
    await p.close();
  }
});
test('client file, terminal and permission requests have no implicit authority', async () => {
  const p = peer('permission');
  try {
    await expect(p.rpc.request('session/prompt', {})).resolves.toEqual({ denied: true });
  } finally {
    await p.close();
  }
});
test('duplicate terminal replies poison the connection instead of completing another request', async () => {
  let failed: Error | undefined;
  const p = peer('duplicate', 'codex', (e) => {
    failed = e;
  });
  try {
    await p.rpc.request('turn/start', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(failed?.message).toContain('duplicate');
    await expect(p.rpc.request('turn/start', {})).rejects.toThrow();
  } finally {
    await p.close();
  }
});
test('pending request count is bounded and close rejects all outstanding callers', async () => {
  const p = peer('silent');
  try {
    const pending = Array.from({ length: 16 }, () => p.rpc.request('wait', {}).catch((e) => e));
    await expect(p.rpc.request('overflow', {})).rejects.toThrow('bound');
    await p.rpc.close();
    expect((await Promise.all(pending)).every((e) => e instanceof Error)).toBe(true);
  } finally {
    await p.close();
  }
});
