import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SalaamService } from '../../src/service.js';
import { ROOT } from '../../src/config.js';
import { until } from '../helpers.js';
import type { ToolkitResource } from '../../src/toolkit-resources.js';
import { processIdentity } from '../../src/supervisor.js';
import { acquireStateLock } from '../../src/state-lock.js';

for (const role of ['execution', 'cleanup'] as const)
  test(`actual daemon SIGKILL recovers its recorded ${role} process before a new lease can execute`, async () => {
    const base = realpathSync(mkdtempSync('/tmp/str-crash-')),
      workspace = join(base, 'workspace'),
      state = join(base, 'state'),
      pins = join(base, 'pins.json'),
      peer = join(base, 'peer.mjs');
    mkdirSync(workspace, { mode: 0o700 });
    const binding = {
      version: 1,
      organization_id: 'org_00000000000000000001',
      principal_id: 'prn_00000000000000000002',
      node_id: 'node_fixture',
      station_id: 'station_fixture',
      station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
      occupancy_epoch: 1,
      hub_session_id: 'acps_resource_fixture',
      workspace,
      run: { source: 'agentpod', id: 'run_resource_fixture', epoch: 1 },
    };
    const { version, organization_id, node_id, station_key } = binding;
    writeFileSync(
      pins,
      JSON.stringify({ version, organization_id, node_id, station_key, workspace }),
      { mode: 0o600 },
    );
    writePeer(peer);
    const config = join(base, 'fixture.json');
    writeFileSync(
      config,
      JSON.stringify({
        base,
        state,
        pins,
        peer,
        binding,
        mode: role === 'cleanup' ? 'control' : undefined,
      }),
      { mode: 0o600 },
    );
    const daemon = fork(join(ROOT, 'test/fixtures/toolkit-resource-service.mjs'), [config], {
      env: { PATH: process.env.PATH, HOME: base },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(daemon, 'exit');
    let diagnostic = '';
    daemon.stderr!.on('data', (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-8192);
    });
    let service: SalaamService | undefined;
    let brokerPid: number | undefined;
    let brokerIdentity: string | null = null;
    try {
      const ready = once(daemon, 'message') as Promise<
        [{ resource: ToolkitResource; session_id: string }]
      >;
      let timer: NodeJS.Timeout | undefined;
      const message = await Promise.race([
        ready,
        exited.then(() => {
          throw Error('fixture daemon exited: ' + diagnostic);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('fixture daemon did not register broker')), 10000);
        }),
      ]).finally(() => clearTimeout(timer));
      const initial = message[0];
      brokerPid = initial.resource.pid!;
      brokerIdentity = initial.resource.identity;
      expect(initial.resource.state).toBe('running');
      expect(initial.resource.identity).toBeTruthy();
      daemon.kill('SIGKILL');
      await exited;
      // The peer deliberately survives stdin EOF. Recovery must inspect and stop it.
      expect(() => process.kill(brokerPid!, 0)).not.toThrow();
      service = await SalaamService.open({ stateDir: state, agentpodConfig: pins });
      const saved = service.toolkitResources.get(initial.resource.id);
      expect(saved).toMatchObject({
        session_id: initial.session_id,
        state: 'stopped',
        pid: brokerPid,
      });
      expect(service.toolkitResources.stopProof(saved.id)).toMatchObject({
        scope: 'local_process_group',
        resource_id: saved.id,
        pid: brokerPid,
        method: 'observed_exit',
      });
      await until(() => {
        try {
          process.kill(brokerPid!, 0);
          return false;
        } catch {
          return true;
        }
      }, Boolean);
      expect(service.agentpod!.inspect(binding)).toMatchObject({
        session_id: initial.session_id,
        authorized: false,
        owned_execution_stopped: true,
      });
      service.agentpod!.renew(binding, 'new-daemon-lease', 2);
      expect(service.agentpod!.inspect(binding)).toMatchObject({
        authorized: true,
        owned_execution_stopped: true,
      });
      expect(service.store.db.prepare('SELECT count(*) AS n FROM toolkit_resources').get()!.n).toBe(
        role === 'cleanup' ? 2 : 1,
      );
      expect(
        service.store
          .events(initial.session_id, 0)
          .filter((e) => e.kind === 'toolkit.resource.running'),
      ).toHaveLength(role === 'cleanup' ? 2 : 1);
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      await exited;
      await service?.close();
      if (brokerPid && brokerIdentity && processIdentity(brokerPid) === brokerIdentity) {
        try {
          process.kill(-brokerPid, 'SIGKILL');
        } catch {}
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

for (const role of ['execution', 'cleanup'] as const)
  test(`actual daemon loss before ${role} PID persistence cannot renew, dispatch or release unconfirmed ownership`, async () => {
    const base = realpathSync(mkdtempSync('/tmp/str-unknown-')),
      workspace = join(base, 'workspace'),
      state = join(base, 'state'),
      pins = join(base, 'pins.json');
    mkdirSync(workspace, { mode: 0o700 });
    const binding = {
      version: 1,
      organization_id: 'org_00000000000000000001',
      principal_id: 'prn_00000000000000000002',
      node_id: 'node_fixture',
      station_id: 'station_fixture',
      station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
      occupancy_epoch: 1,
      hub_session_id: 'acps_resource_unknown',
      workspace,
      run: { source: 'agentpod', id: 'run_unknown_fixture', epoch: 1 },
    };
    const { version, organization_id, node_id, station_key } = binding;
    writeFileSync(
      pins,
      JSON.stringify({ version, organization_id, node_id, station_key, workspace }),
      { mode: 0o600 },
    );
    const config = join(base, 'fixture.json'),
      peer = join(base, 'peer.mjs');
    writePeer(peer);
    writeFileSync(
      config,
      JSON.stringify({
        base,
        state,
        pins,
        peer,
        binding,
        mode: role === 'cleanup' ? 'unrecorded-control' : 'unrecorded',
      }),
      { mode: 0o600 },
    );
    const launch = () => {
      const child = fork(join(ROOT, 'test/fixtures/toolkit-resource-service.mjs'), [config], {
        env: { PATH: process.env.PATH, HOME: base },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      child.stderr!.resume();
      const exit = once(child, 'exit');
      return { child, exit };
    };
    const original = launch();
    let probe: ReturnType<typeof launch> | undefined;
    try {
      const [message] = (await once(original.child, 'message')) as [{ resource: ToolkitResource }];
      expect(message.resource).toMatchObject({ state: 'launching', pid: null, identity: null });
      original.child.kill('SIGKILL');
      await original.exit;
      writeFileSync(
        config,
        JSON.stringify({
          base,
          state,
          pins,
          binding,
          mode: 'probe',
          targetResource: role === 'cleanup' ? 'daemon-control-resource' : undefined,
        }),
        {
          mode: 0o600,
        },
      );
      probe = launch();
      const [result] = (await once(probe.child, 'message')) as [
        {
          resource: ToolkitResource;
          renewError: string;
          executionError: string;
          shutdownFailed: boolean;
          authorized: boolean;
          stopped: boolean;
        },
      ];
      expect(result).toMatchObject({
        resource: { state: 'unconfirmed', pid: null, stop_digest: null },
        renewError: 'toolkit_resources_unconfirmed',
        executionError: 'authority_expired',
        shutdownFailed: true,
        authorized: false,
        stopped: false,
      });
      expect(() => acquireStateLock(state)).toThrow('Another Salaam service');
      probe.child.kill('SIGKILL');
      await probe.exit;
      const release = acquireStateLock(state);
      release();
    } finally {
      if (original.child.exitCode === null && original.child.signalCode === null)
        original.child.kill('SIGKILL');
      await original.exit;
      if (probe) {
        if (probe.child.exitCode === null && probe.child.signalCode === null)
          probe.child.kill('SIGKILL');
        await probe.exit;
      }
      rmSync(base, { recursive: true, force: true });
    }
  });

function writePeer(file: string): void {
  writeFileSync(
    file,
    `#!${realpathSync(process.execPath)}
import readline from 'node:readline';import {writeFileSync} from 'node:fs';import {join} from 'node:path';
if(process.argv[2]==='managed-control-v1'){
 const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{writeFileSync(join(process.env.HOME,'control-input'),Buffer.concat(chunks));});
}else{
 readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'owned-peer',version:'1'}}})+'\\n');});
}
setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
}
