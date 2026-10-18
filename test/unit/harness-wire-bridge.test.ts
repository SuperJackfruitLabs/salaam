import { test, expect } from 'vitest';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { AnthropicHarnessGateway } from '../../src/harness-model-gateway.js';
import { HarnessWireBridge } from '../../src/harness-wire-bridge.js';
import type { GatewayRequest } from '../../src/harness-container.js';
const token = 'wire-fixture-token-'.repeat(4);
function fixture(
  protocol: 'google' | 'responses',
  tool = false,
  onTool?: ConstructorParameters<typeof HarnessWireBridge>[2],
) {
  const payloads: any[] = [],
    admissions: any[] = [];
  const backend = new AnthropicHarnessGateway({
    model: 'backend-fixture',
    output: 4096,
    token,
    credential: async () => 'host-only-fixture-key',
    admit: (id, bytes, output) => {
      admissions.push({ id, bytes, output });
    },
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'backend-fixture',
          content: tool
            ? [
                {
                  type: 'tool_use',
                  id: 'toolu_fixture',
                  name: protocol === 'google' ? 'read_file' : 'exec_command',
                  input: protocol === 'google' ? { file_path: 'app.js' } : { cmd: 'node --test' },
                },
              ]
            : [{ type: 'text', text: 'Observed the fixture.' }],
          stop_reason: tool ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 20, output_tokens: 10 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const bridge = new HarnessWireBridge(
    backend,
    {
      protocol,
      model: protocol === 'google' ? 'gemini-fixture' : 'codex-fixture',
      tools:
        protocol === 'google'
          ? ['read_file', 'run_shell_command']
          : ['exec_command', 'write_stdin'],
    },
    onTool,
  );
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url);
    const response = await bridge.request({
      method: req.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(req.headers),
      body: Buffer.from(await req.arrayBuffer()),
    });
    if (!Buffer.isBuffer(response.body))
      throw Error('Expected complete translated fixture response');
    return new Response(response.body.toString('utf8'), {
      status: response.status,
      headers: { 'content-type': response.content_type! },
    });
  };
  return { bridge, payloads, admissions, fetcher };
}
for (const tool of [false, true])
  test(
    'independent OpenAI SDK consumes translated Responses ' +
      (tool ? 'tool call' : 'text') +
      ' events',
    async () => {
      const f = fixture('responses', tool),
        client = new OpenAI({
          apiKey: token,
          baseURL: 'http://fixture.local/v1',
          fetch: f.fetcher,
          maxRetries: 0,
        });
      const stream = await client.responses.create({
        model: 'codex-fixture',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect the fixture' }] }],
        tools: [
          {
            type: 'function',
            name: 'exec_command',
            description: 'Run scoped command',
            parameters: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
              required: ['cmd'],
            },
            strict: false,
          },
        ],
        stream: true,
      });
      const events = [];
      for await (const e of stream) events.push(e);
      const terminal = events.find((e) => e.type === 'response.completed');
      expect(terminal).toBeTruthy();
      expect(f.admissions).toHaveLength(1);
      expect(f.payloads[0]).toMatchObject({
        model: 'backend-fixture',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the fixture' }] }],
      });
      if (tool)
        expect(
          events.find((e) => e.type === 'response.function_call_arguments.done'),
        ).toMatchObject({ arguments: '{"cmd":"node --test"}' });
      else
        expect(events.find((e) => e.type === 'response.output_text.delta')).toMatchObject({
          delta: 'Observed the fixture.',
        });
    },
  );
for (const tool of [false, true])
  test(
    'independent Google SDK consumes translated ' + (tool ? 'function call' : 'text') + ' stream',
    async () => {
      const f = fixture('google', tool),
        original = globalThis.fetch;
      globalThis.fetch = f.fetcher;
      try {
        const client = new GoogleGenAI({
          apiKey: token,
          httpOptions: { baseUrl: 'http://fixture.local', headers: { 'x-api-key': token } },
        });
        const stream = await client.models.generateContentStream({
          model: 'gemini-fixture',
          contents: [{ role: 'user', parts: [{ text: 'Inspect the fixture' }] }],
          config: {
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'read_file',
                    description: 'Read a file',
                    parametersJsonSchema: {
                      type: 'object',
                      properties: { file_path: { type: 'string' } },
                    },
                  },
                ],
              },
            ],
          },
        });
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        expect(chunks).toHaveLength(1);
        expect(f.admissions).toHaveLength(1);
        if (tool)
          expect(chunks[0]!.functionCalls?.[0]).toMatchObject({
            id: 'toolu_fixture',
            name: 'read_file',
            args: { file_path: 'app.js' },
          });
        else expect(chunks[0]!.text).toBe('Observed the fixture.');
      } finally {
        globalThis.fetch = original;
      }
    },
  );
function request(protocol: 'google' | 'responses', body: any): GatewayRequest {
  return {
    method: 'POST',
    path:
      protocol === 'google'
        ? '/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse'
        : '/v1/responses',
    headers: { 'x-api-key': token },
    body: Buffer.from(JSON.stringify(body)),
  };
}
test('scope persistence failure prevents returning the model tool call and retains the already charged model admission', async () => {
  const seen: unknown[] = [];
  const f = fixture('responses', true, (intent) => {
    seen.push(intent);
    throw Error('durable scope unavailable');
  });
  await expect(
    f.bridge.request(
      request('responses', {
        model: 'codex-fixture',
        input: [{ role: 'user', content: 'Inspect the fixture' }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      }),
    ),
  ).rejects.toThrow('durable scope unavailable');
  expect(seen).toEqual([
    { id: 'toolu_fixture', name: 'exec_command', arguments: { cmd: 'node --test' } },
  ]);
  expect(f.admissions).toHaveLength(1);
});
test('only the frozen tool subset reaches the declared backend, and native server tools are removed', async () => {
  const f = fixture('responses');
  await f.bridge.request(
    request('responses', {
      model: 'codex-fixture',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Scoped work' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'One request' }] },
      ],
      tools: [
        { type: 'function', name: 'exec_command', parameters: { type: 'object' } },
        {
          type: 'namespace',
          name: 'multi_agent_v1',
          tools: [{ type: 'function', name: 'spawn_agent' }],
        },
        { type: 'web_search' },
        { type: 'function', name: 'create_goal', parameters: { type: 'object' } },
      ],
    }),
  );
  expect(f.payloads[0].tools.map((t: any) => t.name)).toEqual(['exec_command']);
  expect(f.payloads[0].system).toBe('Scoped work');
});
test('Google tool results bind the actual call ID and cannot create a foreign call', async () => {
  const f = fixture('google'),
    base = {
      contents: [
        { role: 'user', parts: [{ text: 'Read' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_a', name: 'read_file', args: { file_path: 'app.js' } } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_a',
                name: 'read_file',
                response: { text: 'actual bytes' },
              },
            },
          ],
        },
      ],
    };
  await f.bridge.request(request('google', base));
  expect(f.payloads[0].messages[2].content[0]).toMatchObject({
    type: 'tool_result',
    tool_use_id: 'call_a',
  });
  (base.contents[2]!.parts[0] as { functionResponse: { id: string } }).functionResponse.id =
    'foreign';
  await expect(f.bridge.request(request('google', base))).rejects.toMatchObject({
    code: 'harness_wire_unsupported',
  });
  expect(f.admissions).toHaveLength(1);
});
for (const protocol of ['google', 'responses'] as const)
  test(
    protocol + ' remote images and unowned tool outputs fail before provider admission',
    async () => {
      const f = fixture(protocol),
        bad =
          protocol === 'google'
            ? {
                contents: [
                  {
                    role: 'user',
                    parts: [{ fileData: { fileUri: 'https://outside.invalid/private' } }],
                  },
                ],
              }
            : {
                model: 'codex-fixture',
                input: [{ type: 'function_call_output', call_id: 'foreign', output: 'forged' }],
              };
      await expect(f.bridge.request(request(protocol, bad))).rejects.toMatchObject({
        code: 'harness_wire_unsupported',
      });
      expect(f.admissions).toHaveLength(0);
      expect(f.payloads).toHaveLength(0);
    },
  );
