import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { planHost, readHost, hostUnit } from '../../src/host.js';
import { digest } from '../../src/protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/sah-'));
  roots.push(root);
  const workspace = join(root, 'work');
  mkdirSync(workspace, { mode: 0o700 });
  const pins = {
    version: 1,
    organization_id: 'org_00000000000000000001',
    node_id: 'node_fixture',
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
    workspace,
  };
  const config = join(root, 'pins.json');
  writeFileSync(config, JSON.stringify(pins), { mode: 0o600 });
  return {
    root,
    workspace,
    pins,
    config,
    input: { mode: 'agentpod', state: join(root, 'state'), agentpod_config: config },
  };
}

test('AgentPod host planning needs no Docker and binds private runtime, workspace and authority pins', async () => {
  const f = fixture();
  const m = await planHost(f.input);
  expect(m).toMatchObject({
    schema: 2,
    mode: 'agentpod',
    state: f.input.state,
    agentpod_config: f.config,
    workspace: f.workspace,
    pins_digest: digest(f.pins),
  });
  expect(m).not.toHaveProperty('coding_socket');
  const file = join(f.root, 'host.json');
  writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
  expect(readHost(file)).toEqual(m);
  expect(hostUnit(file, 'systemd')).toContain(m.node);
  expect(hostUnit(file, 'launchd')).toContain(m.repo);
  for (const mutation of [
    { extra: 'unreviewed' },
    { node_version: 'v0.0.0' },
    { state: f.workspace },
  ]) {
    writeFileSync(file, JSON.stringify({ ...m, ...mutation }));
    expect(() => readHost(file)).toThrow();
  }
  writeFileSync(file, JSON.stringify(m));
  writeFileSync(f.config, JSON.stringify({ ...f.pins, node_id: 'changed' }));
  expect(() => readHost(file)).toThrow(/pins|changed/i);
});

test('AgentPod startup planning rejects workspace-private overlap, unknown fields and public pins', async () => {
  const f = fixture();
  await expect(planHost({ ...f.input, state: join(f.workspace, 'private') })).rejects.toThrow();
  await expect(planHost({ ...f.input, command: 'arbitrary' })).rejects.toThrow();
  chmodSync(f.config, 0o644);
  await expect(planHost(f.input)).rejects.toThrow(/private|owner-only/i);
});

test('managed MCP requires schema3 and a private authority-bound profile; old hosts cannot opt in by adding fields', async () => {
  const f = fixture(),
    config = join(f.root, 'mcp.json');
  const profile = corpus.profiles[0]!.value;
  writeFileSync(config, JSON.stringify(profile), { mode: 0o600 });
  const m = await planHost({ ...f.input, mcp_config: config });
  expect(m).toMatchObject({
    schema: 3,
    managed_mcp: { config, profile_digest: digest({ profile, pins_digest: digest(f.pins) }) },
  });
  const file = join(f.root, 'host.json');
  writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
  expect(readHost(file)).toEqual(m);
  writeFileSync(file, JSON.stringify({ ...m, schema: 2 }));
  expect(() => readHost(file)).toThrow(/fields/i);
  writeFileSync(file, JSON.stringify(m));
  writeFileSync(
    config,
    JSON.stringify({ ...profile, limits: { ...profile.limits, timeout_ms: 2000 } }),
  );
  expect(() => readHost(file)).toThrow(/profile|changed/i);
  writeFileSync(config, JSON.stringify(profile));
  chmodSync(config, 0o644);
  expect(() => readHost(file)).toThrow(/profile|private/i);
  await expect(planHost({ ...f.input, mcp_config: config })).rejects.toThrow();
});
