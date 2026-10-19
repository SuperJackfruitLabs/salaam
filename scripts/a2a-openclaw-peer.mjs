import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Opt-in real plugin transport rehearsal. The agent reply is explicitly a fixture.
const [mode, root] = process.argv.slice(2);
if (
  !['serve', 'send'].includes(mode) ||
  !root ||
  !process.env.SALAAM_A2A_FIXTURE_HOME ||
  process.env.HOME !== process.env.SALAAM_A2A_FIXTURE_HOME
)
  throw Error('Use a prepared plugin and disposable HOME');
const runtime = resolve(root),
  version = JSON.parse(
    readFileSync(join(runtime, 'node_modules/openclaw/package.json'), 'utf8'),
  ).version;
if (version !== '2026.10.5') throw Error('Wrong OpenClaw release');
const lines = createInterface({ input: process.stdin });
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'send') {
  for await (const line of lines) {
    const input = JSON.parse(line),
      { sendA2aChannelText } = await import(pathToFileURL(join(runtime, 'outbound.js')));
    try {
      const receipt = await sendA2aChannelText({
        cfg: {
          channels: {
            a2a: {
              peers: {
                salaam: {
                  token: 'unused-fixture-token',
                  url: input.url,
                  outboundToken: input.token,
                },
              },
            },
          },
        },
        to: 'salaam',
        text: input.text,
      });
      emit({ ok: true, receipt });
    } catch (error) {
      emit({ ok: false, error: error.message });
    }
    break;
  }
} else {
  const { createA2aHttpHandler } = await import(pathToFileURL(join(runtime, 'http.js'))),
    { A2aTaskStore } = await import(pathToFileURL(join(runtime, 'task-store.js')));
  let store = new A2aTaskStore(),
    accepted = 0,
    hold = false;
  const token = process.env.SALAAM_A2A_FIXTURE_TOKEN;
  if (!token) throw Error('Fixture token required');
  const handler = createA2aHttpHandler({
    config: { agents: { list: [{ id: 'main', default: true }] } },
    a2aConfig: { peers: { salaam: { token } }, rateLimitPerMinute: 0 },
    version,
    taskStore: {
      create: (...a) => store.create(...a),
      start: (...a) => store.start(...a),
      get: (...a) => store.get(...a),
      wait: (...a) => store.wait(...a),
      fail: (...a) => store.fail(...a),
    },
    dispatchInbound: async (message) => {
      accepted++;
      if (hold) return;
      await new Promise((r) => setTimeout(r, 50));
      store.completeNext(
        message.contextId,
        'Fixture analysis from the actual OpenClaw A2A plugin; execution and model usage unobserved.',
        message.peerName,
      );
    },
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  emit({
    ready: true,
    version,
    scope: 'actual-pinned-plugin-transport-fixture-agent',
    endpoint: `http://127.0.0.1:${port}/a2a/v1`,
    card: `http://127.0.0.1:${port}/.well-known/agent-card.json`,
  });
  for await (const line of lines) {
    const command = JSON.parse(line);
    if (command.op === 'stats') emit({ accepted });
    else if (command.op === 'forget') {
      store.stop();
      store = new A2aTaskStore();
      emit({ forgotten: true });
    } else if (command.op === 'hold') {
      hold = true;
      emit({ held: true });
    } else if (command.op === 'stop') break;
  }
  store.stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
