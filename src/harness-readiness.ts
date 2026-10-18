import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerHarnessBoundary } from './harness-container.js';
import { HarnessRpc } from './harness-rpc.js';

/** Real readiness, not an advertised upstream capability. Runs without credentials or model traffic. */
export async function proveHarnessReadiness(
  boundary: DockerHarnessBoundary,
  root: string,
): Promise<void> {
  const dir = mkdtempSync(join(realpathSync(root), 'harness-proof-'));
  for (const p of ['work', 'home', 'runtime']) mkdirSync(join(dir, p), { mode: 0o700 });
  writeFileSync(join(dir, 'host-secret'), 'not-mounted');
  writeFileSync(join(dir, 'runtime/readonly'), 'fixed');
  const run = randomUUID();
  let rpc: HarnessRpc | undefined;
  try {
    const script = `(async()=>{const fs=require('node:fs'),net=require('node:net'),cp=require('node:child_process'),rl=require('node:readline');for await(const line of rl.createInterface({input:process.stdin})){const m=JSON.parse(line);const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};const writeDenied=p=>{try{fs.writeFileSync(p,'bad');return false}catch{return true}};const connect=(host,port)=>new Promise(r=>{const s=net.connect({host,port});s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false));s.setTimeout(500,()=>{s.destroy();r(false)})});fs.writeFileSync('/workspace/owned','ok');const bash=cp.execFileSync('/bin/bash',['-c','printf bash-ok'],{encoding:'utf8'});const response=await fetch('http://127.0.0.1:47123/proof',{method:'POST',body:'proof'});const result={host:denied(${JSON.stringify(join(dir, 'host-secret'))}),socket:denied('/var/run/docker.sock'),runtime:writeDenied('/runtime/readonly'),root:writeDenied('/escape'),bash,interfaces:fs.readdirSync('/sys/class/net'),external:await connect('1.1.1.1',53),metadata:await connect('169.254.169.254',80),other_port:await connect('127.0.0.1',47124),gateway:await response.text(),status:fs.readFileSync('/proc/self/status','utf8')};cp.spawn('/usr/local/bin/node',['-e',"setTimeout(()=>require('node:fs').writeFileSync('/workspace/late','bad'),1500)"],{detached:true,stdio:'ignore'}).unref();process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}})().catch(()=>process.exit(2));`;
    const receipt = await boundary.prepare(
      run,
      join(dir, 'work'),
      join(dir, 'runtime'),
      join(dir, 'home'),
      ['/usr/local/bin/node', '-e', script],
    );
    await boundary.gateway(receipt, async (req) => {
      if (req.path !== '/proof' || req.body.toString() !== 'proof')
        throw Error('Unexpected readiness traffic');
      return { status: 200, body: Buffer.from('host-relay') };
    });
    rpc = new HarnessRpc(await boundary.launchHarness(receipt, 'acp'));
    const proof = await rpc.request('proof', {}, 10000);
    if (
      !proof.host ||
      !proof.socket ||
      !proof.runtime ||
      !proof.root ||
      proof.bash !== 'bash-ok' ||
      proof.external ||
      proof.metadata ||
      proof.other_port ||
      JSON.stringify(proof.interfaces) !== '["lo"]' ||
      proof.gateway !== 'host-relay' ||
      !/NoNewPrivs:\s+1/.test(String(proof.status)) ||
      !/Seccomp:\s+2/.test(String(proof.status)) ||
      !/CapEff:\s+0000000000000000/.test(String(proof.status))
    )
      throw Error('Whole-harness readiness proof failed');
    await rpc.close();
    await boundary.cleanupRun(run);
    await new Promise((r) => setTimeout(r, 1700));
    if (
      existsSync(join(dir, 'work/late')) ||
      readFileSync(join(dir, 'work/owned'), 'utf8') !== 'ok'
    )
      throw Error('Harness descendant stop proof failed');
  } finally {
    await rpc?.close();
    await boundary.cleanupRun(run);
    rmSync(dir, { recursive: true, force: true });
  }
}
