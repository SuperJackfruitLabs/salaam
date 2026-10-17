import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, chmodSync, symlinkSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { providerRoute, validateClaudePayload, OFFLINE_ROUTE } from '../../src/provider-config.js';
import { loadApiKey, saveApiKey, validateApiKey } from '../../src/credentials.js';

test('Claude credentials persist privately and environment values override the local file', () => {
  const dir = mkdtempSync('/tmp/sal-credentials-'),
    path = join(dir, 'credentials', 'anthropic');
  try {
    saveApiKey('fixture-anthropic-key', path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'credentials')).mode & 0o777).toBe(0o700);
    expect(loadApiKey(path, '')).toBe('fixture-anthropic-key');
    expect(loadApiKey(path, 'fixture-environment-key')).toBe('fixture-environment-key');
    saveApiKey('fixture-replacement-key', path);
    expect(readFileSync(path, 'utf8')).toBe('fixture-replacement-key');
    chmodSync(path, 0o644);
    expect(() => loadApiKey(path, '')).toThrow('mode 600');
    chmodSync(path, 0o600);
    const link = join(dir, 'link');
    symlinkSync(path, link);
    expect(() => loadApiKey(link, '')).toThrow('key missing');
    expect(() => validateApiKey('sk-ant-oat-fixture-oauth')).toThrow('OAuth');
    expect(() => validateApiKey('short')).toThrow('API key');
    expect(() => loadApiKey(join(dir, 'missing'), '')).toThrow('auth set anthropic');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('serialized Claude admission checks the final context, model, tools and output cap', () => {
  const route = providerRoute('anthropic', undefined, 512);
  const payload = {
    model: route.model,
    stream: true,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'untrusted prompt' },
          { type: 'text', text: 'FRAME' },
        ],
      },
    ],
    tools: [{ name: 'salaam_probe', input_schema: { type: 'object' } }],
  };
  expect(() => validateClaudePayload(payload, route, 'FRAME', ['salaam_probe'])).not.toThrow();
  for (const mutation of [
    { model: 'other' },
    { max_tokens: 513 },
    { stream: false },
    { messages: [{ role: 'user', content: 'User mentions FRAME but it is not the actual frame' }] },
    { tools: [{ name: 'bash' }] },
    { tools: [{ name: 'salaam_probe', type: 'web_search_20250305' }] },
    { fallbacks: [{ model: 'other' }] },
    { messages: [{ role: 'system', content: [{ type: 'tool_addition' }] }, ...payload.messages] },
    { mcp_servers: [] },
    { container: 'external' },
  ])
    expect(() =>
      validateClaudePayload({ ...payload, ...mutation }, route, 'FRAME', ['salaam_probe']),
    ).toThrow();
  expect(() => providerRoute('other')).toThrow('Provider');
  expect(() => providerRoute('anthropic', 'unapproved-model')).toThrow('supports pinned');
  expect(() => providerRoute('anthropic', undefined, 8193)).toThrow('128');
});
test('schema v4 sessions remain pinned to offline, and a live route persists across service restart', () => {
  const dir = mkdtempSync('/tmp/sal-route-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const old = store.create(dir, 'old');
    const epoch = store.allocate(old.id, 'boot');
    store.state(old.id, epoch, 'exited');
    store.db.exec(
      'DROP TABLE compaction_cancellations; DROP TABLE compactions; DROP TABLE task_facts; DROP TABLE task_heads; DROP TABLE session_routes;PRAGMA user_version=4',
    );
    store.close();
    store = new Store(path);
    expect(() => store.bindRoute(old.id, providerRoute('anthropic'))).toThrow(
      'Session provider route differs',
    );
    store.bindRoute(old.id, OFFLINE_ROUTE);
    const live = store.create(dir, 'live'),
      route = providerRoute('anthropic', undefined, 512);
    store.bindRoute(live.id, route);
    store.close();
    store = new Store(path);
    expect(store.providerRoute(live.id)).toEqual(route);
    expect(() => store.bindRoute(live.id, { ...route, max_tokens: 1024 })).toThrow('differs');
    expect(() => store.bindRoute(live.id, OFFLINE_ROUTE)).toThrow('differs');
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
