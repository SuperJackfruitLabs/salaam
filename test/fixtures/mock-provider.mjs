import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { EventStreamCodec } from '@smithy/core/event-streams';
const dir = process.argv[2];
const stats = { count: 0, auth_count: 0, bodies: [] };
const server = createServer(async (req, res) => {
  if (req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url === '/token') {
    for await (const _ of req) {
    }
    stats.auth_count++;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        access_token: 'fixture-provider-key',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const raw = (
    req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(bytes) : bytes
  ).toString('utf8');
  if (!raw) {
    console.error('Empty fixture request: ' + req.method + ' ' + req.url);
    res.writeHead(400);
    res.end();
    return;
  }
  const payload = JSON.parse(raw);
  stats.count++;
  stats.bodies.push({
    url: req.url,
    body: payload,
    callback: req.headers['x-salaam-test'] === 'callback',
    sigv4: String(req.headers.authorization).startsWith('AWS4-HMAC-SHA256 Credential=AKIAFIXTURE'),
    authenticated: [
      'authorization',
      'x-api-key',
      'api-key',
      'x-goog-api-key',
      'cf-aig-authorization',
    ].some((key) => String(req.headers[key]).includes('fixture-provider-key')),
  });
  const mode = readFileSync(join(dir, 'provider-mode'), 'utf8');
  if (/^\d+$/.test(mode)) {
    res.writeHead(Number(mode), { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'SECRET fixture-provider-key' } }));
    return;
  }
  const api = readFileSync(join(dir, 'provider-api'), 'utf8');
  if (mode === 'hold') {
    res.writeHead(200, {
      'content-type':
        api === 'bedrock-converse-stream'
          ? 'application/vnd.amazon.eventstream'
          : 'text/event-stream',
    });
    res.flushHeaders();
    writeFileSync(join(dir, 'provider-entered'), 'yes');
    return;
  }
  const text = 'Provider fixture complete.';
  const hasResult =
    JSON.stringify(payload).includes('tool_result') ||
    JSON.stringify(payload).includes('function_call_output') ||
    JSON.stringify(payload).includes('functionResponse') ||
    JSON.stringify(payload).includes('toolResult') ||
    JSON.stringify(payload).includes('"role":"tool"') ||
    JSON.stringify(payload).includes('"role":"toolResult"');
  const child = mode === 'child' && payload.tools?.some((t) => t.name === 'spawn_child');
  const tool = (mode === 'tool' || child) && !hasResult;
  const usage = {
    input: 12,
    output: 8,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (api === 'bedrock-converse-stream') {
    res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' });
    const codec = new EventStreamCodec(
      (v) => Buffer.from(v).toString('utf8'),
      (v) => Buffer.from(v),
    );
    const event = (type, body) =>
      res.write(
        codec.encode({
          headers: {
            ':message-type': { type: 'string', value: 'event' },
            ':event-type': { type: 'string', value: type },
            ':content-type': { type: 'string', value: 'application/json' },
          },
          body: Buffer.from(JSON.stringify(body)),
        }),
      );
    event('messageStart', { role: 'assistant' });
    event('contentBlockStart', {
      contentBlockIndex: 0,
      start: tool ? { toolUse: { toolUseId: 'probe_call', name: 'salaam_probe' } } : {},
    });
    event('contentBlockDelta', {
      contentBlockIndex: 0,
      delta: tool ? { toolUse: { input: '{}' } } : { text },
    });
    event('contentBlockStop', { contentBlockIndex: 0 });
    event('messageStop', { stopReason: tool ? 'tool_use' : 'end_turn' });
    event('metadata', { usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) => {
    if (mode === 'missing-usage') {
      if (data.response) delete data.response.usage;
      if (data.usage) data.usage = {};
      if (data.message?.usage) data.message.usage = {};
    }
    return res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  const data = (value) => {
    if (mode === 'missing-usage') {
      delete value.usage;
      delete value.usageMetadata;
    }
    res.write(`data: ${JSON.stringify(value)}\n\n`);
  };
  if (['google-generative-ai', 'google-vertex'].includes(api)) {
    data({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [tool ? { functionCall: { name: 'salaam_probe', args: {} } } : { text }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      responseId: 'fixture-response',
    });
  } else if (api === 'anthropic-messages') {
    event('message_start', {
      message: {
        id: 'fixture-response',
        type: 'message',
        role: 'assistant',
        content: [],
        model: payload.model,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    });
    event('content_block_start', {
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: 'probe_call', name: 'salaam_probe', input: {} }
        : { type: 'text', text: '' },
    });
    event('content_block_delta', {
      index: 0,
      delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text },
    });
    event('content_block_stop', { index: 0 });
    event('message_delta', {
      delta: {
        stop_reason: tool
          ? 'tool_use'
          : mode === 'max-output'
            ? 'max_tokens'
            : mode === 'refusal'
              ? 'refusal'
              : 'end_turn',
      },
      usage: { output_tokens: 8 },
    });
    event('message_stop', {});
  } else if (
    ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api)
  ) {
    const item = tool
      ? {
          type: 'function_call',
          id: 'fc_probe',
          call_id: 'probe_call',
          name: child ? 'spawn_child' : 'salaam_probe',
          arguments: child
            ? JSON.stringify({
                step_key: 'child-fixture',
                prompt: 'Reply once',
                budget: 1,
                wait: true,
              })
            : '{}',
          status: 'completed',
        }
      : {
          type: 'message',
          role: 'assistant',
          id: 'msg_fixture',
          content: [{ type: 'output_text', text, annotations: [] }],
          status: 'completed',
        };
    event('response.created', { response: { id: 'fixture-response', status: 'in_progress' } });
    event('response.output_item.added', {
      output_index: 0,
      item: tool ? { ...item, arguments: '' } : { ...item, content: [] },
    });
    if (tool) {
      event('response.function_call_arguments.delta', {
        output_index: 0,
        item_id: item.id,
        delta: item.arguments,
      });
      event('response.function_call_arguments.done', {
        output_index: 0,
        item_id: item.id,
        arguments: item.arguments,
      });
    } else {
      event('response.content_part.added', {
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      event('response.output_text.delta', { output_index: 0, content_index: 0, delta: text });
      event('response.output_text.done', { output_index: 0, content_index: 0, text });
    }
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', {
      response: {
        id: 'fixture-response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      },
    });
  } else if (api === 'pi-messages') {
    event('start', {});
    if (tool) {
      event('toolcall_start', { contentIndex: 0, id: 'probe_call', toolName: 'salaam_probe' });
      event('toolcall_delta', { contentIndex: 0, delta: '{}' });
      event('toolcall_end', {
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'probe_call', name: 'salaam_probe', arguments: {} },
      });
    } else {
      event('text_start', { contentIndex: 0 });
      event('text_delta', { contentIndex: 0, delta: text });
      event('text_end', { contentIndex: 0, content: text });
    }
    event('done', { reason: tool ? 'toolUse' : 'stop', usage, responseId: 'fixture-response' });
  } else {
    data({
      id: 'fixture-response',
      object: 'chat.completion.chunk',
      choices: [
        {
          index: 0,
          delta: tool
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'probe_call',
                    type: 'function',
                    function: { name: 'salaam_probe', arguments: '{}' },
                  },
                ],
              }
            : { role: 'assistant', content: text },
          finish_reason: null,
        },
      ],
    });
    data({
      id: 'fixture-response',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    });
    res.write('data: [DONE]\n\n');
  }
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dir, 'provider-port'), String(server.address().port));
  process.stdout.write('ready\n');
});
