import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSearch, loadWebSearchConfig, type Transport } from '../../src/web/search.js';

// Operator ruling 2026-10-31: "Official free APIs go as default and then other providers can be
// configured as per the user requirement. It could searxng or brave or tavily or exa."

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function fakeTransport(
  routes: Record<string, (c: Call) => unknown>,
  calls: Call[] = [],
): Transport {
  return async (url, opts = {}) => {
    const call: Call = {
      url,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      body: opts.body,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error('no route for ' + url);
    const out = routes[key]!(call);
    if (out instanceof Error) throw out;
    return {
      status: 200,
      url,
      truncated: false,
      contentType: typeof out === 'string' ? 'application/atom+xml' : 'application/json',
      body: typeof out === 'string' ? out : JSON.stringify(out),
    };
  };
}

const wiki = {
  query: {
    search: [{ title: 'HTTP 403', snippet: 'The <span>403</span> status', pageid: 1 }],
  },
};
const stack = {
  items: [
    {
      title: 'Why does curl return 403?',
      link: 'https://stackoverflow.com/q/1',
      score: 5,
      is_answered: true,
    },
  ],
};
const github = {
  items: [
    {
      full_name: 'owner/repo',
      html_url: 'https://github.com/owner/repo',
      description: 'A repo',
      stargazers_count: 10,
    },
  ],
};
const npm = {
  objects: [
    {
      package: {
        name: 'left-pad',
        version: '1.3.0',
        description: 'pad',
        links: { npm: 'https://www.npmjs.com/package/left-pad' },
      },
    },
  ],
};
const hn = {
  hits: [{ title: 'Show HN: thing', url: 'https://example.com/thing', objectID: '9', points: 3 }],
};
const arxiv = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.00001v1</id><title>A Paper  on Agents</title><summary> We study agents. </summary></entry></feed>`;
const pypi = {
  info: {
    name: 'requests',
    version: '2.32.0',
    summary: 'HTTP for Humans',
    package_url: 'https://pypi.org/project/requests/',
  },
};

const keyless = {
  'https://en.wikipedia.org/w/api.php': () => wiki,
  'https://api.stackexchange.com/2.3/search/advanced': () => stack,
  'https://api.github.com/search/repositories': () => github,
  'https://registry.npmjs.org/-/v1/search': () => npm,
  'https://pypi.org/pypi/': () => pypi,
  'https://export.arxiv.org/api/query': () => arxiv,
  'https://hn.algolia.com/api/v1/search': () => hn,
};

test('kind routes to the official keyless backends, and every result carries its source URL', async () => {
  const ws = new WebSearch({ transport: fakeTransport(keyless) });
  const code = await ws.search({ query: 'curl 403', kind: 'code', limit: 5 });
  expect(code.tried.map((t) => t.backend)).toEqual(['github', 'stackexchange']);
  expect(code.results.map((r) => r.url)).toEqual([
    'https://github.com/owner/repo',
    'https://stackoverflow.com/q/1',
  ]);
  const pkg = await ws.search({ query: 'left-pad', kind: 'package', limit: 5 });
  expect(pkg.results[0]).toMatchObject({
    url: 'https://www.npmjs.com/package/left-pad',
    source: 'npm',
  });
  const paper = await ws.search({ query: 'agents', kind: 'paper', limit: 5 });
  expect(paper.results[0]).toMatchObject({
    url: 'http://arxiv.org/abs/2401.00001v1',
    title: 'A Paper on Agents',
    source: 'arxiv',
  });
  const w = await ws.search({ query: 'http 403', kind: 'wiki', limit: 5 });
  expect(w.results[0]).toMatchObject({
    url: 'https://en.wikipedia.org/wiki/HTTP_403',
    snippet: 'The 403 status',
  });
  for (const r of [...code.results, ...pkg.results, ...paper.results, ...w.results])
    expect(r.url).toMatch(/^https?:\/\//);
});

test('a failing backend falls through to the next; every attempt is recorded', async () => {
  const ws = new WebSearch({
    transport: fakeTransport({
      ...keyless,
      'https://api.github.com/search/repositories': () => new Error('HTTP 403 rate limited'),
    }),
  });
  const out = await ws.search({ query: 'curl 403', kind: 'code', limit: 5 });
  expect(out.results.map((r) => r.source)).toEqual(['stackexchange']);
  expect(out.tried[0]).toMatchObject({ backend: 'github', ok: false });
  expect(out.tried[0]!.error).toContain('rate limited');
  expect(out.tried[1]).toMatchObject({ backend: 'stackexchange', ok: true, count: 1 });
  expect(typeof out.tried[1]!.ms).toBe('number');
});

test('general merges keyless backends when no provider is configured', async () => {
  const ws = new WebSearch({ transport: fakeTransport(keyless) });
  const out = await ws.search({ query: 'http 403', limit: 10 });
  expect(out.tried.map((t) => t.backend)).toEqual(['wikipedia', 'stackexchange', 'hackernews']);
  expect(new Set(out.results.map((r) => r.source))).toEqual(
    new Set(['wikipedia', 'stackexchange', 'hackernews']),
  );
});

test('a configured general provider is tried first, then the keyless set if it fails', async () => {
  const calls: Call[] = [];
  const brave = {
    web: { results: [{ title: 'Brave hit', url: 'https://brave.example/a', description: 'd' }] },
  };
  const ws = new WebSearch({
    transport: fakeTransport(
      { ...keyless, 'https://api.search.brave.com/res/v1/web/search': () => brave },
      calls,
    ),
    providers: [{ type: 'brave', key: 'brave-secret-key' }],
  });
  const out = await ws.search({ query: 'http 403', limit: 3 });
  expect(out.tried[0]).toMatchObject({ backend: 'brave', ok: true });
  expect(out.results[0]!.url).toBe('https://brave.example/a');
  expect(calls[0]!.headers['x-subscription-token']).toBe('brave-secret-key');
  // The key never appears in what the tool returns or records.
  expect(JSON.stringify(out)).not.toContain('brave-secret-key');

  const failing = new WebSearch({
    transport: fakeTransport({
      ...keyless,
      'https://api.search.brave.com/res/v1/web/search': () => new Error('HTTP 401'),
    }),
    providers: [{ type: 'brave', key: 'k' }],
  });
  const fell = await failing.search({ query: 'http 403', limit: 3 });
  expect(fell.tried.map((t) => t.backend)).toEqual(
    ['brave', 'wikipedia', 'stackexchange', 'hackernews'].slice(0, fell.tried.length),
  );
  expect(fell.results.length).toBeGreaterThan(0);
});

test('searxng, tavily and exa adapters send their documented request shapes', async () => {
  const calls: Call[] = [];
  const ws = new WebSearch({
    transport: fakeTransport(
      {
        'https://searx.example/search': () => ({
          results: [{ title: 'S', url: 'https://s.example/', content: 'c' }],
        }),
        'https://api.tavily.com/search': () => ({
          results: [{ title: 'T', url: 'https://t.example/', content: 'c' }],
        }),
        'https://api.exa.ai/search': () => ({
          results: [{ title: 'E', url: 'https://e.example/', text: 'c' }],
        }),
      },
      calls,
    ),
    providers: [
      { type: 'searxng', url: 'https://searx.example' },
      { type: 'tavily', key: 'tv' },
      { type: 'exa', key: 'ex' },
    ],
  });
  const s = await ws.search({ query: 'q', limit: 1 });
  expect(s.tried).toHaveLength(1);
  expect(calls[0]!.url).toContain('format=json');
  expect(calls[0]!.url).toContain('q=q');
  const providersOnly = (n: number) =>
    new WebSearch({
      transport: fakeTransport(
        {
          'https://api.tavily.com/search': () => ({
            results: [{ title: 'T', url: 'https://t.example/', content: 'c' }],
          }),
          'https://api.exa.ai/search': () => ({
            results: [{ title: 'E', url: 'https://e.example/', text: 'c' }],
          }),
        },
        calls,
      ),
      providers: n === 0 ? [{ type: 'tavily', key: 'tv' }] : [{ type: 'exa', key: 'ex' }],
    });
  await providersOnly(0).search({ query: 'q', limit: 1 });
  const tav = calls.at(-1)!;
  expect(tav.method).toBe('POST');
  expect(tav.headers.authorization).toBe('Bearer tv');
  await providersOnly(1).search({ query: 'q', limit: 1 });
  const exa = calls.at(-1)!;
  expect(exa.method).toBe('POST');
  expect(exa.headers['x-api-key']).toBe('ex');
});

test('repeat queries come from the cache; a rate-limited backend is skipped, not waited on', async () => {
  let n = 0;
  let now = 1_000_000;
  const ws = new WebSearch({
    transport: fakeTransport({
      ...keyless,
      'https://api.github.com/search/repositories': () => {
        n++;
        return github;
      },
    }),
    now: () => now,
  });
  await ws.search({ query: 'x', kind: 'code', limit: 1 });
  const again = await ws.search({ query: 'x', kind: 'code', limit: 1 });
  expect(n).toBe(1);
  expect(again.cached).toBe(true);
  // A different query to the same backend inside its interval is skipped and recorded.
  const other = await ws.search({ query: 'y', kind: 'code', limit: 1 });
  expect(other.tried[0]).toMatchObject({ backend: 'github', ok: false, error: 'rate-limited' });
  now += 60_000;
  const later = await ws.search({ query: 'y', kind: 'code', limit: 1 });
  expect(later.tried[0]).toMatchObject({ backend: 'github', ok: true });
});

test('config: keys come from env or a private file, are validated, and never leave describe()', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-cfg-'));
  const keyFile = join(dir, 'exa.key');
  writeFileSync(keyFile, 'exa-secret\n');
  chmodSync(keyFile, 0o600);
  const cfg = join(dir, 'web.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      providers: [
        { type: 'searxng', url: 'https://searx.example' },
        { type: 'brave', key_env: 'TEST_BRAVE_KEY' },
        { type: 'exa', key_file: keyFile },
      ],
    }),
  );
  const loaded = loadWebSearchConfig(cfg, { TEST_BRAVE_KEY: 'brave-secret' });
  expect(loaded.providers.map((p) => p.type)).toEqual(['searxng', 'brave', 'exa']);
  const ws = new WebSearch({ transport: fakeTransport({}), providers: loaded.providers });
  expect(ws.describe()).toEqual({
    providers: ['searxng', 'brave', 'exa'],
    keyless: ['wikipedia', 'stackexchange', 'github', 'npm', 'pypi', 'arxiv', 'hackernews'],
  });
  expect(JSON.stringify(ws.describe())).not.toMatch(/secret/);

  const bad = (providers: unknown, env: Record<string, string> = {}) => {
    writeFileSync(cfg, JSON.stringify({ providers }));
    return () => loadWebSearchConfig(cfg, env);
  };
  expect(bad([{ type: 'google' }])).toThrow(/unknown provider/);
  expect(bad([{ type: 'brave' }])).toThrow(/key_env or key_file/);
  expect(bad([{ type: 'brave', key: 'inline' }])).toThrow(/key_env or key_file/);
  // An inline key is refused even beside a valid key reference: keys never live in the config.
  expect(
    bad([{ type: 'brave', key: 'inline', key_env: 'TEST_BRAVE_KEY' }], { TEST_BRAVE_KEY: 'b' }),
  ).toThrow(/key_env or key_file/);
  expect(bad([{ type: 'brave', key_env: 'MISSING' }])).toThrow(/MISSING is not set/);
  expect(bad([{ type: 'searxng', url: 'ftp://x' }])).toThrow(/http or https/);
  writeFileSync(keyFile, 'k');
  chmodSync(keyFile, 0o644);
  expect(bad([{ type: 'exa', key_file: keyFile }])).toThrow(/readable by others/);
  // Errors never echo a key value.
  try {
    bad([{ type: 'brave', key_env: 'TEST_BRAVE_KEY', extra: 1 }], {
      TEST_BRAVE_KEY: 'zzz-secret',
    })();
  } catch (e) {
    expect(String(e)).not.toContain('zzz-secret');
  }
});
