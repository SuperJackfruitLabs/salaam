import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  symlinkSync,
  linkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planHost, readHost } from '../../src/host.js';
import { readToolkitConfig } from '../../src/toolkit-config.js';
import { ROOT } from '../../src/config.js';
import { digest } from '../../src/protocol.js';
import { call } from '../../src/transport.js';
import { until } from '../helpers.js';
import { toolkitServiceFixture } from '../toolkit-service-helpers.js';
import { processIdentity } from '../../src/supervisor.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };

const exec = promisify(execFile);
test('private native config drift denies the next approval before the host poll and still permits cleanup', async () => {
  const f = await toolkitServiceFixture('normal', true);
  try {
    await f.service.supervisor.start(f.session);
    await until(
      () => f.service.supervisor.inspect(f.session).state,
      (s) => s === 'ready',
    );
    await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'write',
      arguments: { title: 'Synthetic' },
    });
    const approval = await until(
      () => f.service.store.approvals(f.session).find((a) => a.state === 'pending'),
      Boolean,
    );
    const op = f.service.managed.operation(approval!.operation_id);
    writeFileSync(
      f.configPath,
      JSON.stringify({
        version: 1,
        ...f.config,
        catalog: { ...f.config.catalog, catalog_digest: '0'.repeat(64) },
      }),
    );
    expect(() =>
      f.service.managed.decide(
        approval!.id,
        randomUUID(),
        approval!.revision,
        op.operation_digest,
        'approve',
      ),
    ).toThrow();
    expect(f.lines('effects.jsonl')).toEqual([]);
    await until(() => f.service.toolkitResources.stopped(f.session), Boolean);
    expect(f.service.store.hasUnknown(f.session)).toBe(false);
    expect(f.service.supervisor.inspect(f.session).state).not.toBe('ready');
  } finally {
    await f.close();
  }
});
test('native host schema4 pins private versioned config; old/partial/public/changed references fail before launch', async () => {
  const f = await toolkitServiceFixture(),
    config = join(f.state, 'toolkit.json'),
    file = join(f.state, 'host.json'),
    value = { version: 1, ...f.config };
  try {
    writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
    const input = {
        mode: 'agentpod',
        state: f.state,
        agentpod_config: join(f.state, 'pins.json'),
        toolkit_config: config,
      },
      m = await planHost(input);
    expect(m).toMatchObject({
      schema: 4,
      managed_toolkit: { config, configuration_digest: digest(f.config) },
    });
    writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
    expect(readHost(file)).toEqual(m);
    const http = join(f.state, 'http-mcp.json');
    writeFileSync(http, JSON.stringify(corpus.profiles[0]!.value), { mode: 0o600 });
    const mixed = await planHost({ ...input, mcp_config: http });
    expect(mixed).toMatchObject({
      schema: 4,
      managed_mcp: { config: http },
      managed_toolkit: { config },
    });
    writeFileSync(file, JSON.stringify(mixed));
    expect(readHost(file)).toEqual(mixed);
    writeFileSync(file, JSON.stringify(m));
    for (const schema of [2, 3]) {
      writeFileSync(file, JSON.stringify({ ...m, schema }));
      expect(() => readHost(file)).toThrow();
    }
    const { managed_toolkit: _native, ...withoutNative } = m as any;
    writeFileSync(file, JSON.stringify({ ...withoutNative, schema: 3 }));
    expect(() => readHost(file)).toThrow();
    writeFileSync(file, JSON.stringify(m));
    for (const bad of [
      { ...value, version: 2 },
      { ...value, command: '/bin/sh' },
      { ...value, catalog: { ...value.catalog, catalog_digest: '0'.repeat(64) } },
    ]) {
      writeFileSync(config, JSON.stringify(bad));
      expect(() => readHost(file)).toThrow();
    }
    writeFileSync(config, JSON.stringify(value));
    const profile = readFileSync(f.profilePath);
    writeFileSync(f.profilePath, 'partial upgrade');
    expect(() => readHost(file)).toThrow();
    writeFileSync(f.profilePath, profile);
    expect(readHost(file)).toEqual(m);
    chmodSync(config, 0o644);
    expect(() => readHost(file)).toThrow();
    chmodSync(config, 0o600);
    const link = join(f.state, 'alias.json');
    symlinkSync(config, link);
    expect(() => readToolkitConfig(link)).toThrow();
    unlinkSync(link);
    linkSync(config, link);
    expect(() => readToolkitConfig(config)).toThrow();
    unlinkSync(link);
    expect(readToolkitConfig(config)).toEqual(f.config);
    const leaked = join(f.workspace, 'toolkit.json');
    writeFileSync(leaked, JSON.stringify(value), { mode: 0o600 });
    await expect(planHost({ ...input, toolkit_config: leaked })).rejects.toThrow();
    // Static planning is not protocol readiness and cannot create native resources.
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_resources').get()!.n).toBe(
      0,
    );
  } finally {
    await f.close();
  }
});

test('normal CLI cold startup applies schema4 native tools before actual Pi and observes config drift', async () => {
  const f = await toolkitServiceFixture(),
    config = join(f.state, 'toolkit.json'),
    file = join(f.state, 'host.json'),
    socket = join(f.state, 'operator.sock');
  let supervisor: number | undefined;
  const status = () => JSON.parse(readFileSync(join(f.state, 'host/status.json'), 'utf8'));
  const stopped = async () => {
    try {
      await call(socket, '/v1/health');
      return false;
    } catch {
      return true;
    }
  };
  try {
    await f.service.close();
    const text = JSON.stringify({ version: 1, ...f.config });
    writeFileSync(config, text, { mode: 0o600 });
    const m = await planHost({
      mode: 'agentpod',
      state: f.state,
      agentpod_config: join(f.state, 'pins.json'),
      toolkit_config: config,
    });
    writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
    const start = () =>
      exec(process.execPath, [join(ROOT, 'bin/salaam.mjs'), 'host', 'start', '--manifest', file], {
        env: { PATH: '/usr/bin:/bin', HOME: f.dir },
        timeout: 25000,
      });
    const receipts = await Promise.all([start(), start(), start()]);
    expect(receipts.every((r) => JSON.parse(r.stdout).ready)).toBe(true);
    supervisor = status().supervisor_pid;
    const health = await call<any>(socket, '/v1/health');
    expect(health.managed_toolkit).toEqual({ configuration_digest: digest(f.config) });
    await call(socket, '/v1/agentpod/renew', {
      request_id: randomUUID(),
      lease_sequence: 2,
      binding: f.binding,
    });
    const view = await call<any>(socket, `/v1/sessions/${f.session}/snapshot`),
      client = 'native-host-fixture',
      control = await call<any>(socket, `/v1/sessions/${f.session}/control`, {
        request_id: randomUUID(),
        client_id: client,
        action: 'takeover',
        expected_epoch: view.control.epoch,
      });
    await call(socket, `/v1/sessions/${f.session}/resume`, {
      client_id: client,
      token: control.token,
    });
    const session = await until(
      () => call<any>(socket, `/v1/sessions/${f.session}`),
      (s) => s.state === 'ready',
    );
    expect(session.capabilities).toContain('managed-toolkit-v1');
    const work = await call<any>(socket, `/v1/sessions/${f.session}/submissions`, {
      request_id: randomUUID(),
      expected_revision: session.revision,
      client_id: client,
      token: control.token,
      text:
        '[toolkit] ' +
        JSON.stringify({ action: 'call', category: 'fixture', name: 'read', arguments: {} }),
    });
    await until(
      () => call<any>(socket, `/v1/attempts/${work.attempt_id}`),
      (a) => a.state === 'completed',
    );
    expect(f.lines('effects.jsonl')).toHaveLength(1);
    writeFileSync(
      config,
      JSON.stringify({
        ...JSON.parse(text),
        catalog: { ...f.config.catalog, catalog_digest: '0'.repeat(64) },
      }),
    );
    await expect(start()).rejects.toThrow();
    await until(stopped, Boolean, 10000);
    writeFileSync(config, text);
    expect(JSON.parse((await start()).stdout).ready).toBe(true);
    supervisor = status().supervisor_pid;
  } finally {
    if (!supervisor && existsSync(join(f.state, 'host/status.json')))
      supervisor = status().supervisor_pid;
    if (supervisor) {
      const identity = processIdentity(supervisor);
      if (identity) {
        if (!identity.includes(file)) throw Error('Owned host supervisor identity changed');
        try {
          process.kill(supervisor, 'SIGTERM');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
        await until(() => processIdentity(supervisor!) !== identity, Boolean, 10000);
      }
    }
    await until(stopped, Boolean, 10000);
    await f.close();
  }
}, 45000);
