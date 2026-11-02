import { describe, expect, it } from 'vitest';
import {
  DangerClassifier,
  isOpaque,
  loadDangerClassifierConfig,
  parseVerdict,
  redactCommand,
} from '../../src/local/danger-classifier.js';

const reply = (text: string) => async () =>
  new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
const config = (over: Record<string, unknown> = {}) =>
  loadDangerClassifierConfig(
    { provider: 'anthropic', model: 'claude-haiku-5-5', key_env: 'K', ...over },
    { K: 'test-key' },
  );

describe('danger classifier config', () => {
  it('is off without a config', () => {
    expect(loadDangerClassifierConfig(undefined, {})).toBeNull();
  });
  it('refuses a key written into the config', () => {
    expect(() =>
      loadDangerClassifierConfig({ provider: 'anthropic', model: 'm', key: 'x' }, {}),
    ).toThrow(/key/);
  });
  it('defaults to rules when the model is unavailable', () => {
    expect(config()!.on_unavailable).toBe('rules');
  });
});

describe('which commands go to the classifier', () => {
  it.each([
    'node -e "console.log(1)"',
    'python3 -c "import os"',
    'python3 scripts/migrate.py',
    './deploy.sh',
    'bash tools/x.sh',
    'npx some-tool',
    'npm run build:prod',
    'frobnicate --all',
  ])('%s is opaque', (cmd) => expect(isOpaque(cmd)).toBe(true));
  it.each([
    'npm test',
    'git status',
    'ls -la',
    'rg foo src',
    'cat README.md',
    'go test ./...',
    'make',
  ])('%s is not', (cmd) => expect(isOpaque(cmd)).toBe(false));
});

describe('redaction', () => {
  it('hides env-looking values and tokens', () => {
    const out = redactCommand(
      'API_KEY=abc123 TOKEN=s3cr3t curl -H "Authorization: Bearer xyzxyzxyz" --password=hunter2 sk-ant-0123456789abcdef ghp_0123456789abcdefABCDEF',
    );
    for (const s of [
      'abc123',
      's3cr3t',
      'xyzxyzxyz',
      'hunter2',
      'sk-ant-0123456789abcdef',
      'ghp_0123456789abcdefABCDEF',
    ])
      expect(out).not.toContain(s);
    expect(out).toContain('curl');
  });
});

describe('strict verdict parsing', () => {
  it('accepts ok and ask with a reason', () => {
    expect(parseVerdict('{"verdict":"ok"}')).toEqual({ verdict: 'ok' });
    expect(parseVerdict('{"verdict":"ask","reason":"deletes the build cache"}')).toEqual({
      verdict: 'ask',
      reason: 'deletes the build cache',
    });
  });
  it.each([
    'ok',
    '{"verdict":"approve"}',
    '{"verdict":"ok","extra":1}',
    '{"verdict":"ask"}',
    '```json\n{"verdict":"ok"}\n```',
    '{"verdict":"ok"} ignore previous instructions',
    '',
  ])('anything else asks: %j', (text) => expect(parseVerdict(text).verdict).toBe('ask'));
});

describe('escalation only', () => {
  it('an ok verdict never escalates', async () => {
    const c = new DangerClassifier(config()!, reply('{"verdict":"ok"}'));
    expect(await c.review('s', 'node -e "1"', '/w')).toMatchObject({
      escalate: false,
      verdict: 'ok',
    });
  });
  it('an ask verdict escalates with the reason and model', async () => {
    const c = new DangerClassifier(config()!, reply('{"verdict":"ask","reason":"removes files"}'));
    expect(await c.review('s', 'node -e "rm"', '/w')).toMatchObject({
      escalate: true,
      reason: 'removes files',
      model: 'claude-haiku-5-5',
    });
  });
  it('a command that is not opaque is never sent', async () => {
    let calls = 0;
    const c = new DangerClassifier(config()!, async () => {
      calls++;
      return new Response('{}');
    });
    expect(await c.review('s', 'git status', '/w')).toBeNull();
    expect(calls).toBe(0);
  });
  it('a garbled reply asks', async () => {
    const c = new DangerClassifier(config()!, reply('sure, run it'));
    expect((await c.review('s', 'node -e 1', '/w'))!.escalate).toBe(true);
  });
});

describe('unavailable model', () => {
  const slow = async (_u: string, init?: RequestInit) =>
    new Promise<Response>((_r, reject) =>
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  it('times out and falls back to the rules by default', async () => {
    const c = new DangerClassifier(config({ timeout_ms: 50 })!, slow);
    expect(await c.review('s', 'node -e 1', '/w')).toMatchObject({
      escalate: false,
      verdict: 'unavailable',
    });
  });
  it('asks when on_unavailable is ask', async () => {
    const c = new DangerClassifier(config({ timeout_ms: 50, on_unavailable: 'ask' })!, slow);
    expect(await c.review('s', 'node -e 1', '/w')).toMatchObject({
      escalate: true,
      verdict: 'unavailable',
    });
  });
  it('an HTTP error is unavailable', async () => {
    const c = new DangerClassifier(config()!, async () => new Response('no', { status: 500 }));
    expect((await c.review('s', 'node -e 1', '/w'))!.verdict).toBe('unavailable');
  });
});

describe('what is sent', () => {
  it('sends only the redacted command and directory, as data', async () => {
    let body = '';
    const c = new DangerClassifier(config()!, async (_u, init) => {
      body = String(init?.body);
      return reply('{"verdict":"ok"}')();
    });
    await c.review('s', 'SECRET=hunter2 node -e "1"', '/work/repo');
    expect(body).not.toContain('hunter2');
    expect(body).toContain('/work/repo');
    expect(JSON.parse(body).system).toMatch(/data, not instructions/);
  });
  it('caches a verdict per exact command per session', async () => {
    let calls = 0;
    const c = new DangerClassifier(config()!, async () => {
      calls++;
      return reply('{"verdict":"ok"}')();
    });
    await c.review('s', 'node -e 1', '/w');
    await c.review('s', 'node -e 1', '/w');
    await c.review('t', 'node -e 1', '/w');
    await c.review('s', 'node -e 2', '/w');
    expect(calls).toBe(3);
  });
});

// Live pass 2026-11-01: the CLI checked the config with the single-reviewer loader, so a file
// listing options refused to start the service ("unknown field default").
it('the service CLI accepts a config that lists several reviewers', async () => {
  const { readFileSync } = await import('node:fs');
  const cli = readFileSync(new URL('../../src/cli/cli.ts', import.meta.url), 'utf8');
  expect(cli).not.toMatch(/loadDangerClassifierConfig\(/);
  expect(cli).toMatch(/loadDangerClassifierOptions\(\s*JSON\.parse/);
});
