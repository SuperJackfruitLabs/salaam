import { test, expect } from 'vitest';
import { AnthropicHarnessGateway } from '../../src/harness/model-gateway.js';
import type { GatewayRequest } from '../../src/harness/container.js';
const token = 'fixture-ephemeral-token-'.repeat(3),
  model = 'fixture-model';
const request = (change: Record<string, unknown> = {}): GatewayRequest => ({
  method: 'POST',
  path: '/v1/messages',
  headers: {
    'x-api-key': token,
    authorization: 'Bearer do-not-forward',
    'anthropic-beta': 'fixture-beta',
  },
  body: Buffer.from(
    JSON.stringify({
      model,
      max_tokens: 64000,
      messages: [{ role: 'user', content: 'Repair the fixture' }],
      tools: [{ name: 'Edit', input_schema: { type: 'object' } }],
      ...change,
    }),
  ),
});
test('each actual request is admitted before forwarding, capped and stripped of client auth', async () => {
  const events: string[] = [],
    forwarded: any[] = [];
  const gateway = new AnthropicHarnessGateway({
    model,
    output: 4096,
    token,
    credential: async () => {
      events.push('credential');
      return 'host-only-real-key';
    },
    admit: (_id, bytes, cap) => {
      expect(bytes).toBeGreaterThan(0);
      expect(cap).toBe(4096);
      events.push('admit');
    },
    fetch: async (url, init) => {
      events.push('forward');
      forwarded.push({ url, init });
      return new Response('fixture-reply', { headers: { 'content-type': 'application/json' } });
    },
  });
  const response = await gateway.request(request());
  let text = '';
  for await (const chunk of response.body)
    text += Buffer.from(typeof chunk === 'number' ? [chunk] : chunk).toString();
  expect(text).toBe('fixture-reply');
  expect(events).toEqual(['credential', 'admit', 'forward']);
  expect(forwarded[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(forwarded[0].init).toMatchObject({
    redirect: 'error',
    headers: { 'x-api-key': 'host-only-real-key', 'anthropic-version': '2023-06-01' },
  });
  expect(forwarded[0].init.headers.authorization).toBeUndefined();
  expect(JSON.parse(forwarded[0].init.body).max_tokens).toBe(4096);
});
for (const change of [
  { model: 'different' },
  { max_tokens: null },
  { tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
  { mcp_servers: [{ url: 'https://outside.invalid' }] },
  {
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://outside.invalid' } }],
      },
    ],
  },
  {
    messages: [{ role: 'user', content: [{ type: 'tool_result', content: [{ type: 'image' }] }] }],
  },
])
  test(
    'unadmitted payload cannot disclose credentials or consume model allowance: ' +
      JSON.stringify(change),
    async () => {
      let calls = 0;
      const gateway = new AnthropicHarnessGateway({
        model,
        output: 4096,
        token,
        credential: async () => {
          calls++;
          return 'key';
        },
        admit: () => {
          calls++;
        },
        fetch: async () => {
          calls++;
          throw Error('must not forward');
        },
      });
      await expect(gateway.request(request(change))).rejects.toMatchObject({
        code: 'harness_gateway_payload',
      });
      expect(calls).toBe(0);
    },
  );
test('wrong token or endpoint never forwards a request', async () => {
  const gateway = new AnthropicHarnessGateway({
    model,
    output: 4096,
    token,
    credential: async () => {
      throw Error('must not read key');
    },
    admit: () => {
      throw Error('must not admit');
    },
  });
  await expect(
    gateway.request({ ...request(), headers: { 'x-api-key': 'wrong' } }),
  ).rejects.toMatchObject({ code: 'harness_gateway_auth' });
  await expect(gateway.request({ ...request(), path: '/v1/other' })).rejects.toMatchObject({
    code: 'harness_gateway_scope',
  });
});
test('budget denial prevents forwarding, while upstream failure retains one admission without automatic retry', async () => {
  let admissions = 0,
    calls = 0;
  const policy = {
    model,
    output: 4096,
    token,
    credential: async () => 'host-key',
    admit: () => {
      admissions++;
    },
    fetch: async () => {
      calls++;
      throw Error('upstream failed');
    },
  };
  const denied = new AnthropicHarnessGateway({
    ...policy,
    admit: () => {
      throw Error('budget exhausted');
    },
  });
  await expect(denied.request(request())).rejects.toThrow('budget exhausted');
  expect(calls).toBe(0);
  await expect(new AnthropicHarnessGateway(policy).request(request())).rejects.toThrow(
    'upstream failed',
  );
  expect(admissions).toBe(1);
  expect(calls).toBe(1);
});
