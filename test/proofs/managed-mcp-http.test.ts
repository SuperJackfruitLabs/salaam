import { expect, test } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ManagedHttpMcp, mcpCatalogDigest, mcpToolDigest } from '../../src/mcp-http.js';
import { mcpAssignment, mcpProfile } from '../../src/mcp-protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };

const tool = {
  name: 'library_search',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};
async function fixture(call?: (id: number, res: ServerResponse) => void) {
  const assignment = mcpAssignment(corpus.assignments[0]!.value),
    profile = mcpProfile(corpus.profiles[0]!.value);
  const serverConfig = assignment.servers[0]!;
  const methods: string[] = [],
    errors: string[] = [];
  const reply = (res: ServerResponse, id: number, result: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const server = createServer((req, res) => {
    const handle = async () => {
      expect(req.method).toBe('POST');
      expect(req.url).toBe(new URL(serverConfig.url).pathname);
      expect(req.headers['x-agentpod-proxy-key']).toBe(serverConfig.headers[0]!.value);
      expect(req.headers.authorization).toBeUndefined();
      const buffers: Buffer[] = [];
      for await (const chunk of req) buffers.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(buffers).toString());
      methods.push(rpc.method);
      if (rpc.method !== 'initialize')
        expect(req.headers['mcp-protocol-version']).toBe('2025-11-25');
      if (rpc.method === 'initialize')
        reply(res, rpc.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'offline-fixture-library', version: '1' },
        });
      else if (rpc.method === 'tools/list') reply(res, rpc.id, { tools: [tool] });
      else if (rpc.method === 'tools/call') {
        if (call) call(rpc.id, res);
        else
          reply(res, rpc.id, {
            content: [{ type: 'text', text: 'Offline scoped fixture memory' }],
          });
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
  const client = new ManagedHttpMcp(
    { ...serverConfig, url: origin + new URL(serverConfig.url).pathname },
    {
      ...profile.servers[0]!,
      catalog_digest: mcpCatalogDigest([tool]),
      tools: [{ name: tool.name, schema_digest: mcpToolDigest(tool), policy: 'read' }],
    },
    profile.limits,
  );
  return {
    client,
    methods,
    origin,
    async close() {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(errors).toEqual([]);
    },
  };
}

test('real loopback HTTP and the pinned SDK carry only assigned auth and one call', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    const result = await f.client.call(
      tool.name,
      { query: 'fixture' },
      AbortSignal.timeout(1000),
      () => {},
    );
    expect(result.content).toEqual([{ type: 'text', text: 'Offline scoped fixture memory' }]);
    expect(f.methods.filter((method) => method === 'tools/call')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('an actual HTTP redirect does not send the proxy key or replay the call to another endpoint', async () => {
  let redirected = 0;
  const target = createServer((_req, res) => {
    redirected++;
    res.end('unexpected');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const destination = `http://127.0.0.1:${(target.address() as AddressInfo).port}/must-not-receive-anything`;
  const f = await fixture((_id, res) => {
    res.writeHead(307, { location: destination });
    res.end();
  });
  try {
    await f.client.connect();
    await expect(
      f.client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: true });
    expect(f.methods.filter((method) => method === 'tools/call')).toHaveLength(1);
    expect(redirected).toBe(0);
  } finally {
    await f.close();
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test('cancellation closes the actual in-flight HTTP response without claiming the remote work stopped', async () => {
  let entered!: () => void, disconnected!: () => void;
  const accepted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const f = await fixture((_id, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': fixture accepted the call, remote result remains unknown\n\n');
    res.once('close', disconnected);
    entered();
  });
  try {
    await f.client.connect();
    const controller = new AbortController();
    const pending = f.client.call(tool.name, { query: 'fixture' }, controller.signal, () => {});
    const rejected = expect(pending).rejects.toMatchObject({ sent: true });
    await accepted;
    controller.abort();
    await rejected;
    await closed;
    expect(f.methods.filter((method) => method === 'tools/call')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
