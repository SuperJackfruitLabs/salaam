import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SalaamService } from '../src/service.js';
import { PiProcess } from '../src/pi.js';
import { call } from '../src/transport.js';
import { digest } from '../src/protocol.js';
import { mcpCatalogDigest, mcpToolDigest } from '../src/mcp-http.js';
import { mcpProfile } from '../src/mcp-protocol.js';
import { providerRoute } from '../src/provider-config.js';
import { ROOT } from '../src/config.js';
import corpus from './fixtures/agentpod-mcp-v1.json' with { type: 'json' };

export async function mcpServiceFixture(options: { liveFixture?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync('/tmp/smsp-')),
    workspace = join(dir, 'w');
  mkdirSync(workspace, { mode: 0o700 });
  const binding = {
    ...corpus.assignments[0]!.value.binding,
    workspace,
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
  };
  const { version, organization_id, node_id, station_key } = binding;
  const pins = { version, organization_id, node_id, station_key, workspace };
  const tools = ['library_search', 'fixture_mutate'].map((name) => ({
    name,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
  }));
  const key = corpus.assignments[0]!.value.servers[0]!.headers[0]!.value;
  const mode = { drift: false, hold: false, disconnected: false, key };
  const sent: unknown[] = [],
    errors: string[] = [],
    configs: unknown[] = [],
    extensionErrors: unknown[] = [];
  const server = createServer((req, res) => {
    const handle = async () => {
      if (req.method === 'DELETE') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (
        req.headers['x-agentpod-proxy-key'] !== mode.key ||
        req.url !== `/stations/${binding.station_id}/mcp/superlibrary`
      )
        throw Error('Fixture received wrong private station assignment');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      };
      if (rpc.method === 'initialize')
        reply({
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'offline-station-fixture', version: '1' },
        });
      else if (rpc.method === 'tools/list')
        reply({
          tools: mode.drift
            ? [...tools, { name: 'unreviewed', inputSchema: { type: 'object' } }]
            : tools,
        });
      else if (rpc.method === 'tools/call') {
        sent.push(rpc.params);
        if (mode.hold) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': accepted; result withheld\n\n');
          res.once('close', () => {
            mode.disconnected = true;
          });
        } else
          reply({ content: [{ type: 'text', text: 'Offline station memory ' + sent.length }] });
      } else {
        res.writeHead(202);
        res.end();
      }
    };
    void handle().catch((e) => {
      errors.push(String(e));
      res.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const profile = mcpProfile(corpus.profiles[0]!.value);
  profile.proxy_origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile.servers[0]!.catalog_digest = mcpCatalogDigest(tools);
  profile.servers[0]!.tools = tools.map((t) => ({
    name: t.name,
    schema_digest: mcpToolDigest(t),
    policy: t.name === 'library_search' ? 'read' : 'approval',
  }));
  const pinsPath = join(dir, 'pins.json'),
    profilePath = join(dir, 'mcp.json'),
    state = join(dir, 's');
  writeFileSync(pinsPath, JSON.stringify(pins), { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
  const profileDigest = digest({ profile, pins_digest: digest(pins) });
  const assignment = {
    ...corpus.assignments[0]!.value,
    binding,
    profile_digest: profileDigest,
    servers: [
      {
        ...corpus.assignments[0]!.value.servers[0]!,
        url: `${profile.proxy_origin}/stations/${binding.station_id}/mcp/superlibrary`,
      },
    ],
  };
  const provider = options.liveFixture
    ? spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-claude.mjs'), workspace], {
        env: { PATH: dirname(process.execPath), HOME: dir, LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : undefined;
  if (provider) {
    writeFileSync(join(workspace, 'claude-mode'), 'mcp');
    provider.stderr.resume();
    await once(provider.stdout, 'data');
  }
  const stopProvider = async () => {
    if (provider && provider.exitCode === null && provider.signalCode === null) {
      const exited = once(provider, 'exit');
      provider.kill('SIGKILL');
      await exited;
    }
  };
  const open = () =>
    SalaamService.open({
      stateDir: state,
      agentpodConfig: pinsPath,
      managedMcp: { config: profilePath, profile_digest: profileDigest },
      ...(provider
        ? {
            providerRoute: providerRoute('anthropic', undefined, 512),
            anthropicApiKey: 'fixture-anthropic-key',
            extensionPath: join(ROOT, 'test/fixtures/claude-extension.mjs'),
          }
        : {}),
      launch: (l) => {
        configs.push(JSON.parse(l.env.SALAAM_WORKER_CONFIG!));
        const pi = new PiProcess(l.command, l.args, l.cwd, l.env);
        pi.on('record', (record) => {
          if (record.type === 'extension_error') extensionErrors.push(record);
        });
        return pi;
      },
    });
  let service: SalaamService;
  try {
    service = await open();
  } catch (error) {
    await stopProvider();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const admitted = await call<any>(service.socket, '/v1/agentpod/admit', {
    request_id: 'admit',
    binding,
  });
  const renew = (sequence = 1) =>
    call(service.socket, '/v1/agentpod/renew', {
      request_id: 'renew:' + sequence,
      lease_sequence: sequence,
      binding,
    });
  const assign = (next = assignment) =>
    call(service.socket, '/v1/agentpod/mcp-assign', { binding, assignment: next });
  return {
    dir,
    workspace,
    state,
    binding,
    pins,
    profile,
    profilePath,
    profileDigest,
    pinsPath,
    assignment,
    admitted,
    renew,
    assign,
    mode,
    sent,
    errors,
    configs,
    extensionErrors,
    async providerStats() {
      const port = await import('node:fs').then((fs) =>
        fs.readFileSync(join(workspace, 'claude-port'), 'utf8'),
      );
      return (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as {
        count: number;
        bodies: { body: { tools: { name: string }[] }; authenticated: boolean }[];
      };
    },
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = await open();
    },
    async close() {
      try {
        await service.close();
      } finally {
        await stopProvider();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
