import { afterEach, expect, test } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Phase 4 (modularity): everything the house extension registers with Pi (tools with their
// names, labels, descriptions, schemas and annotations; event hooks; providers), in order, is
// pinned for representative worker configurations, so splitting the extension cannot change
// what Pi sees. The system prompt the before_agent_start hooks build is pinned too, with the
// host platform's note replaced by a name.

const BASE = {
  socket: '/nonexistent/bridge.sock',
  token: 't',
  session: 's',
  epoch: 1,
  bundle: 'b',
  policy: 'p',
  frame: 'f',
};

const CONFIGS: Record<string, Record<string, unknown>> = {
  plain: {},
  effects: { effects: true },
  child: {
    child: true,
    worker_binding: {
      binding: { tools: ['salaam_findings', 'salaam_probe', 'salaam_repository', 'salaam_team'] },
    },
  },
  managed: {
    mcp: { servers: [] },
    operator_mcp: [{ name: 'docs' }],
    mcp_servers: [{ name: 'docs' }],
    toolkit: { profile: 'x' },
    station: { workspace: 'w' },
  },
  coding: { coding: { workspace_id: 'w', files: true, commands: true, profile_digest: null } },
  local: { local: true },
  'local coding': { local: true, localCoding: true },
  persona: { persona: { text: 'Speak plainly.', digest: 'd' } },
  provider: { route: { provider: 'anthropic', model: 'claude-sonnet-4-5', max_tokens: 1024 } },
};

/** JSON with functions named, so a schema or option that changes shows up and a handler does not. */
const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'function' ? '[function]' : v)),
  );

type Prompt = (event: { type: string; systemPrompt: string }) => unknown;
const isPrompt = (h: unknown): h is Prompt => typeof h === 'function';

const saved = process.env.SALAAM_WORKER_CONFIG;
afterEach(() => {
  if (saved === undefined) delete process.env.SALAAM_WORKER_CONFIG;
  else process.env.SALAAM_WORKER_CONFIG = saved;
});

async function registrations(config: Record<string, unknown>) {
  process.env.SALAAM_WORKER_CONFIG = JSON.stringify({ ...BASE, ...config });
  const calls: unknown[] = [];
  const prompts: Prompt[] = [];
  const pi = new Proxy<ExtensionAPI>(Object.create(null), {
    get:
      (_t, key) =>
      (...args: unknown[]) => {
        calls.push({ [String(key)]: plain(args) });
        const handler = args[1];
        if (key === 'on' && args[0] === 'before_agent_start' && isPrompt(handler))
          prompts.push(handler);
        return undefined;
      },
  });
  const { default: house } = await import('../../src/runtime/house-extension.js');
  house(pi);
  let prompt = 'Base prompt.';
  for (const h of prompts) {
    const r: unknown = await h({ type: 'before_agent_start', systemPrompt: prompt });
    if (r && typeof r === 'object' && 'systemPrompt' in r && typeof r.systemPrompt === 'string')
      prompt = r.systemPrompt;
  }
  return {
    calls,
    prompt: prompt.replace(/Commands run on .*?(?= Explain those limits)/s, '<platform>'),
  };
}

for (const [name, config] of Object.entries(CONFIGS))
  test(`the house extension registers the same things with Pi: ${name}`, async () => {
    expect(await registrations(config)).toMatchSnapshot();
  });
