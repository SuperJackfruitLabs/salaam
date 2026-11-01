import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { fixture, create, ready, until } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { mcpServiceFixture } from '../mcp-service-helpers.js';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { digest } from '../../src/core/protocol.js';
import {
  OperatorMcp,
  declarationDigest,
  validateOperatorMcp,
  type McpDeclaration,
  type StdioDeclaration,
} from '../../src/mcp/operator-mcp.js';
import { mcpCli } from '../../src/cli/mcp-commands.js';
// @ts-expect-error untyped test fixture
import { fixtureServer } from '../fixtures/operator-mcp-server.mjs';

const SERVER = join(ROOT, 'test/fixtures/operator-mcp-server.mjs');
const stdio = (name = 'clock', extra: string[] = []): StdioDeclaration => ({
  name,
  transport: 'stdio',
  command: process.execPath,
  args: [SERVER, ...extra],
});
function declare(dir: string, servers: McpDeclaration[]): string {
  const path = join(dir, 'operator-mcp.json');
  writeFileSync(path, JSON.stringify({ version: 1, servers }), { mode: 0o600 });
  return path;
}
async function turn(
  service: Awaited<ReturnType<typeof fixture>>['service'],
  id: string,
  text: string,
) {
  const accepted = await submit(service, id, text);
  const work = await until(
    () => service.store.attempt(accepted.attempt_id),
    (a) => !['accepted', 'dispatching', 'running'].includes(a.state),
    20000,
  );
  expect(work.state, work.error ?? '').toBe('completed');
  return work;
}
const toolResults = (service: Awaited<ReturnType<typeof fixture>>['service'], id: string) =>
  JSON.stringify(
    service.store.db
      .prepare(
        "SELECT payload FROM pi_entries WHERE session_id=? AND json_extract(payload,'$.message.role')='toolResult'",
      )
      .all(id),
  );

test('a declared stdio server reaches a real Pi session and its provenance is recorded', async () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const config = declare(scratch, [stdio()]);
  const f = await fixture({ operatorMcpConfig: config });
  try {
    const session = await create(f.service, f.dir);
    const s = await ready(f.service, session.id);
    expect(s.capabilities).toContain('operator-mcp-v1');
    await turn(
      f.service,
      session.id,
      '[operator-mcp] ' +
        JSON.stringify({
          action: 'call',
          server: 'clock',
          tool: 'stamp',
          arguments: { label: 'x1' },
        }),
    );
    expect(toolResults(f.service, session.id)).toContain('fixture-stamp:x1');
    const events = f.service.store
      .events(session.id, 0)
      .filter((e) => e.kind === 'operator_mcp.call');
    expect(events.map((e) => (e.payload as any).outcome)).toEqual(['returned']);
    // Provenance: recorded in the readiness handshake and shown by session inspect.
    const snapshot = await call<any>(f.service.socket, `/v1/sessions/${session.id}/snapshot`);
    expect(snapshot.mcp_servers).toEqual([
      {
        name: 'clock',
        source: 'operator',
        transport: 'stdio',
        command: process.execPath,
        args: [SERVER],
        declaration_digest: declarationDigest(stdio()),
      },
    ]);
    expect(
      JSON.parse(readFileSync(join(f.dir, 'workers', session.id, 'mcp-servers.json'), 'utf8')),
    ).toEqual(snapshot.mcp_servers);
    const health = await call<any>(f.service.socket, '/v1/health');
    expect(health.operator_mcp).toMatchObject({ config, servers: snapshot.mcp_servers });
  } finally {
    await f.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 40000);

test('a workspace .pi/mcp.json or .pi/config.json never gives the agent a tool', async () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const marker = join(scratch, 'workspace-server-started');
  const workspaceServer = {
    mcpServers: {
      planted: { command: process.execPath, args: [SERVER, '--marker', marker] },
    },
  };
  const f = await fixture();
  try {
    mkdirSync(join(f.dir, '.pi'), { recursive: true });
    writeFileSync(join(f.dir, '.pi', 'mcp.json'), JSON.stringify(workspaceServer));
    writeFileSync(join(f.dir, '.pi', 'config.json'), JSON.stringify(workspaceServer));
    const session = await create(f.service, f.dir);
    const s = await ready(f.service, session.id);
    expect(s.capabilities).not.toContain('operator-mcp-v1');
    await turn(f.service, session.id, 'hello');
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(marker)).toBe(false);
    const manifest = (f.service.supervisor as any).workers.get(session.id).manifest;
    expect(
      manifest.tools.filter((t: string) => t.startsWith('mcp__') || t.includes('planted')),
    ).toEqual([]);
    expect(manifest.tools).not.toContain('salaam_operator_mcp');
    // Pi's own global MCP file is not a path either: a worker restarted with one planted in
    // its agent directory still starts no server, because Pi runs with --no-mcp.
    writeFileSync(
      join(f.dir, 'workers', session.id, 'agent', 'mcp.json'),
      JSON.stringify(workspaceServer),
    );
    await f.service.supervisor.stopSession(session.id);
    await f.service.supervisor.start(session.id);
    await ready(f.service, session.id);
    await turn(f.service, session.id, 'hello again');
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(marker)).toBe(false);
  } finally {
    await f.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 40000);

test('a declared streamable HTTP server reaches a session with its header resolved from env', async () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const seen: (string | undefined)[] = [];
  const http = createServer((req, res) => {
    seen.push(req.headers.authorization);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    void fixtureServer('http')
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const config = declare(scratch, [
    { name: 'docs', transport: 'http', url, headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  ]);
  const f = await fixture({
    operatorMcpConfig: config,
    operatorMcpEnvironment: { PATH: process.env.PATH, DOCS_TOKEN: 'fixture-docs-token-123' },
  });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await turn(
      f.service,
      session.id,
      '[operator-mcp] ' +
        JSON.stringify({
          action: 'call',
          server: 'docs',
          tool: 'stamp',
          arguments: { label: 'h1' },
        }),
    );
    expect(toolResults(f.service, session.id)).toContain('http-stamp:h1');
    expect(seen).toContain('Bearer fixture-docs-token-123');
    const snapshot = await call<any>(f.service.socket, `/v1/sessions/${session.id}/snapshot`);
    expect(snapshot.mcp_servers).toMatchObject([
      { name: 'docs', source: 'operator', transport: 'http', url },
    ]);
    // The resolved secret never reaches the worker, its transcript or provenance.
    expect(JSON.stringify(snapshot)).not.toContain('fixture-docs-token-123');
    expect(
      readFileSync(f.service.store.session(session.id).pi_session_file!, 'utf8'),
    ).not.toContain('fixture-docs-token-123');
  } finally {
    await f.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    rmSync(scratch, { recursive: true, force: true });
  }
}, 40000);

test('declarations are validated: inline secrets, duplicates, bad urls and unresolvable commands are refused', () => {
  const ok = (servers: unknown[]) => validateOperatorMcp({ version: 1, servers });
  const http = (headers: Record<string, string>) => ({
    name: 'docs',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers,
  });
  expect(() => ok([http({ Authorization: 'Bearer abc123secret' })])).toThrow(/inline secrets/);
  expect(() => ok([http({ Authorization: 'abc123secret${X}' })])).toThrow(/inline secrets/);
  expect(() => ok([{ ...stdio(), env: { API_KEY: 'sk-live-123' } }])).toThrow(/inline secrets/);
  expect(ok([http({ Authorization: 'Bearer ${DOCS_TOKEN}' })]).servers).toHaveLength(1);
  expect(() => ok([stdio('a'), stdio('a')])).toThrow(/duplicate/);
  expect(() => ok([{ ...http({}), url: 'http://example.com/mcp' }])).toThrow(/https/);
  expect(() => ok([{ ...http({}), url: 'https://u:p@example.com/mcp' }])).toThrow(/credentials/);
  expect(() => ok([{ ...stdio(), command: 'bin/server' }])).toThrow(/absolute/);
  expect(() => ok([{ ...stdio(), shell: true }])).toThrow(/unknown key/);
  expect(() => ok([{ ...stdio(), name: 'Bad Name' }])).toThrow(/name/);
  expect(
    () =>
      new OperatorMcp(
        { version: 1, servers: [{ ...stdio(), command: 'no-such-salaam-cmd' }] },
        { PATH: '/usr/bin' },
      ),
  ).toThrow(/not on PATH/);
  expect(
    () =>
      new OperatorMcp(
        { version: 1, servers: [http({ Authorization: 'Bearer ${MISSING}' }) as McpDeclaration] },
        {},
      ),
  ).toThrow(/unset variable MISSING/);
});

test('a malformed declaration file refuses service start', async () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const config = declare(scratch, [
    {
      name: 'docs',
      transport: 'http',
      url: 'https://x.example/mcp',
      headers: { Authorization: 'Bearer raw-token-1' },
    },
  ]);
  try {
    await expect(fixture({ operatorMcpConfig: config })).rejects.toThrow(/inline secrets/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('an operator name that collides with an AgentPod server is refused at admission; distinct names merge', async () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const clash = await mcpServiceFixture({
    serviceOptions: { operatorMcpConfig: declare(scratch, [stdio('superlibrary')]) },
  });
  try {
    await clash.renew();
    await clash.assign();
    await expect(clash.service.supervisor.start(clash.admitted.session_id)).rejects.toThrow(
      /collides with an AgentPod-assigned server/,
    );
    expect(clash.configs).toHaveLength(0);
  } finally {
    await clash.close();
  }
  const merged = await mcpServiceFixture({
    serviceOptions: { operatorMcpConfig: declare(scratch, [stdio('clock')]) },
  });
  try {
    await merged.renew();
    await merged.assign();
    await merged.service.supervisor.start(merged.admitted.session_id).catch(() => {});
    await until(
      () => merged.configs.length,
      (n) => n > 0,
    );
    const servers = (merged.configs.at(-1) as any).mcp_servers;
    expect(servers.map((s: any) => [s.name, s.source])).toEqual([
      ['clock', 'operator'],
      ['superlibrary', 'agentpod'],
    ]);
    expect(JSON.stringify(servers)).not.toContain(merged.assignment.servers[0]!.url);
    expect(servers[1].declaration_digest).toBe(
      digest((merged.configs.at(-1) as any).mcp.servers[0]),
    );
  } finally {
    await merged.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 40000);

test('salaam mcp add, list and rm round-trip through the real CLI', () => {
  const scratch = mkdtempSync('/tmp/sal-omcp-');
  const env = { ...process.env, XDG_CONFIG_HOME: scratch };
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, [join(ROOT, 'dist/src/cli/cli.js'), 'mcp', ...args], {
      env,
      encoding: 'utf8',
    });
  try {
    JSON.parse(cli('add', 'clock', '--', process.execPath, SERVER, '--prefix', 'p'));
    JSON.parse(
      cli(
        'add',
        'docs',
        '--url',
        'https://mcp.example.com/mcp',
        '--header',
        'Authorization=Bearer ${DOCS_TOKEN}',
      ),
    );
    const listed = JSON.parse(cli('list'));
    expect(listed.config).toBe(join(scratch, 'salaam', 'mcp.json'));
    expect(listed.servers.map((s: any) => s.name)).toEqual(['clock', 'docs']);
    expect(listed.servers[0].args).toEqual([SERVER, '--prefix', 'p']);
    expect(listed.servers[1].headers).toEqual({ Authorization: 'Bearer ${DOCS_TOKEN}' });
    expect(() => cli('add', 'clock', '--', process.execPath)).toThrow(/already declared/);
    expect(() =>
      cli('add', 'leak', '--url', 'https://x.example/mcp', '--header', 'Authorization=Bearer raw'),
    ).toThrow(/inline secrets/);
    JSON.parse(cli('rm', 'clock'));
    expect(JSON.parse(cli('list')).servers.map((s: any) => s.name)).toEqual(['docs']);
    expect(() => mcpCli(['rm', 'clock'], env)).toThrow(/No declared server/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
