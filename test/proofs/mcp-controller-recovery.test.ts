import { expect, test } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Store } from '../../src/store.js';
import { digest } from '../../src/protocol.js';
import { mcpCatalogDigest, mcpToolDigest } from '../../src/mcp-http.js';
import { mcpProfile } from '../../src/mcp-protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };
import { ROOT } from '../../src/config.js';
import { until } from '../helpers.js';

const tools = ['library_search', 'fixture_mutate'].map((name) => ({
  name,
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}));
async function fixture(phase: 'before' | 'after' | 'stored' | 'cancel') {
  const dir = realpathSync(mkdtempSync('/tmp/smcr-')),
    workspace = join(dir, 'work');
  mkdirSync(workspace, { mode: 0o700 });
  const binding = {
    ...corpus.assignments[0]!.value.binding,
    workspace,
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
  };
  const { version, organization_id, node_id, station_key } = binding;
  const pins = { version, organization_id, node_id, station_key, workspace };
  const key = corpus.assignments[0]!.value.servers[0]!.headers[0]!.value;
  let calls = 0,
    listings = 0,
    blocked = false,
    disconnected = false;
  const errors: string[] = [];
  const server = createServer((req, res) => {
    const handle = async () => {
      expect(req.headers['x-agentpod-proxy-key']).toBe(key);
      const bytes: Buffer[] = [];
      for await (const chunk of req) bytes.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(bytes).toString());
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.method === 'initialize')
        reply({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'offline-crash-fixture', version: '1' },
        });
      else if (rpc.method === 'tools/list') {
        listings++;
        if (phase === 'before' && listings === 2) {
          blocked = true;
          return;
        }
        reply({ tools });
      } else if (rpc.method === 'tools/call') {
        calls++;
        if (phase === 'after' || phase === 'cancel') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': accepted; fixture result intentionally withheld\n\n');
          res.once('close', () => {
            disconnected = true;
          });
          return;
        }
        reply({ content: [{ type: 'text', text: 'Offline durable result ' + calls }] });
      } else {
        res.writeHead(202);
        res.end();
      }
    };
    handle().catch((error) => {
      errors.push(String(error));
      res.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const profile = mcpProfile(corpus.profiles[0]!.value);
  profile.proxy_origin = origin;
  profile.servers[0]!.catalog_digest = mcpCatalogDigest(tools);
  profile.servers[0]!.tools = tools.map((tool) => ({
    name: tool.name,
    schema_digest: mcpToolDigest(tool),
    policy: tool.name === 'library_search' ? 'read' : 'approval',
  }));
  const profilePath = join(dir, 'profile.json');
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const profileDigest = digest({ profile, pins_digest: digest(pins) });
  const assignment = {
    ...corpus.assignments[0]!.value,
    binding,
    profile_digest: profileDigest,
    servers: [
      {
        ...corpus.assignments[0]!.value.servers[0]!,
        url: `${origin}/stations/${binding.station_id}/mcp-managed-v1/${digest(binding)}/superlibrary`,
      },
    ],
  };
  const database = join(dir, 'journal.sqlite'),
    store = new Store(database);
  const session = store.create(workspace, 'create'),
    accepted = store.accept(
      session.id,
      'prompt',
      session.revision,
      'Synthetic controller crash proof',
    );
  const epoch = store.allocate(session.id, 'fixture-boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(accepted.attempt_id);
  store.close();
  const configPath = join(dir, 'fixture.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      database,
      artifacts: join(dir, 'artifacts'),
      profile: profilePath,
      pins,
      profileDigest,
      assignment,
      session: session.id,
      epoch,
      attempt: accepted.attempt_id,
    }),
    { mode: 0o600 },
  );
  let child: ChildProcess | undefined,
    messages: any[] = [],
    stderr = '';
  const boot = async () => {
    messages = [];
    stderr = '';
    child = fork(join(ROOT, 'test/fixtures/mcp-controller-process.mjs'), [configPath], {
      cwd: dir,
      execPath: process.execPath,
      execArgv: [],
      silent: true,
      env: { PATH: dirname(process.execPath), HOME: dir, LANG: 'C' },
    });
    child.on('message', (message) => messages.push(message));
    child.stderr!.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += String(chunk);
    });
    child.stdout!.resume();
    await until(
      () => ({ ready: messages.some((m) => m.type === 'ready'), stderr, exit: child!.exitCode }),
      (s) => s.ready,
      10000,
    );
  };
  const kill = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  };
  const rpc = async (command: string, body: Record<string, unknown> = {}) => {
    const id = randomUUID();
    child!.send({ id, command, ...body });
    const reply = await until(
      () => messages.find((m) => m.type === 'reply' && m.id === id),
      (m) => !!m,
      10000,
    );
    if (reply.error) throw new Error(reply.error.code + ': ' + reply.error.message);
    return reply.value;
  };
  const close = async () => {
    await kill();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    expect(errors).toEqual([]);
  };
  try {
    await boot();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    boot,
    kill,
    rpc,
    get calls() {
      return calls;
    },
    get blocked() {
      return blocked;
    },
    get messages() {
      return messages;
    },
    get disconnected() {
      return disconnected;
    },
    close,
  };
}

for (const phase of ['before', 'after', 'stored'] as const)
  test(`MCP controller SIGKILL ${phase} the handoff preserves one logical call without replay`, async () => {
    const f = await fixture(phase);
    try {
      const tool = phase === 'stored' ? 'library_search' : 'fixture_mutate';
      const call = await f.rpc('prepare', { logical: 'one-logical-call', tool });
      if (phase !== 'stored') await f.rpc('approve', { call: call.id });
      await f.rpc('start', { call: call.id });
      if (phase === 'before') await until(() => f.blocked, Boolean);
      else if (phase === 'after')
        await until(
          () => f.calls,
          (n) => n === 1,
        );
      else
        await until(
          () => f.messages.some((m) => m.type === 'event' && m.kind === 'mcp.returned'),
          Boolean,
        );
      await f.kill();
      await f.boot();
      const recovered = await f.rpc('get', { call: call.id });
      expect(recovered.state).toBe(
        phase === 'before'
          ? 'cancelled_before_dispatch'
          : phase === 'after'
            ? 'outcome_unknown'
            : 'returned',
      );
      expect((await f.rpc('start', { call: call.id })).id).toBe(call.id);
      expect((await f.rpc('prepare', { logical: 'one-logical-call', tool })).id).toBe(call.id);
      expect(f.calls).toBe(phase === 'before' ? 0 : 1);
      if (phase === 'after') {
        expect((await f.rpc('status')).unknown).toBe(true);
        await expect(
          f.rpc('prepare', { logical: 'fresh-id-must-not-retry', tool }),
        ).rejects.toThrow('Unresolved');
      }
      if (phase === 'stored')
        expect(JSON.parse(await f.rpc('result', { call: call.id }))).toMatchObject({
          protocol_result: 'returned',
          content: [{ text: 'Offline durable result 1' }],
        });
    } finally {
      await f.close();
    }
  }, 45000);

test('durable root cancellation closes the real MCP request and retains the accepted mutation as unknown', async () => {
  const f = await fixture('cancel');
  try {
    const call = await f.rpc('prepare', {
      logical: 'cancel-accepted-write',
      tool: 'fixture_mutate',
    });
    await f.rpc('approve', { call: call.id });
    await f.rpc('start', { call: call.id });
    await until(
      () => f.calls,
      (n) => n === 1,
    );
    const receipt = await f.rpc('cancel');
    expect(receipt.cancel_requested).toBe(true);
    expect(receipt.unresolved_operations).toContain(call.operation_id);
    await until(() => f.disconnected, Boolean);
    await until(
      () => f.rpc('status'),
      (s) => s.active_calls.length === 0,
    );
    expect((await f.rpc('get', { call: call.id })).state).toBe('outcome_unknown');
    expect((await f.rpc('status')).unknown).toBe(true);
    expect(f.calls).toBe(1);
  } finally {
    await f.close();
  }
}, 45000);
