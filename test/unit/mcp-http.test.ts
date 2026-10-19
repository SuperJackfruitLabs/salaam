import { expect, test, vi } from 'vitest';
import { ManagedHttpMcp, mcpCatalogDigest, mcpToolDigest } from '../../src/mcp-http.js';
import { mcpAssignment, mcpProfile } from '../../src/mcp-protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };

const tool = {
  name: 'library_search',
  description: 'Search scoped fixture memory',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  annotations: { readOnlyHint: true },
};
function fixture(
  callResult?: (request: any, init: RequestInit) => Promise<Response>,
  definition: typeof tool & { outputSchema?: Record<string, unknown> } = tool,
) {
  const server = mcpAssignment(corpus.assignments[0]!.value).servers[0]!;
  const profile = mcpProfile(corpus.profiles[0]!.value);
  const pin = {
    ...profile.servers[0]!,
    catalog_digest: mcpCatalogDigest([definition]),
    tools: [{ name: tool.name, schema_digest: mcpToolDigest(definition), policy: 'read' as const }],
  };
  const requests: any[] = [];
  let catalog = [definition];
  const json = (id: unknown, result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = vi.fn(
    async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === 'GET') return new Response(null, { status: 405 });
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      expect(new Headers(init?.headers).get('X-Agentpod-Proxy-Key')).toBe(server.headers[0]!.value);
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      if (request.method === 'initialize')
        return json(request.id, {
          protocolVersion: pin.protocol_version,
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-library', version: '1' },
        });
      if (request.method === 'notifications/initialized' || !Object.hasOwn(request, 'id'))
        return new Response(null, { status: 202 });
      if (request.method === 'tools/list') return json(request.id, { tools: catalog });
      if (request.method === 'tools/call')
        return callResult
          ? callResult(request, init!)
          : json(request.id, { content: [{ type: 'text', text: 'scoped memory' }] });
      throw Error('Unexpected fixture request');
    },
  );
  return {
    server,
    profile,
    pin,
    requests,
    fetcher,
    change: () => {
      catalog = [{ ...tool, inputSchema: { ...tool.inputSchema, required: [] } }];
    },
    json,
  };
}

test('the real pinned SDK negotiates the reviewed protocol and calls only admitted tools', async () => {
  const f = fixture(),
    client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    const result = await client.call(
      tool.name,
      { query: 'fixture' },
      AbortSignal.timeout(1000),
      () => {},
    );
    expect(result).toMatchObject({
      protocol_result: 'returned',
      is_error: false,
      content: [{ type: 'text', text: 'scoped memory' }],
    });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
    await expect(
      client.call('unreviewed_tool', {}, AbortSignal.timeout(1000), () => {}),
    ).rejects.toThrow();
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test('schema drift rejects the call before a tools/call POST, regardless of read-only annotations', async () => {
  const f = fixture(),
    client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    f.change();
    await expect(
      client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: false });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test('a different negotiated protocol fails readiness before any tool call', async () => {
  const f = fixture(),
    client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  f.pin.protocol_version = '2025-06-18';
  try {
    await expect(client.connect()).rejects.toMatchObject({ sent: false });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test('schema references never fetch unadmitted external definitions', async () => {
  const f = fixture(undefined, {
    ...tool,
    outputSchema: { $ref: 'https://must-not-be-fetched.example/schema' },
  });
  const client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await expect(client.connect()).rejects.toMatchObject({ sent: false });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);
    expect(f.fetcher.mock.calls.every(([url]) => String(url) === f.server.url)).toBe(true);
  } finally {
    await client.close();
  }
});

test('arguments must match the admitted input schema before dispatch', async () => {
  const f = fixture(),
    client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    await expect(
      client.call(tool.name, { query: 42 }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: false });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test('the synchronous durable authority gate runs immediately before the one allowed tools/call POST', async () => {
  const f = fixture(),
    client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    const allowed = vi.fn();
    await client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), allowed);
    expect(allowed).toHaveBeenCalledOnce();
    const denied = vi.fn(() => {
      throw Error('Fixture authority revoked before dispatch');
    });
    await expect(
      client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), denied),
    ).rejects.toMatchObject({ sent: false });
    expect(denied).toHaveBeenCalledOnce();
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test('a returned value must satisfy the admitted output schema without inventing an effect outcome', async () => {
  const f = fixture(
    async (request) =>
      f.json(request.id, {
        content: [{ type: 'text', text: 'looks successful' }],
        structuredContent: { count: 'invalid' },
      }),
    {
      ...tool,
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
    },
  );
  const client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    await expect(
      client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: true });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test('a task handoff or an empty acknowledgement cannot look like a completed protocol result', async () => {
  for (const result of [
    { task: { taskId: 'unsupported-remote-task', status: 'working' } },
    {},
    {
      content: [{ type: 'text', text: 'pending' }],
      _meta: { 'io.modelcontextprotocol/related-task': { taskId: 'unsupported-remote-task' } },
    },
  ]) {
    const f = fixture(async (request) => f.json(request.id, result));
    const client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
    try {
      await client.connect();
      await expect(
        client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
      ).rejects.toMatchObject({ sent: true });
      expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
    } finally {
      await client.close();
    }
  }
});

test('lost responses and HTTP auth failures never trigger an OAuth flow or a second write', async () => {
  for (const status of [401, 403, 404, 307, 500, 0]) {
    const f = fixture(async () => {
      if (!status)
        throw Error('lost reply containing fixture-proxy-key-never-use-as-a-live-secret');
      return new Response('fixture-proxy-key-never-use-as-a-live-secret', { status });
    });
    const client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
    try {
      await client.connect();
      await expect(
        client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
      ).rejects.toMatchObject({
        sent: true,
        message: 'Managed MCP call did not return a valid bounded result',
      });
      expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
    } finally {
      await client.close();
    }
  }
});

test('request and response limits fail without exposing raw transport errors or credentials', async () => {
  const f = fixture(async (request) =>
    f.json(request.id, { content: [{ type: 'text', text: 'x'.repeat(3000) }] }),
  );
  const client = new ManagedHttpMcp(
    f.server,
    f.pin,
    { ...f.profile.limits, request_bytes: 1024, response_bytes: 2048 },
    f.fetcher,
  );
  try {
    await client.connect();
    await expect(
      client.call(tool.name, { query: 'x'.repeat(2000) }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: false });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(0);
    await expect(
      client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: true });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test('tool output is untrusted reference data and redacts known proxy credential encodings', async () => {
  const key = 'fixture-proxy-key-never-use-as-a-live-secret';
  const f = fixture(async (request) =>
    f.json(request.id, {
      content: [{ type: 'text', text: key + ':' + Buffer.from(key).toString('base64') }],
      structuredContent: { [key]: key },
    }),
  );
  const client = new ManagedHttpMcp(f.server, f.pin, f.profile.limits, f.fetcher);
  try {
    await client.connect();
    const result = await client.call(
      tool.name,
      { query: 'fixture' },
      AbortSignal.timeout(1000),
      () => {},
    );
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(Buffer.from(key).toString('base64'));
    expect(result.protocol_result).toBe('returned');
    expect(JSON.stringify(result)).toContain('[redacted]');
  } finally {
    await client.close();
  }
});

test('a stalled SSE result has a fixed total deadline and is never reposted', async () => {
  const f = fixture(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const client = new ManagedHttpMcp(
    f.server,
    f.pin,
    { ...f.profile.limits, timeout_ms: 100 },
    f.fetcher,
  );
  try {
    await client.connect();
    await expect(
      client.call(tool.name, { query: 'fixture' }, AbortSignal.timeout(1000), () => {}),
    ).rejects.toMatchObject({ sent: true });
    expect(f.requests.filter((r) => r.method === 'tools/call')).toHaveLength(1);
  } finally {
    await client.close();
  }
});
