import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  chownSync,
  existsSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  stationWorkspaceIdentity,
  stationRuntimeFingerprint,
  stationHash,
} from '../../src/station-config.js';
import { planHost, readHost, resolveOperatorGroup } from '../../src/host.js';
import { startHostUnit } from '../../src/host-start.js';
import { acpClientState } from '../../src/acp.js';
import { SalaamService } from '../../src/service.js';

const root = process.getuid?.() === 0 && process.platform === 'linux';

function fixture() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-launch-')),
    workspace = join(dir, 'workspace'),
    runtime = join(dir, 'runtime'),
    state = join(dir, 'state');
  for (const p of [workspace, runtime, state]) mkdirSync(p, { mode: 0o700 });
  const executable = join(dir, 'private-helper');
  writeFileSync(executable, 'reviewed synthetic executable\n', { mode: 0o700 });
  const pin = { path: executable, sha256: stationHash(readFileSync(executable)) };
  const config = join(state, 'station.json');
  writeFileSync(
    config,
    JSON.stringify({
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
    }),
    { mode: 0o600 },
  );
  const pins = join(state, 'pins.json');
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: 'org_00000000000000000000',
      node_id: 'node_fixture',
      station_key: 'salaam:' + stationHash(Buffer.from(workspace)).slice(0, 16),
      workspace,
    }),
    { mode: 0o600 },
  );
  return {
    dir,
    state,
    input: {
      mode: 'agentpod',
      state,
      agentpod_config: pins,
      station_config: config,
      strict_work_version: 1,
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('operator_group belongs only to a root-planned strict work launcher profile', async () => {
  const f = fixture();
  try {
    const { strict_work_version: _, ...loose } = f.input;
    await expect(planHost({ ...loose, operator_group: 'daemon' })).rejects.toThrow(
      'only for the strict work launcher profile',
    );
    if (!root) {
      await expect(planHost({ ...f.input, operator_group: 'daemon' })).rejects.toThrow(
        'planned by root',
      );
      return;
    }
    for (const operator_group of ['root', '../x', 'no-such-group-x', 7])
      await expect(planHost({ ...f.input, operator_group })).rejects.toThrow('operator_group');
    const group = resolveOperatorGroup('daemon');
    const m = await planHost({ ...f.input, operator_group: 'daemon' });
    expect(m).toMatchObject({ schema: 6, operator_access: group });
    const file = join(f.dir, 'host.json');
    writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
    expect(readHost(file)).toEqual(m);
    // The daemon shares state with that group for traverse only.
    chownSync(f.state, 0, group.gid);
    chmodSync(f.state, 0o710);
    expect(readHost(file)).toEqual(m);
    for (const mode of [0o750, 0o711, 0o730]) {
      chmodSync(f.state, mode);
      expect(() => readHost(file)).toThrow('private owner-held');
    }
    chmodSync(f.state, 0o710);
    chownSync(f.state, 0, 0);
    expect(() => readHost(file)).toThrow('private owner-held');
    chownSync(f.state, 0, group.gid);
    // A manifest without the field never admits group traverse.
    const { operator_access: __, ...plain } = m as any;
    writeFileSync(file, JSON.stringify(plain));
    expect(() => readHost(file)).toThrow('private owner-held');
    for (const operator_access of [
      { ...group, gid: group.gid + 1 },
      { group: 'root', gid: 0 },
      { ...group, extra: 1 },
    ]) {
      writeFileSync(file, JSON.stringify({ ...m, operator_access }));
      expect(() => readHost(file)).toThrow();
    }
  } finally {
    f.close();
  }
});

test('a service refuses operator group access outside the strict work profile', async () => {
  const dir = realpathSync(mkdtempSync('/tmp/sal-launch-svc-'));
  try {
    await expect(
      SalaamService.open({ stateDir: join(dir, 's'), operatorAccess: { group: 'daemon', gid: 1 } }),
    ).rejects.toThrow('launcher profile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unit-start names only a launcher unit, asks systemd once and returns the daemon receipt', async () => {
  const dir = realpathSync(mkdtempSync('/tmp/sal-launch-unit-'));
  const state = join(dir, 'state');
  mkdirSync(state, { mode: 0o700 });
  const marker = join(dir, 'started'),
    calls = join(dir, 'calls'),
    systemctl = join(dir, 'systemctl');
  writeFileSync(systemctl, `#!/bin/sh\necho "$@" >> ${calls}\ntouch ${marker}\n`, { mode: 0o700 });
  const receipt = {
    version: 1,
    ready: true,
    manifest_digest: 'a'.repeat(64),
    state,
    strict_work: { version: 1 },
  };
  let digestOverride: string | undefined;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'healthy',
        host_manifest_digest: digestOverride ?? receipt.manifest_digest,
        host_supervisor_connected: existsSync(marker),
        host_receipt: receipt,
        job_execution: {},
      }),
    );
  });
  await new Promise<void>((r) => server.listen(join(state, 'operator.sock'), r));
  try {
    for (const unit of [
      'salaam.service',
      'salaam-host@x.service',
      'ssh.service',
      'salaam-host@0123456789abcdef.service; id',
    ])
      await expect(startHostUnit(unit, state, { systemctl })).rejects.toThrow('Unit must be');
    const unit = 'salaam-host@0123456789abcdef.service';
    expect(await startHostUnit(unit, state, { systemctl })).toEqual(receipt);
    expect(readFileSync(calls, 'utf8')).toBe(`start --no-ask-password ${unit}\n`);
    // Already running: no second start.
    expect(await startHostUnit(unit, state, { systemctl })).toEqual(receipt);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
    digestOverride = 'b'.repeat(64);
    await expect(startHostUnit(unit, state, { systemctl })).rejects.toThrow('receipt');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP clients of a daemon state they do not own keep their journal in their own state home', () => {
  const dir = realpathSync(mkdtempSync('/tmp/sal-launch-acp-'));
  try {
    const mine = join(dir, 'mine');
    mkdirSync(mine, { mode: 0o700 });
    expect(acpClientState(mine, { HOME: dir })).toBe(mine);
    let foreign = '/';
    if (process.getuid?.() === 0) {
      foreign = join(dir, 'foreign');
      mkdirSync(foreign, { mode: 0o700 });
      chownSync(foreign, 65534, 65534);
    }
    const client = acpClientState(foreign, { XDG_STATE_HOME: join(dir, 'xdg') });
    expect(client.startsWith(join(dir, 'xdg', 'salaam/acp-clients') + '/')).toBe(true);
    expect(statSync(client).mode & 0o777).toBe(0o700);
    expect(acpClientState(foreign, { XDG_STATE_HOME: join(dir, 'xdg') })).toBe(client);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI passes --unit and --state through to unit-start', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { ROOT } = await import('../../src/config.js');
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [join(ROOT, 'bin/salaam.mjs'), ...args]).then(
      () => '',
      (e: { stderr: string }) => e.stderr,
    );
  expect(await run('host', 'unit-start', '--unit', 'ssh.service', '--state', '/tmp')).toContain(
    'Unit must be',
  );
  expect(await run('host', 'unit-start', '--unit', 'ssh.service')).toContain('Supply --unit');
});
