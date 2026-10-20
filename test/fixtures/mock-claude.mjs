import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
let count = 0;
const bodies = [];
const server = createServer(async (req, res) => {
  if (req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ count, bodies }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  count++;
  bodies.push({
    body,
    callback: req.headers['x-salaam-test'] === 'callback',
    authenticated: req.headers['x-api-key'] === 'fixture-anthropic-key',
    workspace: req.headers['anthropic-workspace-id'] ?? null,
  });
  const mode = readFileSync(join(dir, 'claude-mode'), 'utf8');
  if (mode === '401' || mode === '429') {
    res.writeHead(Number(mode), { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: mode === '401' ? 'authentication_error' : 'rate_limit_error',
          message: 'SECRET ' + req.headers['x-api-key'],
        },
      }),
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', {
    message: {
      id: 'msg_' + count,
      type: 'message',
      role: 'assistant',
      content: [],
      model: body.model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
  });
  if (mode === 'hold') {
    writeFileSync(join(dir, 'claude-entered'), 'hold');
    return;
  }
  if (mode === 'drop') {
    res.destroy();
    return;
  }
  const hasResult = JSON.stringify(body.messages).includes('tool_result');
  if (
    !hasResult &&
    (mode === 'tool' ||
      mode === 'mcp' ||
      mode === 'mcp-mutate' ||
      (mode === 'children' && body.tools.some((tool) => tool.name === 'spawn_child')))
  ) {
    const spawnChild = mode === 'children';
    const name = spawnChild
      ? 'spawn_child'
      : mode === 'mcp' || mode === 'mcp-mutate'
        ? 'salaam_mcp'
        : 'salaam_probe';
    const args = spawnChild
      ? { step_key: 'child-step', prompt: 'Child greeting', budget: 2, wait: true }
      : mode === 'mcp' || mode === 'mcp-mutate'
        ? {
            action: 'call',
            server: 'superlibrary',
            tool: mode === 'mcp-mutate' ? 'fixture_mutate' : 'library_search',
            arguments: { query: 'offline provider tool inventory proof' },
          }
        : {};
    event('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: 'tool_' + count, name, input: {} },
    });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) },
    });
  } else {
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text: 'Claude fixture complete.' },
    });
  }
  event('content_block_stop', { index: 0 });
  event('message_delta', {
    delta: {
      stop_reason:
        !hasResult &&
        (mode === 'tool' ||
          mode === 'mcp' ||
          mode === 'mcp-mutate' ||
          (mode === 'children' && body.tools.some((tool) => tool.name === 'spawn_child')))
          ? 'tool_use'
          : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: 8 },
  });
  event('message_stop', {});
  res.end();
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dir, 'claude-port'), String(server.address().port));
  process.stdout.write('started\n');
});
