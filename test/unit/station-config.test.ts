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
} from '../../src/station-config.js';
import { digest } from '../../src/protocol.js';
import { planHost, readHost } from '../../src/host.js';
import { Store } from '../../src/store.js';

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
    store.db.exec('PRAGMA user_version=31');
    store.close();
    expect(() => new Store(file)).toThrow('newer than this service');
  } finally {
    try {
      store.close();
    } catch {}
    f.close();
  }
});
