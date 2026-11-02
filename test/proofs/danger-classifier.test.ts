import { test, expect } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { call } from '../../src/core/transport.js';

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
    expect(await call<View>(client.socket, path)).toMatchObject({
      configured: false,
      enabled: false,
    });
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

// Operator 2026-10-31: the reviewer needs its own model selection. A config may list several
// options; a session picks one or off; a host can pin one (no off) or forbid the reviewer.
type Picker = View & {
  choice: string;
  pinned: boolean;
  options: { name: string; provider: string; model: string }[];
};
function optionsFile() {
  const dir = mkdtempSync('/tmp/sal-dc-'),
    file = join(dir, 'dc.json');
  process.env.SAL_TEST_DC_KEY = 'unused';
  writeFileSync(
    file,
    JSON.stringify({
      default: 'haiku',
      options: [
        {
          name: 'haiku',
          provider: 'anthropic',
          model: 'claude-haiku-5-5',
          key_env: 'SAL_TEST_DC_KEY',
        },
        {
          name: 'local',
          provider: 'openai-compatible',
          model: 'qwen3-4b',
          url: 'http://127.0.0.1:9/v1',
        },
      ],
    }),
  );
  return file;
}

test('a session picks the reviewer model from the configured options, or off', async () => {
  const f = await fixture({ dangerClassifierConfig: optionsFile() }),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    const path = `/v1/sessions/${id}/danger-classifier`;
    const first = await call<Picker>(client.socket, path);
    expect(first).toMatchObject({
      configured: true,
      enabled: true,
      choice: 'haiku',
      pinned: false,
    });
    expect(first.options.map((o) => o.name)).toEqual(['haiku', 'local']);
    const local = await call<Picker>(client.socket, path, { ...client.actor(), choice: 'local' });
    expect(local).toMatchObject({ choice: 'local', model: 'qwen3-4b', enabled: true });
    const off = await call<Picker>(client.socket, path, { ...client.actor(), choice: 'off' });
    expect(off).toMatchObject({ choice: 'off', enabled: false });
    await expect(
      call(client.socket, path, { ...client.actor(), choice: 'gpt-huge' }),
    ).rejects.toThrow(/Unknown reviewer/);
    expect(JSON.stringify(await call(client.socket, path))).not.toContain('unused');
  } finally {
    delete process.env.SAL_TEST_DC_KEY;
    await client.leave().catch(() => {});
    await f.close();
  }
});

test('a pinned reviewer cannot be switched or turned off; a forbidden one is never on', async () => {
  const pinned = await fixture({
      dangerClassifierConfig: optionsFile(),
      dangerClassifierPin: 'local',
    }),
    client = new OperatorClient(pinned.dir);
  try {
    const id = await client.create(realpathSync(pinned.dir), false, undefined, true);
    await ready(pinned.service, id);
    const path = `/v1/sessions/${id}/danger-classifier`;
    expect(await call<Picker>(client.socket, path)).toMatchObject({
      choice: 'local',
      pinned: true,
    });
    for (const choice of ['off', 'haiku'])
      await expect(call(client.socket, path, { ...client.actor(), choice })).rejects.toThrow(
        /pinned/,
      );
  } finally {
    await client.leave().catch(() => {});
    await pinned.close();
  }
  const forbidden = await fixture({
      dangerClassifierConfig: optionsFile(),
      dangerClassifierPin: 'off',
    }),
    other = new OperatorClient(forbidden.dir);
  try {
    const id = await other.create(realpathSync(forbidden.dir), false, undefined, true);
    await ready(forbidden.service, id);
    const path = `/v1/sessions/${id}/danger-classifier`;
    expect(await call<Picker>(other.socket, path)).toMatchObject({ enabled: false, choice: 'off' });
    await expect(call(other.socket, path, { ...other.actor(), choice: 'haiku' })).rejects.toThrow(
      /pinned/,
    );
  } finally {
    delete process.env.SAL_TEST_DC_KEY;
    await other.leave().catch(() => {});
    await forbidden.close();
  }
});
