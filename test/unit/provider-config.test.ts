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
      'DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; DROP TABLE job_occurrences; DROP TABLE jobs; DROP TABLE task_compactions; DROP TABLE task_grants; DROP TABLE task_restores; DROP TABLE task_mutations; DROP TABLE task_checkpoints; DROP TABLE task_completions; DROP TABLE task_checks; DROP TABLE task_reservations; DROP TABLE task_runtime; DROP TABLE task_step_attempts; DROP TABLE task_steps; DROP TABLE task_plans; DROP TABLE durable_tasks; DROP TABLE compaction_cancellations; DROP TABLE compactions; DROP TABLE task_facts; DROP TABLE task_heads; DROP TABLE session_routes;PRAGMA user_version=4',
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
    expect(store.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 24 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolved endpoints bind before first dispatch and reject endpoint or environment drift', async () => {
  const { bindProviderConfiguration } = await import('../../src/provider-model.js');
  const { InMemoryCredentialStore } = await import('@earendil-works/pi-ai');
  const { resolveProviderAuth } = await import('../../src/provider-auth.js');
  const route = providerRoute('openai', 'gpt-4', 512);
  const bound = bindProviderConfiguration(route, { auth: { apiKey: 'sk-fixture' } });
  expect(bound.connection?.endpoint).toBe('https://api.openai.com/v1');
  expect(() =>
    bindProviderConfiguration(bound, { auth: { baseUrl: 'https://other.invalid/v1' } }),
  ).toThrow('configuration changed');
  expect(() =>
    providerRoute('openai', 'gpt-4', 512, undefined, {
      endpoint: 'https://api.openai.com/v1',
      configuration: { HOME: '/foreign' },
    }),
  ).toThrow('Unsupported provider configuration');
  const azure = bindProviderConfiguration(providerRoute('azure', 'gpt-4', 512), {
    auth: { apiKey: 'fixture' },
    env: { AZURE_OPENAI_RESOURCE_NAME: 'fixture' },
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify('azure', async () => ({ type: 'api_key', key: 'fixture-key' }));
  const restored = await resolveProviderAuth(azure, credentials, {});
  expect(bindProviderConfiguration(azure, restored)).toEqual(azure);
  expect(JSON.stringify(azure)).not.toContain('fixture-key');
});
