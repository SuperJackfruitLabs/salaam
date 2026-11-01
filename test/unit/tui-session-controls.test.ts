import { test, expect } from 'vitest';
import { SalaamApp } from '../../src/tui/app.js';
import { status, compactTokens } from '../../src/tui/view.js';
import { SalaamTheme } from '../../src/tui/theme.js';
import { instructionsLabel } from '../../src/tui/client.js';
import { SLASH_COMMANDS, INIT_INSTRUCTION } from '../../src/tui/commands.js';
import type { SessionSnapshot } from '../../src/core/protocol.js';

const files = [
  { scope: 'user' as const, path: '~/.config/salaam/AGENTS.md', sha256: 'a', bytes: 1 },
  { scope: 'project' as const, path: 'AGENTS.md', sha256: 'b', bytes: 1 },
];

test('the status line names the loaded instructions and the session’s tokens and cost', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-session-controls' });
  app.client.snapshot = {
    id: 'session-1234',
    state: 'ready',
    approvals: [],
    attempts: [],
    capabilities: [],
    project_instructions: { digest: 'd', revision: 1, files, skipped: [] },
  } as unknown as SessionSnapshot;
  app.client.usage = {
    observations: 3,
    unknown_observations: 0,
    known_input: 11_000,
    known_output: 1_400,
    known_cost: 0.0412,
    estimated_cost: 0,
  } as never;
  const line = status({ client: app.client, theme: new SalaamTheme('night', false) } as never, 160)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
  expect(line).toContain('Using AGENTS.md (2 files)');
  expect(line).toContain('12k tokens · $0.04');
});

test('usage counts cached input and adds recorded and estimated cost', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-session-controls' });
  app.client.snapshot = {
    id: 'session-1234',
    state: 'ready',
    approvals: [],
    attempts: [],
    capabilities: [],
  } as unknown as SessionSnapshot;
  // What a cached Anthropic turn records: 20 uncached input tokens, the rest from the cache.
  app.client.usage = {
    observations: 2,
    unknown_observations: 0,
    estimated_observations: 1,
    known_input: 20,
    known_cache_read: 18_000,
    known_cache_write: 2_000,
    known_output: 561,
    known_cost: 0.03,
    estimated_cost: 0.02,
  } as never;
  const line = status({ client: app.client, theme: new SalaamTheme('night', false) } as never, 160)
    .join('\n')
    .replace(/\x1b\[[0-9;]*m/g, '');
  expect(line).toContain('21k tokens · $0.05');
});

test('labels and compact counts', () => {
  expect(instructionsLabel({ digest: 'd', revision: 1, files: [files[1]!], skipped: [] })).toBe(
    'AGENTS.md',
  );
  expect(
    instructionsLabel({
      digest: 'd',
      revision: 1,
      files: [files[1]!, { ...files[1]!, path: 'pkg/CLAUDE.md' }],
      skipped: [],
    }),
  ).toBe('AGENTS.md + CLAUDE.md (2 files)');
  expect([950, 12_400, 2_300_000].map(compactTokens)).toEqual(['950', '12k', '2.3M']);
});

test('/model, /provider and /thinking describe switching this session; /init exists', () => {
  const describe = (name: string) => SLASH_COMMANDS.find((c) => c.name === name)!.description;
  for (const name of ['model', 'provider', 'thinking'])
    expect(describe(name)).not.toContain('new session');
  expect(describe('init')).toContain('AGENTS.md');
  expect(INIT_INSTRUCTION).toContain('AGENTS.md');
});

test('the provider picker opens on the configured provider, with the demo last', () => {
  const app = new SalaamApp({ state: '/tmp/salaam-session-controls-picker' });
  app.client.snapshot = {
    id: 's',
    provider_route: { provider: 'openai', model: 'gpt-5' },
  } as unknown as SessionSnapshot;
  const seen: { title: string; options: { value: string }[] }[] = [];
  (app as unknown as { choice: unknown }).choice = (title: string, options: { value: string }[]) =>
    seen.push({ title, options });
  (app as unknown as { modelPicker(): void }).modelPicker();
  expect(seen[0]!.title).toBe('Provider · switches this session');
  expect(seen[0]!.options[0]!.value).toBe('openai');
  expect(seen[0]!.options.at(-1)!.value).toBe('offline');
});
