import { createHash, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { SalaamService } from '../src/service/service.js';
import { digest } from '../src/core/protocol.js';
import { mcpCatalogDigest } from '../src/mcp/http.js';
import { call } from '../src/core/transport.js';
import { PiProcess } from '../src/runtime/pi.js';
import type { ToolkitWorkConfig } from '../src/toolkit/work.js';
import corpus from './fixtures/agentpod-mcp-v1.json' with { type: 'json' };

export async function toolkitServiceFixture(mode = 'normal', privateConfig = false) {
  const dir = realpathSync(mkdtempSync('/tmp/tks-')),
    workspace = join(dir, 'workspace'),
    state = join(dir, 'private');
  for (const p of [workspace, state]) mkdirSync(p, { mode: 0o700 });
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  const binding = {
      ...corpus.assignments[0]!.value.binding,
      workspace,
      station_key: 'salaam:' + sha(workspace).slice(0, 16),
    },
    { version, organization_id, node_id, station_key } = binding;
  const pins = join(state, 'pins.json'),
    executable = join(state, 'peer'),
    policy = join(state, 'policy.yaml'),
    pass = join(state, 'pass'),
    store = join(state, 'credentials'),
    native = join(state, 'native'),
    manifestPath = join(state, 'manifest.json'),
    profilePath = join(state, 'profile.json');
  writeFileSync(
    pins,
    JSON.stringify({ version, organization_id, node_id, station_key, workspace }),
    { mode: 0o600 },
  );
  for (const p of [store, native]) mkdirSync(p, { mode: 0o700 });
  const tools = [
    'discover_server_categories',
    'get_category_actions',
    'get_action_details',
    'execute_action',
  ].map((name) => ({
    name,
    description: 'Synthetic native catalogue fixture',
    inputSchema: { type: 'object', properties: {} },
  }));
  const details = [
    {
      category: 'fixture',
      action: 'read',
      summary: 'Synthetic read',
      params: null,
      kind: 'read',
      policy: 'agent',
    },
    {
      category: 'fixture',
      action: 'write',
      summary: 'Synthetic reviewed write',
      params: [
        { Name: 'title', Required: true, In: 1, Slashes: false, Summary: 'Synthetic title' },
      ],
      kind: 'write',
      policy: 'approval',
    },
  ];
  writeFileSync(join(state, 'mode'), mode, { mode: 0o600 });
  // A disposable SDK/private-callback producer fixture, not the real Go broker.
  // Actual compiled producer acceptance is recorded separately.
  writeFileSync(
    executable,
    `#!${realpathSync(process.execPath)}
import readline from 'node:readline';import http from 'node:http';import {createHash} from 'node:crypto';import {readFileSync,appendFileSync} from 'node:fs';import {join} from 'node:path';
const manifest=JSON.parse(readFileSync(process.argv[4],'utf8')),tools=${JSON.stringify(tools)},details=${JSON.stringify(details)};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v,hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
const verify=(phase,request)=>new Promise((resolve,reject)=>{
 const req=http.request({socketPath:manifest.owner_socket,path:'/managed-toolkit/v1/verify',method:'POST',headers:{authorization:'Bearer '+manifest.owner_key,'content-type':'application/json'}},res=>{
  const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{const reply=JSON.parse(Buffer.concat(chunks));appendFileSync(join(process.env.HOME,'phases.jsonl'),JSON.stringify({phase,decision:reply.decision})+'\\n');if(res.statusCode!==200)return reject(Error('Synthetic owner denied'));resolve(reply);});
 });req.on('error',reject);req.end(JSON.stringify({version:1,phase,request}));
});
readline.createInterface({input:process.stdin}).on('line',line=>{void(async()=>{
 const rpc=JSON.parse(line),mode=readFileSync(join(process.env.HOME,'mode'),'utf8');
 if(rpc.method==='initialize')send(rpc.id,{protocolVersion:'2025-06-18',capabilities:{tools:{},experimental:{'salaam.dev/toolkit':{version:1,boundedGrants:true,nativeKinds:true,lifecycleControl:true}}},serverInfo:{name:'supertoolkit-managed',version:'fixture1'}});
 else if(rpc.method==='tools/list'){send(rpc.id,{tools:mode==='catalog-drift'?[...tools,{name:'unreviewed',inputSchema:{type:'object'}}]:tools});}
 else if(rpc.method==='tools/call'){
  const a=rpc.params.arguments;
  if(rpc.params.name==='get_action_details'){send(rpc.id,{content:[{type:'text',text:JSON.stringify(details.find(d=>d.action===a.action))}],isError:false});return;}
  const owner=rpc.params._meta['salaam.dev/toolkit'],request={version:1,root_digest:manifest.root_digest,profile_digest:manifest.profile_digest,invocation_id:owner.invocation_id,service:a.category,action:a.action,args:a.args,approval:a.action==='write',expires_at_ms:owner.expires_at_ms};
  let receipt={id:hash(['stk.managed-mcp.v1',request.root_digest,request.invocation_id]),request_digest:hash(request),state:'denied'};
  if(request.approval){const review=await verify('review',request);if(review.decision!=='allowed'){receipt.state=review.decision==='pending'?'awaiting_decision':'denied';send(rpc.id,{content:[{type:'text',text:JSON.stringify(receipt)}],isError:true});return;}receipt.decision_id=review.decision_id;}
  const admit=await verify('admit',request);if(admit.decision!=='allowed')throw Error('Synthetic admit denied');
  const dispatch=await verify('dispatch',request);if(dispatch.decision!=='allowed')throw Error('Synthetic dispatch denied');
  appendFileSync(join(process.env.HOME,'effects.jsonl'),JSON.stringify({action:a.action,invocation:request.invocation_id})+'\\n');
  const outcome={protocol_result:'returned',is_error:mode==='http-error',status:mode==='http-error'?503:200,body:'Synthetic native station response'};
  receipt={...receipt,state:mode==='unknown'?'outcome_unknown':'returned',...(mode==='unknown'?{}:{result:JSON.stringify(outcome)})};
  if(mode==='nested-lie')outcome.is_error=true;
  if(mode==='nested-lie')receipt.result=JSON.stringify(outcome);
  send(rpc.id,{content:[{type:'text',text:JSON.stringify(receipt)}],isError:mode==='unknown'||mode==='http-error'});
 }
})().catch(()=>process.exit(7));});setInterval(()=>{},1000);
`,
    { mode: 0o700 },
  );
  writeFileSync(policy, 'services:\n  github: {}\n', { mode: 0o600 });
  writeFileSync(pass, 'synthetic-only\n', { mode: 0o600 });
  const profileDigest = digest({
    version: 1,
    kind: 'stk-native-managed-v1',
    protocol: '2025-06-18',
    policy_sha256: sha(readFileSync(policy)),
    profile: '',
  });
  const manifest = {
    version: 1,
    root_digest: digest(binding),
    profile_digest: profileDigest,
    workspace,
    policy_path: policy,
    policy_sha256: sha(readFileSync(policy)),
    profile: '',
    store_dir: store,
    passphrase_file: pass,
    state_dir: native,
    owner_socket: join(state, 'operator.sock'),
    owner_key: 'a'.repeat(64),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const profile = {
    version: 1,
    kind: 'stk-native-managed-v1',
    private_dir: state,
    credential_delegation: {
      organization_id: binding.organization_id,
      principal_id: binding.principal_id,
      binding_digest: digest(binding),
    },
    executable: { path: executable, sha256: sha(readFileSync(executable)) },
    manifest: { path: manifestPath, sha256: sha(readFileSync(manifestPath)) },
    passphrase_sha256: sha(readFileSync(pass)),
    limits: {
      request_bytes: 131072,
      response_bytes: 1048576,
      stderr_bytes: 4096,
      timeout_ms: 3000,
    },
  };
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const config: ToolkitWorkConfig = {
    profile_path: profilePath,
    profile_sha256: sha(readFileSync(profilePath)),
    catalog: {
      catalog_digest: mcpCatalogDigest(tools),
      actions: details.map((d) => ({
        category: d.category,
        action: d.action,
        kind: d.kind as 'read' | 'write',
        policy: d.policy as 'agent' | 'approval',
        digest: digest(d),
      })),
    },
  };
  const configs: Record<string, unknown>[] = [];
  const configPath = join(state, 'toolkit.json');
  if (privateConfig)
    writeFileSync(configPath, JSON.stringify({ version: 1, ...config }), { mode: 0o600 });
  const open = () =>
    SalaamService.open({
      stateDir: state,
      agentpodConfig: pins,
      ...(privateConfig
        ? { managedToolkitConfig: { config: configPath, configuration_digest: digest(config) } }
        : { managedToolkit: config }),
      launch: (l) => {
        configs.push(JSON.parse(l.env.SALAAM_WORKER_CONFIG!));
        return new PiProcess(l.command, l.args, l.cwd, l.env);
      },
    });
  let service = await open();
  const session = service.agentpod!.admit(binding, 'admit').session_id;
  service.agentpod!.renew(binding, 'renew', 1);
  const lines = (name: string) =>
    existsSync(join(state, name))
      ? readFileSync(join(state, name), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((s) => JSON.parse(s))
      : [];
  return {
    dir,
    state,
    workspace,
    binding,
    config,
    configPath,
    session,
    lines,
    profilePath,
    configs,
    get service() {
      return service;
    },
    async submit(input: unknown, continuesAttempt: string | null = null) {
      const control = await call<any>(service.socket, `/v1/sessions/${session}/control`, {
        request_id: randomUUID(),
        client_id: 'native-fixture',
        action: 'takeover',
        expected_epoch: service.store.controlView(session).epoch,
      });
      return service.store.accept(
        session,
        randomUUID(),
        service.store.session(session).revision,
        '[toolkit] ' + JSON.stringify(input),
        { client_id: 'native-fixture', token: control.token },
        continuesAttempt,
      );
    },
    async reopen() {
      await service.close();
      service = await open();
    },
    async close() {
      try {
        await service.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
