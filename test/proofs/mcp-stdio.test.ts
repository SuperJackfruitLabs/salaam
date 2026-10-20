import { afterEach, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ManagedStdioTransport } from '../../src/mcp-stdio.js';

const roots: string[] = [];
const active: ManagedStdioTransport[] = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((t) => t.close()));
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const executable = realpathSync(process.execPath);
const executable_digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
function fixture(mode = 'normal', beforeToolCall = () => {}) {
  const dir = realpathSync(mkdtempSync('/tmp/sms-'));
  roots.push(dir);
  const file = join(dir, 'server.mjs');
  writeFileSync(
    file,
    `
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const mode = process.argv[2];
if (mode === 'stderr') process.stderr.write('fixture-private-broker-secret'.repeat(4096));
if (mode === 'descendant') {
 const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 writeFileSync(process.cwd()+'/descendant',String(child.pid));
 process.on('SIGTERM',()=>{child.kill('SIGTERM');child.on('exit',()=>process.exit(0))});
}
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') {
   if(mode==='timeout') return;
   if(mode==='overflow') {process.stdout.write('x'.repeat(200000));return;}
   send(m.id,{protocolVersion:mode==='version'?'2024-11-05':'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 } else if(m.method==='tools/list') send(m.id,{tools:[]});
 else if(m.method==='tools/call'&&mode!=='call-timeout') send(m.id,{content:[{type:'text',text:JSON.stringify({fixture:true,inherited:process.env.ANTHROPIC_API_KEY??null,home:process.env.HOME})}]});
});
`,
    { mode: 0o600 },
  );
  const transport = new ManagedStdioTransport(
    {
      command: executable,
      executable_digest,
      args: [file, mode],
      cwd: dir,
      env: { HOME: dir },
      protocol_version: '2025-06-18',
      limits: { request_bytes: 16384, response_bytes: 32768, stderr_bytes: 4096, timeout_ms: 2000 },
    },
    beforeToolCall,
  );
  active.push(transport);
  const client = new Client({ name: 'stdio-proof', version: '1' }, { capabilities: {} });
  return { dir, transport, client, connect: () => client.connect(transport, { timeout: 2500 }) };
}

test('the real SDK negotiates the pinned protocol and a call consumes its synchronous guard once', async () => {
  let guards = 0;
  const f = fixture('normal', () => {
    guards++;
  });
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-parent-secret-must-not-reach-child';
  try {
    await f.connect();
    expect(await f.client.request({ method: 'tools/list' }, ListToolsResultSchema)).toEqual({
      tools: [],
    });
    const result = await f.client.request(
      { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
      CallToolResultSchema,
    );
    expect(guards).toBe(1);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ fixture: true, inherited: null, home: f.dir }) },
    ]);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = old;
  }
});

test('a denied pre-send grant never hands a tool call to the child', async () => {
  const f = fixture('normal', () => {
    throw Error('fixture grant revoked');
  });
  await f.connect();
  await expect(
    f.client.request(
      { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
      CallToolResultSchema,
    ),
  ).rejects.toThrow();
  expect(f.transport.toolCallsSent).toBe(0);
});

test('an asynchronous guard cannot admit tool delivery before its authority check settles', async () => {
  const f = fixture('normal', async () => {});
  await f.connect();
  await expect(
    f.client.request(
      { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
      CallToolResultSchema,
    ),
  ).rejects.toThrow();
  expect(f.transport.toolCallsSent).toBe(0);
});

for (const mode of ['overflow', 'stderr', 'version', 'timeout'])
  test(`stdio ${mode} fails closed with fixed diagnostics and observed cleanup`, async () => {
    const f = fixture(mode);
    await expect(f.connect()).rejects.toThrow();
    await f.transport.close();
    expect(f.transport.stopped).toBe(true);
    expect(f.transport.diagnostic).not.toContain('fixture-private-broker-secret');
  });

test('closing a transport stops its actual descendant process group', async () => {
  const f = fixture('descendant');
  await f.connect();
  const child = Number(readFileSync(join(f.dir, 'descendant'), 'utf8'));
  expect(() => process.kill(child, 0)).not.toThrow();
  await f.transport.close();
  expect(f.transport.stopped).toBe(true);
  expect(() => process.kill(child, 0)).toThrow();
});

test('a stalled tool response hits the transport deadline and stops the process', async () => {
  const f = fixture('call-timeout');
  await f.connect();
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<void>((done) => {
    f.client.onclose = done;
  });
  const result = f.client
    .request(
      { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
      CallToolResultSchema,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('transport did not enforce its own deadline')), 3500);
      }),
    ]);
    expect(f.transport.stopped).toBe(true);
    await result;
  } finally {
    clearTimeout(timer);
  }
});

test('an altered executable pin or unexpected environment is rejected before spawn', () => {
  const f = fixture();
  expect(
    () =>
      new ManagedStdioTransport(
        { ...f.transport.launch, executable_digest: 'b'.repeat(64) },
        () => {},
      ),
  ).toThrow();
  expect(
    () =>
      new ManagedStdioTransport(
        { ...f.transport.launch, env: { ANTHROPIC_API_KEY: 'fixture' } },
        () => {},
      ),
  ).toThrow();
});
