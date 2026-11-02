import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ToolkitResources } from '../../src/toolkit/resources.js';
import { digest } from '../../src/core/protocol.js';
import { Store } from '../../src/store/store.js';
import { AgentPodAuthority } from '../../src/agentpod/authority.js';
import { mcpServiceFixture } from '../mcp-service-helpers.js';
import type { StdioLaunch } from '../../src/mcp/stdio.js';

async function setup() {
  const f = await mcpServiceFixture();
  await f.renew();
  const file = join(f.dir, 'native-peer.mjs');
  writeFileSync(
    file,
    `
import readline from 'node:readline';
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',s=>{
 const m=JSON.parse(s);
 if(m.method==='initialize')send(m.id,{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'native-resource-fixture',version:'1'}});
 if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:'protocol response only'}]});
});
setInterval(()=>{},1000);
`,
    { mode: 0o600 },
  );
  const launch: StdioLaunch = {
    command: realpathSync(process.execPath),
    executable_digest: createHash('sha256')
      .update(readFileSync(realpathSync(process.execPath)))
      .digest('hex'),
    args: [file],
    cwd: f.dir,
    env: { HOME: f.dir },
    protocol_version: '2025-06-18',
    limits: { request_bytes: 4096, response_bytes: 16384, stderr_bytes: 4096, timeout_ms: 3000 },
  };
  const spec = {
    id: randomUUID(),
    session_id: f.admitted.session_id,
    root_digest: digest(f.binding),
    profile_digest: 'b'.repeat(64),
    manifest_digest: 'c'.repeat(64),
    state_dir: join(f.state, 'broker-state'),
    launch_digest: digest(launch),
  };
  mkdirSync(spec.state_dir, { mode: 0o700 });
  const resources = f.service.toolkitResources;
  return { f, launch, spec, resources };
}

test('actual SDK startup durably records broker identity before any tool delivery', async () => {
  const { f, launch, spec, resources } = await setup();
  const client = new Client({ name: 'resource-proof', version: '1' }, { capabilities: {} });
  try {
    const supplied = { ...spec },
      transport = resources.transport(supplied, launch);
    supplied.id = randomUUID();
    expect(resources.get(spec.id)).toMatchObject({ state: 'prepared', pid: null });
    await client.connect(transport);
    const row = resources.get(spec.id);
    expect(row.state).toBe('running');
    expect(row.pid).toBeGreaterThan(0);
    expect(row.identity).toBeTruthy();
    expect(
      f.service.store
        .events(spec.session_id, 0)
        .filter((e) => e.kind.startsWith('toolkit.resource.'))
        .map((e) => e.kind),
    ).toEqual([
      'toolkit.resource.prepared',
      'toolkit.resource.launching',
      'toolkit.resource.running',
    ]);
    expect(() => resources.transport({ ...spec, id: randomUUID() }, launch)).toThrow(
      /unconfirmed|owned/i,
    );
    expect(
      (
        await client.request(
          { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
          CallToolResultSchema,
        )
      ).isError,
    ).not.toBe(true);
    await resources.stop(spec.id);
    const stopped = resources.get(spec.id);
    expect(stopped.state).toBe('stopped');
    expect(stopped.stop_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => process.kill(row.pid!, 0)).toThrow();
    expect(resources.stopProof(spec.id)).toMatchObject({
      scope: 'local_process_group',
      resource_id: spec.id,
      root_digest: spec.root_digest,
      pid: row.pid,
    });
  } finally {
    await client.close();
    await resources.close();
    await f.close();
  }
});

test('private admission is synchronous and rechecked after startup before actual SDK tool delivery', async () => {
  const { f, launch, spec, resources } = await setup();
  let checks = 0,
    changed = false;
  const client = new Client({ name: 'admission-drift-proof', version: '1' }, { capabilities: {} });
  try {
    const transport = resources.transport(spec, launch, () => {
      checks++;
      if (changed) throw Error('private profile changed');
    });
    await client.connect(transport);
    expect(checks).toBeGreaterThanOrEqual(3); // prepare, pre-spawn, actual PID registration
    changed = true;
    await expect(
      client.request(
        { method: 'tools/call', params: { name: 'fixture', arguments: {} } },
        CallToolResultSchema,
      ),
    ).rejects.toThrow();
    expect(transport.toolCallsSent).toBe(0);
    await resources.stop(spec.id);
    expect(resources.stopProof(spec.id).method).toBe('observed_exit');
  } finally {
    await client.close();
    await resources.close();
    await f.close();
  }
});

test('an asynchronous private check cannot create even a prepared process resource', async () => {
  const { f, launch, spec, resources } = await setup();
  try {
    expect(() =>
      resources.transport(spec, launch, async () => {
        throw Error('asynchronous check is not authority');
      }),
    ).toThrowError(expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }));
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_resources').get()!.n).toBe(
      0,
    );
  } finally {
    await f.close();
  }
});

test('an unrecorded launch remains fenced after registry reconstruction; an unused prepared intent can settle', async () => {
  const { f, launch, spec, resources } = await setup();
  try {
    resources.transport(spec, launch);
    resources.launching(spec.id);
    const replacement = new ToolkitResources(f.service.store, f.service.agentpod!);
    const result = await replacement.recover();
    expect(result.unconfirmed).toContain(spec.id);
    expect(replacement.get(spec.id)).toMatchObject({
      state: 'unconfirmed',
      pid: null,
      stop_digest: null,
    });
    expect(() => replacement.stopProof(spec.id)).toThrow(/unconfirmed/i);
    expect(f.service.agentpod!.inspect(f.binding)).toMatchObject({
      authorized: false,
      owned_execution_stopped: false,
    });
    await expect(f.renew(2)).rejects.toThrow(/unconfirmed/i);
    expect(() => replacement.transport({ ...spec, id: randomUUID() }, launch)).toThrow(
      /unconfirmed|owned/i,
    );
  } finally {
    // There was deliberately no OS spawn; retain the uncertainty while testing,
    // then remove only the disposable fixture database through fixture teardown.
    await expect(f.close()).rejects.toThrow('state ownership retained');
  }
});

test('reconstructed registry stops its exact recorded live broker without renewing revoked work authority', async () => {
  const { f, launch, spec, resources } = await setup();
  const client = new Client(
    { name: 'registry-recovery-proof', version: '1' },
    { capabilities: {} },
  );
  try {
    await client.connect(resources.transport(spec, launch));
    const row = resources.get(spec.id);
    f.service.store.db.exec("UPDATE agentpod_admissions SET state='revoked'");
    expect(() => resources.assertLive(spec.id)).toThrow();
    const replacement = new ToolkitResources(f.service.store, f.service.agentpod!);
    expect(() => replacement.assertLive(spec.id)).toThrowError(
      expect.objectContaining({ code: 'authority_expired' }),
    );
    expect((await replacement.recover()).stopped).toContain(spec.id);
    expect(replacement.get(spec.id).stop_digest).toBeTruthy();
    expect(() => process.kill(row.pid!, 0)).toThrow();
    expect(() => replacement.transport({ ...spec, id: randomUUID() }, launch)).toThrow(
      /authority|lease/i,
    );
  } finally {
    await client.close();
    await resources.close();
    await f.close();
  }
});

test('cleanup failure denies grants even when the journal cannot persist the unconfirmed marker', async () => {
  const { f, launch, spec, resources } = await setup();
  const transport = resources.transport(spec, launch);
  const client = new Client({ name: 'cleanup-fault-proof', version: '1' }, { capabilities: {} });
  const close = transport.close.bind(transport);
  try {
    await client.connect(transport);
    const row = resources.get(spec.id);
    transport.close = async () => {
      throw Error('unconfirmed fixture cleanup');
    };
    f.service.store.db.exec('PRAGMA query_only=ON');
    await expect(resources.stop(spec.id)).rejects.toThrow();
    expect(() => process.kill(row.pid!, 0)).not.toThrow();
    expect(resources.get(spec.id).state).toBe('running');
    expect(() => resources.assertLive(spec.id)).toThrow(/unconfirmed/i);
    expect(() =>
      new ToolkitResources(f.service.store, f.service.agentpod!).assertLive(spec.id),
    ).toThrow(/unconfirmed/i);
  } finally {
    f.service.store.db.exec('PRAGMA query_only=OFF');
    transport.close = close;
    await client.close();
    await resources.close();
    await f.close();
  }
});

test('durable process intent and its event survive journal reopen without inventing a PID', async () => {
  const { f, launch, spec, resources } = await setup();
  let store: Store | undefined;
  try {
    resources.transport(spec, launch);
    resources.launching(spec.id);
    const before = f.service.store.events(spec.session_id, 0);
    // A second SQLite handle observes committed state, independent of live maps.
    store = new Store(join(f.state, 'journal.sqlite'));
    const authority = new AgentPodAuthority(store, f.state, f.pinsPath, () => {});
    const replacement = new ToolkitResources(store, authority);
    expect(replacement.get(spec.id)).toMatchObject({ state: 'launching', pid: null });
    expect(store.events(spec.session_id, 0)).toEqual(before);
    expect((await replacement.recover()).unconfirmed).toContain(spec.id);
  } finally {
    store?.close();
    await expect(f.close()).rejects.toThrow('state ownership retained');
  }
});

test('PID persistence failure stops the actual child; only its original observer can settle the missing identity', async () => {
  const { f, launch, spec, resources } = await setup();
  const transport = resources.transport(spec, launch);
  const fail = (event: { kind: string }) => {
    if (event.kind === 'toolkit.resource.launching')
      f.service.store.db.exec('PRAGMA query_only=ON');
  };
  f.service.store.changes.on('event', fail);
  try {
    await expect(transport.start()).rejects.toThrow('Managed MCP stdio control failed');
    expect(transport.stopped).toBe(true);
    expect(resources.get(spec.id)).toMatchObject({ state: 'launching', pid: null });
    f.service.store.db.exec('PRAGMA query_only=OFF');
    const reconstructed = new ToolkitResources(f.service.store, f.service.agentpod!);
    expect((await reconstructed.recover()).unconfirmed).toContain(spec.id);
    await resources.stop(spec.id);
    expect(resources.get(spec.id)).toMatchObject({ state: 'stopped' });
    expect(resources.stopProof(spec.id).pid).toBeGreaterThan(0);
  } finally {
    f.service.store.changes.off('event', fail);
    f.service.store.db.exec('PRAGMA query_only=OFF');
    await resources.close();
    await f.close();
  }
});

test('unused intents settle as never started, while a stale handle cannot launch after settlement', async () => {
  const { f, launch, spec, resources } = await setup();
  try {
    const transport = resources.transport(spec, launch);
    await resources.stop(spec.id);
    expect(resources.stopProof(spec.id)).toMatchObject({ method: 'not_started', pid: null });
    await expect(transport.start()).rejects.toThrow();
    expect(resources.get(spec.id).state).toBe('stopped');
    const next = resources.transport({ ...spec, id: randomUUID() }, launch);
    await next.close();
  } finally {
    await resources.close();
    await f.close();
  }
});
