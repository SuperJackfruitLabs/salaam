import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { ManagedStdioTransport } from '../../src/mcp/stdio.js';
import { ToolkitMcp, type ToolkitCatalogReview } from '../../src/toolkit/mcp.js';
import { mcpCatalogDigest } from '../../src/mcp/http.js';
import { digest } from '../../src/core/protocol.js';
import type { ToolkitRequest } from '../../src/toolkit/protocol.js';

const description = 'Pinned synthetic native tool definition';
const names = [
  'discover_server_categories',
  'get_category_actions',
  'get_action_details',
  'execute_action',
];
const tools = names.map((name) => ({
  name,
  description,
  inputSchema: { type: 'object' as const, properties: {} },
}));
const read = {
  category: 'fixture',
  action: 'read',
  summary: 'Read synthetic data',
  params: null,
  kind: 'read' as const,
  policy: 'agent' as const,
};
const write = {
  category: 'fixture',
  action: 'write',
  summary: 'Write synthetic data',
  params: [{ Name: 'title', Required: true, In: 1, Slashes: false, Summary: 'Title' }],
  kind: 'write' as const,
  policy: 'approval' as const,
};
const review: ToolkitCatalogReview = {
  catalog_digest: mcpCatalogDigest(tools),
  actions: [read, write].map((d) => ({
    category: d.category,
    action: d.action,
    kind: d.kind,
    policy: d.policy,
    digest: digest(d),
  })),
};
const clients: ToolkitMcp[] = [],
  dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(mode = 'normal', configured = review) {
  const dir = realpathSync(mkdtempSync('/tmp/stk-sdk-'));
  dirs.push(dir);
  const script = join(dir, 'peer.mjs'),
    wire = join(dir, 'wire.jsonl');
  writeFileSync(
    script,
    `
import readline from 'node:readline';import {createHash} from 'node:crypto';import {appendFileSync} from 'node:fs';
const mode=${JSON.stringify(mode)}, tools=${JSON.stringify(tools)}, details=${JSON.stringify([read, write])};
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const hash=v=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',s=>{
 const m=JSON.parse(s);
 if(m.method==='initialize'){
  const caps={tools:{},experimental:{'salaam.dev/toolkit':{version:1,boundedGrants:true,nativeKinds:true,lifecycleControl:true}}};
  if(mode==='old-capabilities')delete caps.experimental['salaam.dev/toolkit'].nativeKinds;
  send(m.id,{protocolVersion:'2025-06-18',capabilities:caps,serverInfo:{name:mode==='legacy'?'supertoolkit':'supertoolkit-managed',version:'fixture1'}});
 }else if(m.method==='tools/list'){
  if(mode==='catalog-drift')tools[0].description+='changed';
  send(m.id,{tools,...(mode==='pagination'?{nextCursor:'unreviewed'}:{})});
 }else if(m.method==='tools/call'){
  if(m.params.name==='get_action_details'){
   const d=structuredClone(details.find(d=>d.action===m.params.arguments.action));
   if(mode==='detail-drift')d.policy='approval';
   if(mode==='detail-timeout')return;
   send(m.id,{content:[{type:'text',text:JSON.stringify(d)}],isError:false});return;
  }
  appendFileSync(${JSON.stringify(wire)},JSON.stringify(m.params)+'\\n');
  if(mode==='timeout')return;
  if(mode==='protocol-error'){process.stderr.write('fixture-private-diagnostic');send(m.id,{content:[{type:'text',text:'fixture-private-diagnostic'}],isError:true});return;}
  const a=m.params.arguments,o=m.params._meta['salaam.dev/toolkit'];
  const request={version:1,root_digest:'a'.repeat(64),profile_digest:'b'.repeat(64),invocation_id:o.invocation_id,service:a.category,action:a.action,args:a.args,approval:a.action==='write',expires_at_ms:o.expires_at_ms};
  let status=mode==='http-error'?503:200,state=mode==='pending'||mode==='pending-read'?'awaiting_decision':mode==='unknown'?'outcome_unknown':'returned';
  const outcome={protocol_result:'returned',is_error:status<200||status>=300,status,body:'Synthetic body'};
  if(mode==='nested-lie')outcome.is_error=true;
  if(mode==='nested-extra')outcome.private_header='fixture-private-diagnostic';
  const receipt={id:mode==='wrong-id'?'c'.repeat(64):hash(['stk.managed-mcp.v1',request.root_digest,request.invocation_id]),request_digest:hash(request),state,...(state==='returned'?{result:JSON.stringify(outcome)}:{})};
  if(mode==='bad-digest')receipt.request_digest='d'.repeat(64);
  send(m.id,{content:[{type:'text',text:JSON.stringify(receipt)}],isError:mode==='outer-lie'?true:state!=='returned'||status>=300});
 }
});`,
    { mode: 0o600 },
  );
  const executable = realpathSync(process.execPath),
    counters = { deliveries: 0, failures: 0 };
  const transport = new ManagedStdioTransport(
    {
      command: executable,
      executable_digest: createHash('sha256').update(readFileSync(executable)).digest('hex'),
      args: [script],
      cwd: dir,
      env: { HOME: dir },
      protocol_version: '2025-06-18',
      limits: {
        request_bytes: 131072,
        response_bytes: 1048576,
        stderr_bytes: 4096,
        timeout_ms: 2000,
      },
    },
    () => {
      counters.deliveries++;
    },
  );
  const client = new ToolkitMcp(transport, configured, () => {
    counters.failures++;
  });
  clients.push(client);
  const request = (action = 'read'): ToolkitRequest => ({
    version: 1,
    root_digest: 'a'.repeat(64),
    profile_digest: 'b'.repeat(64),
    invocation_id: 'owner-invocation',
    service: 'fixture',
    action,
    args: action === 'write' ? { title: 'Synthetic' } : {},
    approval: action === 'write',
    expires_at_ms: Date.now() + 30000,
  });
  return { client, transport, request, counters, wire };
}
test('actual SDK checks pinned producer/schema metadata and exposes only reviewed progressive definitions', async () => {
  const f = fixture();
  await f.client.connect();
  expect(f.client.catalog()).toEqual([{ category: 'fixture', kind: 'native' }]);
  expect(f.client.catalog('fixture')).toEqual([
    { action: 'read', kind: 'read', policy: 'agent' },
    { action: 'write', kind: 'write', policy: 'approval' },
  ]);
  expect(f.client.catalog('fixture', 'write')).toMatchObject({
    ...write,
    inputSchema: { required: ['title'], additionalProperties: false },
  });
  expect(f.client.pin('fixture', 'write')).toEqual(
    review.actions[1] && { kind: 'write', policy: 'approval', digest: review.actions[1].digest },
  );
  const request = f.request();
  const result = await f.client.invoke(request, new AbortController().signal);
  expect(result).toMatchObject({
    is_error: false,
    outcome: { status: 200, protocol_result: 'returned', body: 'Synthetic body' },
    receipt: { state: 'returned' },
  });
  const wire = JSON.parse(readFileSync(f.wire, 'utf8'));
  expect(wire._meta).toEqual({
    'salaam.dev/toolkit': {
      version: 1,
      invocation_id: 'owner-invocation',
      expires_at_ms: request.expires_at_ms,
    },
  });
  expect(f.counters.failures).toBe(0);
});
for (const mode of [
  'legacy',
  'old-capabilities',
  'catalog-drift',
  'pagination',
  'detail-drift',
  'detail-timeout',
])
  test('required native readiness rejects ' + mode, async () => {
    const f = fixture(mode);
    await expect(f.client.connect()).rejects.toMatchObject({ code: 'toolkit_protocol_failed' });
    expect(f.transport.stopped).toBe(true);
    expect(f.counters.failures).toBe(1);
    expect(existsSync(f.wire)).toBe(false);
    expect(() => f.client.catalog()).toThrow();
  });
test('invalid native arguments do not hand off execute_action or invalidate a healthy controller', async () => {
  const f = fixture();
  await f.client.connect();
  const before = f.counters.deliveries;
  for (const input of [
    { ...f.request('write'), args: {} },
    { ...f.request('write'), args: { title: 'ok', other: 'no' } },
    { ...f.request('read'), approval: true },
  ])
    await expect(f.client.invoke(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid_mcp_arguments',
    });
  expect(f.counters.deliveries).toBe(before);
  expect(f.counters.failures).toBe(0);
  expect(existsSync(f.wire)).toBe(false);
  expect((await f.client.invoke(f.request(), new AbortController().signal)).outcome?.status).toBe(
    200,
  );
});
for (const mode of [
  'wrong-id',
  'bad-digest',
  'nested-lie',
  'nested-extra',
  'outer-lie',
  'protocol-error',
  'pending-read',
])
  test('native result ' + mode + ' invalidates readiness with no diagnostic leakage', async () => {
    const f = fixture(mode);
    await f.client.connect();
    const error = await f.client.invoke(f.request(), new AbortController().signal).catch((e) => e);
    expect(error.code).toBe('toolkit_protocol_failed');
    expect(String(error)).not.toContain('fixture-private-diagnostic');
    await f.client.close();
    expect(f.transport.stopped).toBe(true);
    expect(f.counters.failures).toBe(1);
    expect(() => f.client.catalog()).toThrow();
  });
for (const mode of ['http-error', 'pending', 'unknown'])
  test('native ' + mode + ' is not reported as successful work', async () => {
    const f = fixture(mode);
    await f.client.connect();
    const result = await f.client.invoke(
      f.request(mode === 'pending' ? 'write' : 'read'),
      new AbortController().signal,
    );
    expect(result.is_error).toBe(true);
    expect(f.counters.failures).toBe(0);
    if (mode === 'http-error')
      expect(result.outcome).toMatchObject({ status: 503, is_error: true });
    else expect(result.outcome).toBeUndefined();
  });
test('aborting native SDK delivery closes the actual owned transport before further calls', async () => {
  const f = fixture('timeout');
  await f.client.connect();
  const controller = new AbortController();
  const running = f.client.invoke(f.request(), controller.signal);
  controller.abort();
  await expect(running).rejects.toMatchObject({ code: 'toolkit_protocol_failed' });
  await f.client.close();
  expect(f.transport.stopped).toBe(true);
  expect(f.counters.failures).toBe(1);
});
test('reviewed native catalog rejects automatic write policy and duplicate action ownership', () => {
  for (const actions of [
    [{ ...review.actions[1]!, policy: 'agent' as const }],
    [review.actions[0]!, review.actions[0]!],
  ])
    expect(() => fixture('normal', { ...review, actions })).toThrow();
});

test('native discovery requires actual readiness and cannot expand through a mutated review object', async () => {
  const configured = structuredClone(review),
    f = fixture('normal', configured);
  expect(() => f.client.catalog()).toThrow();
  configured.actions[0]!.category = 'unreviewed';
  await f.client.connect();
  expect(() => f.client.catalog('unreviewed')).toThrow();
  const displayed = f.client.catalog('fixture', 'write') as Record<string, unknown>;
  displayed.policy = 'agent';
  expect(f.client.pin('fixture', 'write').policy).toBe('approval');
  expect(f.client.catalog()).toEqual([{ category: 'fixture', kind: 'native' }]);
});
