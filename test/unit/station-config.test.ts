import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  symlinkSync,
  linkSync,
  unlinkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  readStationConfig,
  stationWorkspaceIdentity,
  stationRuntimeFingerprint,
  stationHash,
} from '../../src/agentpod/station-config.js';
import { digest } from '../../src/core/protocol.js';
import { hostApprovalTtlMs, planHost, readHost } from '../../src/host/host.js';
import { Store } from '../../src/store/store.js';

function fixture() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-station-')),
    workspace = join(dir, 'workspace'),
    runtime = join(dir, 'runtime'),
    state = join(dir, 'state');
  for (const p of [workspace, runtime, state]) mkdirSync(p, { mode: 0o700 });
  const executable = join(dir, 'private-helper');
  writeFileSync(executable, 'reviewed synthetic executable\n', { mode: 0o700 });
  const pin = { path: executable, sha256: stationHash(readFileSync(executable)) };
  const value = {
    version: 1,
    kind: 'linux-systemd-station-v1',
    workspace,
    workspace_identity: stationWorkspaceIdentity(workspace),
    files: pin,
    systemd_run: pin,
    systemctl: pin,
    runtime_root: runtime,
    runtime_fingerprint: stationRuntimeFingerprint(runtime),
    runtime_image_digest: 'sha256:' + 'a'.repeat(64),
  };
  const config = join(state, 'station.json');
  writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
  return {
    dir,
    workspace,
    runtime,
    state,
    executable,
    value,
    config,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test('station admission binds private exact config, physical workspace, executable bytes and runtime drift; rollback remains explicit', () => {
  const f = fixture();
  try {
    expect(readStationConfig(f.config, f.workspace, digest(f.value))).toEqual(f.value);
    for (const bad of [
      { ...f.value, version: 2 },
      { ...f.value, network: 'host' },
      { ...f.value, workspace_identity: 'b'.repeat(64) },
      { ...f.value, runtime_image_digest: 'latest' },
    ]) {
      writeFileSync(f.config, JSON.stringify(bad));
      expect(() => readStationConfig(f.config, f.workspace)).toThrow();
    }
    writeFileSync(f.config, JSON.stringify(f.value));
    chmodSync(f.config, 0o644);
    expect(() => readStationConfig(f.config, f.workspace)).toThrow();
    chmodSync(f.config, 0o600);
    const alias = join(f.state, 'alias');
    symlinkSync(f.config, alias);
    expect(() => readStationConfig(alias, f.workspace)).toThrow();
    unlinkSync(alias);
    linkSync(f.config, alias);
    expect(() => readStationConfig(f.config, f.workspace)).toThrow();
    unlinkSync(alias);
    writeFileSync(f.executable, 'partial upgrade');
    expect(() => readStationConfig(f.config, f.workspace)).toThrow();
    writeFileSync(f.executable, 'reviewed synthetic executable\n');
    writeFileSync(join(f.runtime, 'drift'), 'changed');
    expect(() => readStationConfig(f.config, f.workspace)).toThrow();
    unlinkSync(join(f.runtime, 'drift'));
    const reviewed = { ...f.value, runtime_fingerprint: stationRuntimeFingerprint(f.runtime) };
    writeFileSync(f.config, JSON.stringify(reviewed));
    expect(readStationConfig(f.config, f.workspace, digest(reviewed))).toEqual(reviewed);
    renameSync(f.workspace, f.workspace + '-old');
    mkdirSync(f.workspace);
    expect(() => readStationConfig(f.config, f.workspace)).toThrow();
  } finally {
    f.close();
  }
});
test('schema5 is explicit and closed; older host schemas cannot inherit station authority', async () => {
  const f = fixture();
  try {
    const pins = join(f.state, 'pins.json');
    writeFileSync(
      pins,
      JSON.stringify({
        version: 1,
        organization_id: 'org_00000000000000000000',
        node_id: 'node_fixture',
        station_key: 'salaam:' + stationHash(Buffer.from(f.workspace)).slice(0, 16),
        workspace: f.workspace,
      }),
      { mode: 0o600 },
    );
    const input = {
        mode: 'agentpod',
        state: f.state,
        agentpod_config: pins,
        station_config: f.config,
      },
      manifest = await planHost(input),
      file = join(f.state, 'host.json');
    expect(manifest).toMatchObject({
      schema: 5,
      station_execution: { config: f.config, configuration_digest: digest(f.value) },
    });
    writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
    expect(readHost(file)).toEqual(manifest);
    for (const schema of [2, 3, 4]) {
      writeFileSync(file, JSON.stringify({ ...manifest, schema }));
      expect(() => readHost(file)).toThrow();
    }
    writeFileSync(
      file,
      JSON.stringify({
        ...manifest,
        station_execution: { ...(manifest as any).station_execution, network: 'host' },
      }),
    );
    expect(() => readHost(file)).toThrow();
    const strict = await planHost({ ...input, strict_work_version: 1 });
    expect(strict).toMatchObject({
      schema: 6,
      strict_work: { version: 1 },
      station_execution: (manifest as any).station_execution,
    });
    writeFileSync(file, JSON.stringify(strict));
    expect(readHost(file)).toEqual(strict);
    for (const strict_work of [
      { version: 2 },
      { version: '1' },
      { version: 1, extra: true },
      {},
      null,
    ]) {
      writeFileSync(file, JSON.stringify({ ...strict, strict_work }));
      expect(() => readHost(file)).toThrow();
    }
    for (const schema of [2, 3, 4, 5, 7]) {
      writeFileSync(file, JSON.stringify({ ...strict, schema }));
      expect(() => readHost(file)).toThrow();
    }
    const { strict_work: _, ...missing } = strict as any;
    writeFileSync(file, JSON.stringify(missing));
    expect(() => readHost(file)).toThrow();
    writeFileSync(
      file,
      JSON.stringify({
        ...strict,
        station_execution: {
          ...(strict as any).station_execution,
          configuration_digest: 'f'.repeat(64),
        },
      }),
    );
    expect(() => readHost(file)).toThrow();
    for (const strict_work_version of [0, 2, '1', null, true])
      await expect(planHost({ ...input, strict_work_version })).rejects.toThrow('Strict work');
    await expect(
      planHost({ mode: 'agentpod', state: f.state, agentpod_config: pins, strict_work_version: 1 }),
    ).rejects.toThrow('Strict work');
    // Rollback is explicit: the old exact schema5 still validates and does not inherit opt-in.
    writeFileSync(file, JSON.stringify(manifest));
    expect(readHost(file)).not.toHaveProperty('strict_work');
    const leaked = join(f.workspace, 'station.json');
    writeFileSync(leaked, JSON.stringify(f.value), { mode: 0o600 });
    await expect(planHost({ ...input, station_config: leaked })).rejects.toThrow();
    expect(
      await planHost({ mode: 'agentpod', state: f.state, agentpod_config: pins }),
    ).toMatchObject({ schema: 2 });
  } finally {
    f.close();
  }
});
test('v25 migration preserves requests/events and creates empty station ownership; unknown future rejects', () => {
  const f = fixture(),
    file = join(f.state, 'journal.sqlite');
  let store = new Store(file);
  try {
    const session = store.create(f.workspace, 'original'),
      events = store.events(session.id, 0),
      requests = store.db.prepare('SELECT * FROM requests').all();
    store.db.exec(
      'DROP TABLE local_calls; DROP TABLE station_units; DROP TABLE station_calls; PRAGMA user_version=25',
    );
    store.close();
    store = new Store(file);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(27);
    expect(store.db.prepare('SELECT count(*) AS n FROM station_calls').get()!.n).toBe(0);
    expect(store.events(session.id, 0)).toEqual(events);
    expect(store.db.prepare('SELECT * FROM requests').all()).toEqual(requests);
    store.db.exec('PRAGMA user_version=32');
    store.close();
    expect(() => new Store(file)).toThrow('newer than this service');
  } finally {
    try {
      store.close();
    } catch {}
    f.close();
  }
});

test('a strict host may set its approval expiry; it is pinned, bounded and strict-work only', async () => {
  const f = fixture();
  try {
    const pins = join(f.state, 'pins.json');
    writeFileSync(
      pins,
      JSON.stringify({
        version: 1,
        organization_id: 'org_00000000000000000000',
        node_id: 'node_fixture',
        station_key: 'salaam:' + stationHash(Buffer.from(f.workspace)).slice(0, 16),
        workspace: f.workspace,
      }),
      { mode: 0o600 },
    );
    const input = {
      mode: 'agentpod',
      state: f.state,
      agentpod_config: pins,
      station_config: f.config,
      strict_work_version: 1,
    };
    const file = join(f.state, 'host.json');
    const plain = await planHost(input);
    expect(plain).not.toHaveProperty('approval_ttl_ms');
    expect(hostApprovalTtlMs(plain)).toBeUndefined();
    const longer = await planHost({ ...input, approval_ttl_ms: 1800000 });
    expect(longer).toMatchObject({ schema: 6, approval_ttl_ms: 1800000 });
    writeFileSync(file, JSON.stringify(longer), { mode: 0o600 });
    expect(readHost(file)).toEqual(longer);
    expect(hostApprovalTtlMs(readHost(file))).toBe(1800000);
    // Bounded on both sides, and only an integer number of milliseconds.
    for (const approval_ttl_ms of [0, 59999, 86400001, 1800000.5, '1800000', null])
      await expect(planHost({ ...input, approval_ttl_ms })).rejects.toThrow('approval_ttl_ms');
    for (const approval_ttl_ms of [59999, 86400001, '1800000', null]) {
      writeFileSync(file, JSON.stringify({ ...longer, approval_ttl_ms }), { mode: 0o600 });
      expect(() => readHost(file)).toThrow();
    }
    // Only the strict work profile has strict approvals to expire.
    const { strict_work_version: _, ...station } = input;
    await expect(planHost({ ...station, approval_ttl_ms: 1800000 })).rejects.toThrow(
      'approval_ttl_ms',
    );
    const schema5 = await planHost(station);
    writeFileSync(file, JSON.stringify({ ...schema5, approval_ttl_ms: 1800000 }), { mode: 0o600 });
    expect(() => readHost(file)).toThrow();
  } finally {
    f.close();
  }
});
