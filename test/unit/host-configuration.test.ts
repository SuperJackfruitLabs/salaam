import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { planHost } from '../../src/host/host.js';
import { hostConfiguration } from '../../src/host/configuration.js';
import { acquireStateLock } from '../../src/core/state-lock.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/salaam-config-'));
  roots.push(root);
  const workspace = join(root, 'work');
  mkdirSync(workspace, { mode: 0o700 });
  const stationKey = 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16);
  const pins = join(root, 'pins.json');
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: 'org_00000000000000000001',
      node_id: 'node_fixture',
      station_key: stationKey,
      workspace,
    }),
    { mode: 0o600 },
  );
  const input = { mode: 'agentpod', state: join(root, 'state'), agentpod_config: pins };
  const before = await planHost(input),
    path = join(root, 'manifest.json');
  writeFileSync(path, JSON.stringify(before), { mode: 0o600 });
  const mcp = join(root, 'mcp.json');
  writeFileSync(mcp, JSON.stringify(corpus.profiles[0]!.value), { mode: 0o600 });
  const target = await planHost({ ...input, mcp_config: mcp });
  const request = {
    stationKey,
    operationId: 'review-1',
    want: [{ settingId: 'salaam.host.manifest', value: target }],
  };
  return { root, path, input, before, target, request, stationKey };
}
test('observe, reviewed apply and persisted inspect preserve config.manage v1; apply never starts a daemon', async () => {
  const f = await fixture();
  const observation = await hostConfiguration(f.path, 'observe', {
    stationKey: f.stationKey,
    settings: ['salaam.host.manifest'],
  });
  expect(observation).toEqual({
    values: [{ settingId: 'salaam.host.manifest', readable: true, observed: f.before }],
  });
  const plan = await hostConfiguration(f.path, 'plan', f.request);
  expect(plan).toMatchObject({
    schemaVersion: 1,
    restartRequired: true,
    noOp: false,
    entries: [{ intended: f.target, action: 'modify' }],
  });
  const applied = await hostConfiguration(f.path, 'apply', {
    stationKey: f.stationKey,
    operationId: 'review-1',
    planDigest: plan.planDigest,
  });
  expect(applied).toMatchObject({ phase: 'applied', plan });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(f.target);
  expect(
    await hostConfiguration(f.path, 'inspect', {
      stationKey: f.stationKey,
      operationId: 'review-1',
    }),
  ).toEqual(applied);
  writeFileSync(f.path, 'invalid after apply');
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'review-1',
      planDigest: plan.planDigest,
    }),
  ).toEqual(applied);
});
test('stale bytes, wrong digest and changed source pins are refused; rejected plans cannot apply', async () => {
  const f = await fixture(),
    plan = await hostConfiguration(f.path, 'plan', f.request);
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'review-1',
      planDigest: 'wrong',
    }),
  ).toMatchObject({ phase: 'conflict' });
  writeFileSync(f.path, JSON.stringify(f.before) + '\n');
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'review-1',
      planDigest: plan.planDigest,
    }),
  ).toMatchObject({ phase: 'conflict', error: expect.stringContaining('PLAN_STALE') });
  expect(
    await hostConfiguration(f.path, 'plan', {
      ...f.request,
      operationId: 'unreviewed',
      want: [
        {
          settingId: 'salaam.host.manifest',
          value: { ...f.target, source_digest: '0'.repeat(64) },
        },
      ],
    }),
  ).toMatchObject({ refusal: { code: 'SHAPE_UNEXPECTED' } });
  await expect(
    hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'unreviewed',
      planDigest: 'x',
    }),
  ).rejects.toThrow(/operation/i);
});
test('busy daemon, supervisor and concurrent startup prevent mutation; operation identity cannot be rebound', async () => {
  const f = await fixture(),
    plan = await hostConfiguration(f.path, 'plan', f.request);
  await expect(hostConfiguration(f.path, 'plan', { ...f.request, want: [] })).rejects.toThrow(
    /reused|identity/i,
  );
  for (const dir of [f.input.state, join(f.input.state, 'host'), join(f.input.state, 'startup')]) {
    const release = acquireStateLock(dir);
    try {
      await expect(
        hostConfiguration(f.path, 'apply', {
          stationKey: f.stationKey,
          operationId: 'review-1',
          planDigest: plan.planDigest,
        }),
      ).rejects.toThrow(/owns|locked/i);
    } finally {
      release();
    }
    expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(f.before);
  }
});
test('partial apply is inspectable and completes from saved bytes; unexpected bytes are never rolled back', async () => {
  const f = await fixture(),
    plan = await hostConfiguration(f.path, 'plan', f.request);
  const journal = join(f.root, '.agentpod', 'manifest.json.configuration', 'operations.json');
  const records = JSON.parse(readFileSync(journal, 'utf8'));
  records['review-1'].receipt.phase = 'applying';
  writeFileSync(journal, JSON.stringify(records));
  writeFileSync(f.path, records['review-1'].target);
  expect(
    await hostConfiguration(f.path, 'inspect', {
      stationKey: f.stationKey,
      operationId: 'review-1',
    }),
  ).toMatchObject({ phase: 'applying' });
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'review-1',
      planDigest: plan.planDigest,
    }),
  ).toMatchObject({ phase: 'applied' });
  const rollback = await hostConfiguration(f.path, 'plan', {
    ...f.request,
    operationId: 'rollback-reviewed',
    want: [{ settingId: 'salaam.host.manifest', value: f.before }],
  });
  expect(rollback).toMatchObject({ restartRequired: true });
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'rollback-reviewed',
      planDigest: rollback.planDigest,
    }),
  ).toMatchObject({ phase: 'applied' });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(f.before);
  const broken = await hostConfiguration(f.path, 'plan', {
    ...f.request,
    operationId: 'interrupted',
  });
  const changed = JSON.parse(readFileSync(journal, 'utf8'));
  changed.interrupted.receipt.phase = 'applying';
  writeFileSync(journal, JSON.stringify(changed));
  writeFileSync(f.path, 'foreign newer bytes');
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'interrupted',
      planDigest: broken.planDigest,
    }),
  ).toMatchObject({ phase: 'conflict' });
  expect(readFileSync(f.path, 'utf8')).toBe('foreign newer bytes');
});

test('stale dependency pins, unknown settings, identity rebinds and foreign requests fail closed', async () => {
  const f = await fixture();
  for (const mutation of [
    { workspace: join(f.root, 'elsewhere') },
    { state: join(f.root, 'other-state') },
    { node_version: 'v0.0.0' },
    { cli_digest: '0'.repeat(64) },
    { extra: true },
  ]) {
    expect(
      await hostConfiguration(f.path, 'plan', {
        ...f.request,
        want: [{ settingId: 'salaam.host.manifest', value: { ...f.target, ...mutation } }],
      }),
    ).toMatchObject({ refusal: { code: 'SHAPE_UNEXPECTED' } });
  }
  expect(
    await hostConfiguration(f.path, 'plan', {
      ...f.request,
      want: [{ settingId: 'credentials', value: 42 }],
    }),
  ).toMatchObject({ refusal: { code: 'UNKNOWN_SETTING' } });
  const plan = await hostConfiguration(f.path, 'plan', f.request);
  await expect(
    hostConfiguration(f.path, 'inspect', { stationKey: 'salaam:foreign', operationId: 'review-1' }),
  ).rejects.toThrow(/another station/);
  const mcp = join(f.root, 'mcp.json'),
    profile = JSON.parse(readFileSync(mcp, 'utf8'));
  profile.limits.timeout_ms = 2000;
  writeFileSync(mcp, JSON.stringify(profile));
  expect(
    await hostConfiguration(f.path, 'apply', {
      stationKey: f.stationKey,
      operationId: 'review-1',
      planDigest: plan.planDigest,
    }),
  ).toMatchObject({ phase: 'conflict', error: expect.stringContaining('PLAN_STALE') });
  expect(JSON.parse(readFileSync(f.path, 'utf8'))).toEqual(f.before);
});

test('actual native CLI commands round trip persisted operation across processes', async () => {
  const { spawnSync } = await import('node:child_process');
  const f = await fixture();
  const cli = (action: string, request: unknown) => {
    const result = spawnSync(
      process.execPath,
      ['bin/salaam.mjs', 'host', 'config-' + action, '--manifest', f.path],
      {
        input: JSON.stringify(request),
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: f.root, LANG: 'en_US.UTF-8' },
        timeout: 20000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(
    cli('observe', { stationKey: f.stationKey, settings: ['salaam.host.manifest'] }),
  ).toMatchObject({ values: [{ readable: true }] });
  const plan = cli('plan', f.request),
    request = { stationKey: f.stationKey, operationId: 'review-1', planDigest: plan.planDigest };
  const applied = cli('apply', request);
  expect(applied).toMatchObject({ phase: 'applied' });
  expect(cli('inspect', { stationKey: f.stationKey, operationId: 'review-1' })).toEqual(applied);
  expect(cli('apply', request)).toEqual(applied);
});
