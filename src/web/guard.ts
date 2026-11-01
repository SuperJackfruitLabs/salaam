import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Outbound HTTP for web search and fetch. These run in the daemon, outside the command sandbox, so
 * every connection is checked at connect time: the URL's literal address, every address its name
 * resolves to (a DNS answer that mixes public and private is refused, so rebinding cannot land on
 * a private one), and every redirect hop. Bodies are capped and requests time out.
 */
const denied = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  denied.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  denied.addSubnet(net, bits, 'ipv6');

/** True only for globally routable unicast addresses. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(bare);
  if (!family) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:/i.test(bare)) return false;
    return !denied.check(bare, 'ipv6');
  }
  return !denied.check(bare, 'ipv4');
}

export interface Resolved {
  address: string;
  family: number;
}
export interface GuardOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Injected resolver (tests); defaults to the system resolver, all addresses. */
  lookup?: (host: string) => Promise<Resolved[]>;
  /** Tests only: a loopback test server may be reached. */
  allowLoopbackForTests?: boolean;
  /** Tests only: loopback is allowed on the first hop but not after a redirect. */
  allowLoopbackOnlyFirstHop?: boolean;
}
export interface GuardedResponse {
  status: number;
  url: string;
  body: string;
  truncated: boolean;
  contentType: string;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);
function allowed(address: string, loopbackOk: boolean): boolean {
  return isPublicAddress(address) || (loopbackOk && LOOPBACK.has(address));
}
function refuse(host: string): Error {
  return new Error(`Refused: ${host} is not a public address`);
}

export async function guardedRequest(
  rawUrl: string,
  opts: GuardOptions,
  hop = 0,
): Promise<GuardedResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only http or https URLs can be fetched');
  if (url.username || url.password) throw new Error('URLs with credentials are refused');
  const loopbackOk = !!opts.allowLoopbackForTests && !(opts.allowLoopbackOnlyFirstHop && hop > 0);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !allowed(host, loopbackOk)) throw refuse(host);
  const resolve = opts.lookup ?? (async (h: string) => dnsLookup(h, { all: true, verbatim: true }));
  // Resolve once here, refuse if any answer is private, then connect only to a checked address.
  const addresses: Resolved[] = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host);
  if (!addresses.length || addresses.some((a) => !allowed(a.address, loopbackOk)))
    throw refuse(host);
  const pinned = addresses[0]!;
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const res = await new Promise<IncomingMessage>((resolveRes, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: opts.method ?? 'GET',
        headers: {
          'user-agent': 'salaam-web/1 (+https://salaam.sh)',
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        // The connection goes to the address checked above, never a fresh DNS answer.
        lookup: (_h, options, cb) =>
          (options as { all?: boolean }).all
            ? (cb as (e: null, a: Resolved[]) => void)(null, [pinned])
            : (cb as (e: null, a: string, f: number) => void)(null, pinned.address, pinned.family),
        timeout: timeoutMs,
      },
      resolveRes,
    );
    const timer = setTimeout(() => req.destroy(new Error('Request timed out')), timeoutMs);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.on('response', () => clearTimeout(timer));
    if (opts.body) req.write(opts.body);
    req.end();
  });
  const status = res.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
    res.resume();
    if (hop >= (opts.maxRedirects ?? 5)) throw new Error('Too many redirects');
    const next = new URL(res.headers.location, url).toString();
    const keep = status === 307 || status === 308;
    return guardedRequest(
      next,
      { ...opts, ...(keep ? {} : { method: 'GET', body: undefined }) },
      hop + 1,
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => res.destroy(new Error('Request timed out')), timeoutMs);
    res.on('data', (c: Buffer) => {
      if (truncated) return;
      const room = maxBytes - size;
      if (c.length >= room) {
        chunks.push(c.subarray(0, room));
        size += room;
        truncated = true;
        clearTimeout(timer);
        res.destroy();
        done();
        return;
      }
      chunks.push(c);
      size += c.length;
    });
    res.on('end', () => {
      clearTimeout(timer);
      done();
    });
    res.on('error', (e) => {
      clearTimeout(timer);
      if (truncated) done();
      else fail(e);
    });
  });
  return {
    status,
    url: url.toString(),
    body: Buffer.concat(chunks).toString('utf8'),
    truncated,
    contentType: String(res.headers['content-type'] ?? ''),
  };
}
