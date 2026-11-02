import { test, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DockerHarnessBoundary } from '../../src/harness/container.js';
import { DockerCodingExecutor } from '../../src/coding/executor.js';
import { engineRequest } from '../../src/execution/boundary.js';
import { HarnessRpc } from '../../src/harness/rpc.js';
import { ROOT } from '../../src/core/config.js';
import { hostDigests } from '../../src/core/config.js';

test('whole harness: actual filesystem, descendant and network confinement with an isolated loopback gateway', async () => {
  const socket = process.env.SALAAM_TASK_REAL_SOCKET,
    scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
  if (!socket || !scratch) throw Error('Select the pre-provisioned real executor');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const docker = realpathSync(
    process.env.SALAAM_HARNESS_DOCKER ??
      (process.platform === 'darwin' ? '/opt/homebrew/bin/docker' : '/usr/bin/docker'),
  );
  const dir = mkdtempSync(join(realpathSync(scratch), 'm16-real-')),
    workspace = join(dir, 'workspace'),
    runtime = join(dir, 'runtime'),
    home = join(dir, 'home');
  for (const d of [workspace, runtime, home]) mkdirSync(d, { mode: 0o700 });
  writeFileSync(join(dir, 'host-secret'), 'fixture-secret-not-mounted', { mode: 0o600 });
  writeFileSync(join(runtime, 'read-only'), 'runtime-bytes');
  const engine = engineRequest(socket),
    executor = new DockerCodingExecutor(engine),
    run = randomUUID();
  const evidence: any = {
    schema_version: 1,
    success: false,
    scope:
      'Real Linux whole-process confinement and stdio gateway, deterministic peer; no named external harness or live-model claim',
    ...hostDigests(),
  };
  let boundary: DockerHarnessBoundary | undefined,
    receipt: Awaited<ReturnType<DockerHarnessBoundary['prepare']>> | undefined,
    rpc: HarnessRpc | undefined;
  try {
    evidence.executor = await executor.prepare(realpathSync(scratch));
    boundary = new DockerHarnessBoundary(engine, executor.engineId, {
      executable: docker,
      digest: createHash('sha256').update(readFileSync(docker)).digest('hex'),
      socket,
    });
    const script = `(async()=>{const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),rl=require('node:readline');async function probe(){const outcomes={};for(const [k,fn]of Object.entries({workspace:()=>{fs.writeFileSync('/workspace/result','owned-write');return fs.readFileSync('/workspace/result','utf8')},home:()=>{fs.writeFileSync('/home/agent/private','home-write');return true},runtime_write:()=>fs.writeFileSync('/runtime/read-only','escape'),root_write:()=>fs.writeFileSync('/root-escape','escape'),host_read:()=>fs.readFileSync(${JSON.stringify(join(dir, 'host-secret'))},'utf8'),socket_read:()=>fs.statSync('/var/run/docker.sock'),parent_read:()=>fs.readFileSync('/workspace/../host-secret','utf8')})){try{outcomes[k]={allowed:true,value:fn()}}catch(e){outcomes[k]={allowed:false,code:e.code}}}outcomes.network_interfaces=fs.readdirSync('/sys/class/net');outcomes.status=fs.readFileSync('/proc/self/status','utf8');async function connect(host,port){return new Promise(r=>{const s=net.connect({host,port});s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.setTimeout(1000,()=>{s.destroy();r(false)})})}outcomes.denied_network=await Promise.all([connect('1.1.1.1',53),connect('169.254.169.254',80),connect('127.0.0.1',47124)]);const response=await fetch('http://127.0.0.1:47123/fixture',{method:'POST',headers:{'x-api-key':'ephemeral-fixture'},body:'bounded request'});outcomes.gateway=await response.json();cp.spawn('/usr/local/bin/node',['-e',"setTimeout(()=>require('fs').writeFileSync('/workspace/escaped-descendant','bad'),4000)"],{detached:true,stdio:'ignore'}).unref();return outcomes;}for await(const line of rl.createInterface({input:process.stdin})){const m=JSON.parse(line);const result=await probe();process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}})().catch(()=>process.exit(2));`;
    receipt = await boundary.prepare(run, workspace, runtime, home, [
      '/usr/local/bin/node',
      '-e',
      script,
    ]);
    evidence.receipt = receipt;
    let calls = 0;
    await boundary.gateway(receipt, async (request) => {
      expect(request).toMatchObject({
        method: 'POST',
        path: '/fixture',
        headers: { 'x-api-key': 'ephemeral-fixture' },
      });
      expect(request.body.toString()).toBe('bounded request');
      calls++;
      return { status: 200, body: Buffer.from('{"receipt":"host-only-handler"}') };
    });
    rpc = new HarnessRpc(await boundary.launchHarness(receipt, 'acp'));
    const result = await rpc.request('boundary/probe', {}, 15000);
    evidence.probe = result;
    expect(calls).toBe(1);
    expect(result.workspace).toEqual({ allowed: true, value: 'owned-write' });
    expect(result.home).toMatchObject({ allowed: true });
    for (const key of ['runtime_write', 'root_write', 'host_read', 'socket_read', 'parent_read'])
      expect(result[key], key).toMatchObject({ allowed: false });
    expect(result.network_interfaces).toEqual(['lo']);
    expect(result.denied_network).toEqual([false, false, false]);
    expect(result.gateway).toEqual({ receipt: 'host-only-handler' });
    expect(result.status).toMatch(/CapEff:\s+0000000000000000/);
    expect(result.status).toMatch(/NoNewPrivs:\s+1/);
    expect(result.status).toMatch(/Seccomp:\s+2/);
    await rpc.close();
    await boundary.cleanup(receipt);
    await new Promise((r) => setTimeout(r, 4200));
    expect(existsSync(join(workspace, 'escaped-descendant'))).toBe(false);
    expect(readFileSync(join(dir, 'host-secret'), 'utf8')).toBe('fixture-secret-not-mounted');
    expect(readFileSync(join(runtime, 'read-only'), 'utf8')).toBe('runtime-bytes');
    for (const id of [receipt.gateway, receipt.harness])
      expect((await engine('GET', `/containers/${id}/json`)).status).toBe(404);
    evidence.cleanup_confirmed = true;
    evidence.success = true;
  } finally {
    await rpc?.close();
    if (boundary && receipt) await boundary.cleanup(receipt);
    const path = resolve(
      process.env.SALAAM_HARNESS_REAL_REPORT ??
        join(ROOT, '.state/evidence/m16/whole-process-local.json'),
    );
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
    rmSync(dir, { recursive: true, force: true });
  }
});
