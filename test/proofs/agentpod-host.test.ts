import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { planHost } from '../../src/host/host.js';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { until } from '../helpers.js';
import { startHost } from '../../src/host/start.js';
import { SalaamService } from '../../src/service/service.js';

const exec = promisify(execFile);
test('concurrent private-runtime startup owns one daemon, restarts a killed child and rejects changed or foreign manifests', async () => {
  const dir = realpathSync(mkdtempSync('/tmp/sahp-'));
  const state = join(dir, 's'),
    workspace = join(dir, 'w'),
    pins = join(dir, 'pins.json'),
    file = join(dir, 'host.json');
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: 'org_00000000000000000001',
      node_id: 'node_host',
      station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
      workspace,
    }),
    { mode: 0o600 },
  );
  const m = await planHost({ mode: 'agentpod', state, agentpod_config: pins });
  writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
  const status = () => JSON.parse(readFileSync(join(state, 'host/status.json'), 'utf8'));
  const start = () =>
    exec(process.execPath, [join(ROOT, 'bin/salaam.mjs'), 'host', 'start', '--manifest', file], {
      env: { PATH: '/usr/bin:/bin', HOME: dir },
      timeout: 25000,
    });
  let supervisor: number | undefined;
  try {
    const receipts = await Promise.all(
      Array.from({ length: 5 }, async () => JSON.parse((await start()).stdout)),
    );
    expect(new Set(receipts.map((r) => r.manifest_digest)).size).toBe(1);
    expect(
      receipts.every(
        (r) =>
          r.ready &&
          r.strict_work === null &&
          r.workspace === workspace &&
          r.node === realpathSync(process.execPath),
      ),
    ).toBe(true);
    supervisor = status().supervisor_pid;
    const processes = (await exec('/bin/ps', ['-Ao', 'pid,args'])).stdout
      .split('\n')
      .filter((line) => line.includes('host run --manifest ' + file));
    expect(processes).toHaveLength(1);
    const first = status().daemon_pid;
    process.kill(first, 'SIGKILL');
    await until(
      () => status(),
      (s) => s.daemon_pid !== first && s.healthy,
      10000,
    );
    await start();
    expect(status().supervisor_pid).toBe(supervisor);
    process.kill(supervisor!, 'SIGKILL');
    await until(async () => {
      try {
        await call(join(state, 'operator.sock'), '/v1/health');
        return false;
      } catch {
        return true;
      }
    }, Boolean);
    await start();
    expect(status().supervisor_pid).not.toBe(supervisor);
    supervisor = status().supervisor_pid;
    writeFileSync(
      file,
      JSON.stringify({
        ...m,
        provider: { provider: 'salaam-proof', model: 'scripted', max_tokens: 2048 },
      }),
    );
    await expect(start()).rejects.toThrow();
    // The running supervisor must notice the change and exit before the manifest is
    // restored; on a loaded host it may otherwise see the restored file and carry on.
    const changed = supervisor!;
    await until(
      () => {
        try {
          process.kill(changed, 0);
          return false;
        } catch {
          return true;
        }
      },
      Boolean,
      20000,
    );
    writeFileSync(file, JSON.stringify({ ...m, build_digest: 'partial-upgrade' }));
    await expect(start()).rejects.toThrow();
    writeFileSync(file, JSON.stringify(m));
    expect(JSON.parse((await start()).stdout).ready).toBe(true);
    const restarted = status().supervisor_pid;
    expect(restarted).not.toBe(changed);
    supervisor = restarted;
    expect(await call<any>(join(state, 'operator.sock'), '/v1/health')).toMatchObject({
      coding_root: null,
      agentpod_pins_digest: (m as any).pins_digest,
    });
  } finally {
    if (!supervisor) {
      try {
        supervisor = status().supervisor_pid;
      } catch {}
    }
    if (supervisor) {
      process.kill(supervisor, 'SIGTERM');
      await until(async () => {
        try {
          await call(join(state, 'operator.sock'), '/v1/health');
          return false;
        } catch {
          return true;
        }
      }, Boolean);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 40000);

test('reviewed startup refuses an independently running daemon in the same private state', async () => {
  const dir = realpathSync(mkdtempSync('/tmp/sahf-'));
  const workspace = join(dir, 'w'),
    state = join(dir, 's'),
    pins = join(dir, 'pins.json'),
    manifest = join(dir, 'host.json');
  mkdirSync(workspace, { mode: 0o700 });
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: 'org_00000000000000000001',
      node_id: 'node_host',
      station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
      workspace,
    }),
    { mode: 0o600 },
  );
  const m = await planHost({ mode: 'agentpod', state, agentpod_config: pins });
  writeFileSync(manifest, JSON.stringify(m), { mode: 0o600 });
  const service = await SalaamService.open({ stateDir: state, agentpodConfig: pins });
  try {
    await expect(startHost(manifest)).rejects.toThrow(/does not match/);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
