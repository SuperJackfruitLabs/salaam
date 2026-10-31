import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { call } from '../../src/transport.js';

// Phase 4c (operator rulings 2026-10-31): the small-model command reviewer is off unless the service is
// given a config; turning it off for a session needs control of that session.
type View = { configured: boolean; enabled: boolean; model?: string };

test('without a config the reviewer is off and cannot be turned on', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    const path = `/v1/sessions/${id}/danger-classifier`;
    expect(await call<View>(client.socket, path)).toEqual({ configured: false, enabled: false });
    await expect(call(client.socket, path, { ...client.actor(), enabled: true })).rejects.toThrow(
      /No command reviewer/,
    );
  } finally {
    await client.leave().catch(() => {});
    await f.close();
  }
});

test('with a config it is on by default, and only the controller can turn it off', async () => {
  const dir = mkdtempSync('/tmp/sal-dc-'),
    file = join(dir, 'dc.json');
  process.env.SAL_TEST_DC_KEY = 'unused';
  writeFileSync(
    file,
    JSON.stringify({
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      key_env: 'SAL_TEST_DC_KEY',
    }),
  );
  const f = await fixture({ dangerClassifierConfig: file }),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    const path = `/v1/sessions/${id}/danger-classifier`;
    expect(await call<View>(client.socket, path)).toMatchObject({
      configured: true,
      enabled: true,
      model: 'claude-haiku-5-5',
    });
    await expect(
      call(client.socket, path, { client_id: 'someone', token: 'wrong', enabled: false }),
    ).rejects.toThrow();
    expect((await call<View>(client.socket, path)).enabled).toBe(true);
    expect(
      (await call<View>(client.socket, path, { ...client.actor(), enabled: false })).enabled,
    ).toBe(false);
    expect(JSON.stringify(await call(client.socket, path))).not.toContain('unused');
  } finally {
    delete process.env.SAL_TEST_DC_KEY;
    await client.leave().catch(() => {});
    await f.close();
  }
});
