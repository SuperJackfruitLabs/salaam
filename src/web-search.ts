import { readFileSync, statSync } from 'node:fs';
import { guardedRequest, type GuardedResponse } from './web-guard.js';
import { decodeEntities, stripTags } from './web-fetch.js';

/**
 * Built-in web search for interactive sessions. Operator ruling 2026-10-31: "Official free APIs
 * go as default and then other providers can be configured as per the user requirement. It could
 * searxng or brave or tavily or exa." Keyless official APIs answer by default, routed by kind;
 * a configured provider answers general queries first. Backends are tried in order, falling
 * through on an error or an empty answer, and every attempt is recorded (never a key).
 */
export type SearchKind = 'general' | 'code' | 'package' | 'paper' | 'wiki';
export const SEARCH_KINDS: readonly SearchKind[] = ['general', 'code', 'package', 'paper', 'wiki'];
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}
export interface Attempt {
  backend: string;
  ok: boolean;
  count?: number;
  ms: number;
  error?: string;
}
export interface SearchOutcome {
  query: string;
  kind: SearchKind;
  results: SearchResult[];
  tried: Attempt[];
  cached?: boolean;
}
export type Transport = (
  url: string,
  opts?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
) => Promise<GuardedResponse>;
export type Provider =
  { type: 'searxng'; url: string } | { type: 'brave' | 'tavily' | 'exa'; key: string };
export interface WebSearchOptions {
  transport?: Transport;
  providers?: Provider[];
  githubToken?: string;
  now?: () => number;
}

type Search = (q: string, limit: number) => Promise<SearchResult[]>;
interface Backend {
  name: string;
  intervalMs: number;
  run: Search;
}
const KEYLESS = ['wikipedia', 'stackexchange', 'github', 'npm', 'pypi', 'arxiv', 'hackernews'];
const ROUTES: Record<Exclude<SearchKind, 'general'>, string[]> = {
  code: ['github', 'stackexchange'],
  package: ['npm', 'pypi'],
  paper: ['arxiv'],
  wiki: ['wikipedia'],
};
const GENERAL_KEYLESS = ['wikipedia', 'stackexchange', 'hackernews'];
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;

const clean = (s: unknown, max = 400) =>
  decodeEntities(stripTags(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const q = encodeURIComponent;

export class WebSearch {
  private readonly transport: Transport;
  private readonly providers: Provider[];
  private readonly now: () => number;
  private readonly backends = new Map<string, Backend>();
  private readonly last = new Map<string, number>();
  private readonly cache = new Map<string, { at: number; value: SearchOutcome }>();
  constructor(opts: WebSearchOptions = {}) {
    this.transport =
      opts.transport ??
      ((url, o = {}) => guardedRequest(url, { ...o, maxBytes: 1_000_000, timeoutMs: 12_000 }));
    this.providers = opts.providers ?? [];
    this.now = opts.now ?? Date.now;
    const json = async (url: string, o?: Parameters<Transport>[1]) => {
      const r = await this.transport(url, {
        ...o,
        headers: { accept: 'application/json', ...o?.headers },
      });
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(r.body) as any;
    };
    const add = (name: string, run: Search, intervalMs = 1000) =>
      this.backends.set(name, { name, run, intervalMs });
    add('wikipedia', async (s, n) =>
      (
        (
          await json(
            `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=${n}&srsearch=${q(s)}`,
          )
        ).query?.search ?? []
      ).map((h: any) => ({
        title: clean(h.title, 200),
        url:
          'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(h.title).replace(/ /g, '_')),
        snippet: clean(h.snippet),
        source: 'wikipedia',
      })),
    );
    add('stackexchange', async (s, n) =>
      (
        (
          await json(
            `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=${n}&q=${q(s)}`,
          )
        ).items ?? []
      ).map((h: any) => ({
        title: clean(h.title, 200),
        url: String(h.link),
        snippet: `score ${h.score ?? 0}${h.is_answered ? ', answered' : ''}`,
        source: 'stackexchange',
      })),
    );
    add(
      'github',
      async (s, n) =>
        (
          (
            await json(`https://api.github.com/search/repositories?per_page=${n}&q=${q(s)}`, {
              headers: {
                accept: 'application/vnd.github+json',
                ...(opts.githubToken ? { authorization: 'Bearer ' + opts.githubToken } : {}),
              },
            })
          ).items ?? []
        ).map((h: any) => ({
          title: clean(h.full_name, 200),
          url: String(h.html_url),
          snippet: `${clean(h.description)} (${h.stargazers_count ?? 0} stars)`.trim(),
          source: 'github',
        })),
      // Unauthenticated repository search allows 10 requests a minute.
      opts.githubToken ? 2000 : 6000,
    );
    add('npm', async (s, n) =>
      (
        (await json(`https://registry.npmjs.org/-/v1/search?size=${n}&text=${q(s)}`)).objects ?? []
      ).map((o: any) => ({
        title: `${clean(o.package?.name, 200)}@${clean(o.package?.version, 40)}`,
        url: String(o.package?.links?.npm ?? `https://www.npmjs.com/package/${o.package?.name}`),
        snippet: clean(o.package?.description),
        source: 'npm',
      })),
    );
    // PyPI has no search API; its official JSON API answers an exact project name.
    add('pypi', async (s) => {
      const name = s.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return [];
      const r = await this.transport(`https://pypi.org/pypi/${q(name)}/json`, {
        headers: { accept: 'application/json' },
      });
      if (r.status === 404) return [];
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
      const info = (JSON.parse(r.body) as any).info ?? {};
      return [
        {
          title: `${clean(info.name, 200)} ${clean(info.version, 40)}`.trim(),
          url: String(info.package_url ?? `https://pypi.org/project/${name}/`),
          snippet: clean(info.summary),
          source: 'pypi',
        },
      ];
    });
    add(
      'arxiv',
      async (s, n) => {
        const r = await this.transport(
          `https://export.arxiv.org/api/query?max_results=${n}&search_query=all:${q(s)}`,
          { headers: { accept: 'application/atom+xml' } },
        );
        if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`);
        return [...r.body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
          const tag = (t: string) =>
            new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(m[1]!)?.[1] ?? '';
          return {
            title: clean(tag('title'), 300),
            url: clean(tag('id'), 300),
            snippet: clean(tag('summary')),
            source: 'arxiv',
          };
        });
      },
      3000,
    );
    add('hackernews', async (s, n) =>
      (
        (await json(`https://hn.algolia.com/api/v1/search?hitsPerPage=${n}&query=${q(s)}`)).hits ??
        []
      ).map((h: any) => ({
        title: clean(h.title ?? h.story_title, 200),
        url: String(h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`),
        snippet: `${h.points ?? 0} points on Hacker News`,
        source: 'hackernews',
      })),
    );
    this.providers.forEach((p, i) => {
      const name =
        this.providers.findIndex((o) => o.type === p.type) === i ? p.type : `${p.type}-${i}`;
      if (p.type === 'searxng')
        add(name, async (s, n) =>
          ((await json(`${p.url.replace(/\/+$/, '')}/search?format=json&q=${q(s)}`)).results ?? [])
            .slice(0, n)
            .map((h: any) => ({
              title: clean(h.title, 200),
              url: String(h.url),
              snippet: clean(h.content),
              source: p.type,
            })),
        );
      else if (p.type === 'brave')
        add(name, async (s, n) =>
          (
            (
              await json(`https://api.search.brave.com/res/v1/web/search?count=${n}&q=${q(s)}`, {
                headers: { 'x-subscription-token': p.key },
              })
            ).web?.results ?? []
          ).map((h: any) => ({
            title: clean(h.title, 200),
            url: String(h.url),
            snippet: clean(h.description),
            source: p.type,
          })),
        );
      else if (p.type === 'tavily')
        add(name, async (s, n) =>
          (
            (
              await json('https://api.tavily.com/search', {
                method: 'POST',
                headers: { authorization: 'Bearer ' + p.key },
                body: JSON.stringify({ query: s, max_results: n }),
              })
            ).results ?? []
          ).map((h: any) => ({
            title: clean(h.title, 200),
            url: String(h.url),
            snippet: clean(h.content),
            source: p.type,
          })),
        );
      else
        add(name, async (s, n) =>
          (
            (
              await json('https://api.exa.ai/search', {
                method: 'POST',
                headers: { 'x-api-key': p.key },
                body: JSON.stringify({ query: s, numResults: n }),
              })
            ).results ?? []
          ).map((h: any) => ({
            title: clean(h.title, 200),
            url: String(h.url),
            snippet: clean(h.text ?? h.summary),
            source: p.type,
          })),
        );
    });
  }
  /** What is enabled, for health and manifests: provider types only, never keys or URLs' secrets. */
  describe(): { providers: string[]; keyless: string[] } {
    return { providers: this.providers.map((p) => p.type), keyless: [...KEYLESS] };
  }
  private order(kind: SearchKind): string[] {
    if (kind !== 'general') return ROUTES[kind];
    const providerNames = [...this.backends.keys()].filter((n) => !KEYLESS.includes(n));
    return [...providerNames, ...GENERAL_KEYLESS];
  }
  async search(input: {
    query: string;
    kind?: SearchKind;
    limit?: number;
  }): Promise<SearchOutcome> {
    const query = String(input.query ?? '')
      .trim()
      .slice(0, 300);
    if (!query) throw new Error('An empty query cannot be searched');
    const kind = input.kind ?? 'general';
    if (!SEARCH_KINDS.includes(kind)) throw new Error('Unknown search kind');
    const limit = Math.max(1, Math.min(10, Math.floor(input.limit ?? 5)));
    const key = `${kind}\u0000${query.toLowerCase()}\u0000${limit}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, cached: true };
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    const tried: Attempt[] = [];
    for (const name of this.order(kind)) {
      if (results.length >= limit) break;
      const b = this.backends.get(name)!;
      const last = this.last.get(name);
      if (last !== undefined && this.now() - last < b.intervalMs) {
        tried.push({ backend: name, ok: false, ms: 0, error: 'rate-limited' });
        continue;
      }
      this.last.set(name, this.now());
      const started = Date.now();
      try {
        const got = await b.run(query, limit - results.length);
        let count = 0;
        for (const r of got) {
          if (!/^https?:\/\//.test(r.url) || seen.has(r.url)) continue;
          seen.add(r.url);
          results.push(r);
          count++;
          if (results.length >= limit) break;
        }
        tried.push({ backend: name, ok: true, count, ms: Date.now() - started });
      } catch (error) {
        tried.push({
          backend: name,
          ok: false,
          ms: Date.now() - started,
          error: String((error as Error).message ?? error).slice(0, 200),
        });
      }
    }
    const value: SearchOutcome = { query, kind, results, tried };
    // Cache only a complete answer: one assembled around a skipped or failing backend would
    // keep that gap for the cache's lifetime.
    if (results.length && tried.every((t) => t.ok)) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: this.now(), value });
    }
    return value;
  }
}

/** Reads the operator's web search config: providers in order, keys from env or a private file. */
export function loadWebSearchConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): { providers: Provider[]; githubToken?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Web search config ${path} is not readable JSON`);
  }
  const top = raw as Record<string, unknown>;
  if (!top || typeof top !== 'object' || Array.isArray(top))
    throw new Error('Web search config must be an object');
  for (const k of Object.keys(top))
    if (!['providers', 'github_token_env'].includes(k))
      throw new Error(`Web search config: unknown field ${k}`);
  const secret = (p: Record<string, unknown>, label: string): string => {
    const hasEnv = typeof p.key_env === 'string' && p.key_env;
    const hasFile = typeof p.key_file === 'string' && p.key_file;
    if ('key' in p || (!hasEnv && !hasFile) || (hasEnv && hasFile))
      throw new Error(`${label} needs exactly one of key_env or key_file (never the key itself)`);
    if (hasEnv) {
      const v = env[p.key_env as string];
      if (!v) throw new Error(`${label}: ${p.key_env} is not set`);
      return v.trim();
    }
    const file = p.key_file as string;
    const st = statSync(file);
    if (st.mode & 0o077) throw new Error(`${label}: ${file} is readable by others; chmod 600 it`);
    return readFileSync(file, 'utf8').trim();
  };
  const providers: Provider[] = [];
  const list = top.providers ?? [];
  if (!Array.isArray(list) || list.length > 8)
    throw new Error('providers must be a list of up to 8');
  list.forEach((entry, i) => {
    const p = entry as Record<string, unknown>;
    const label = `providers[${i}]`;
    const type = p?.type;
    if (type === 'searxng') {
      for (const k of Object.keys(p))
        if (!['type', 'url'].includes(k)) throw new Error(`${label}: unknown field ${k}`);
      let u: URL;
      try {
        u = new URL(String(p.url));
      } catch {
        throw new Error(`${label}: url must be http or https`);
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        throw new Error(`${label}: url must be http or https`);
      providers.push({ type, url: u.toString() });
    } else if (type === 'brave' || type === 'tavily' || type === 'exa') {
      for (const k of Object.keys(p))
        if (!['type', 'key_env', 'key_file', 'key'].includes(k))
          throw new Error(`${label}: unknown field ${k}`);
      providers.push({ type, key: secret(p, label) });
    } else throw new Error(`${label}: unknown provider (searxng, brave, tavily or exa)`);
  });
  const ghEnv = top.github_token_env;
  if (ghEnv !== undefined && typeof ghEnv !== 'string')
    throw new Error('github_token_env must be a name');
  const githubToken = ghEnv ? env[ghEnv] : undefined;
  return { providers, ...(githubToken ? { githubToken } : {}) };
}
