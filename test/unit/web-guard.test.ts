import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { guardedRequest, isPublicAddress } from '../../src/web-guard.js';

// Web search and fetch run in the daemon, outside the command sandbox, so they must never reach
// this machine, the LAN or a cloud metadata service — whatever a URL or its DNS says.
test.each([
  ['127.0.0.1', false],
  ['10.1.2.3', false],
  ['172.16.0.9', false],
  ['192.168.1.1', false],
  ['169.254.169.254', false],
  ['100.64.0.1', false],
  ['0.0.0.0', false],
  ['224.0.0.1', false],
  ['::1', false],
  ['::', false],
  ['fe80::1', false],
  ['fd00:ec2::254', false],
  ['::ffff:127.0.0.1', false],
  ['::ffff:10.0.0.1', false],
  ['::ffff:8.8.8.8', true],
  ['64:ff9b::a00:1', false],
  ['8.8.8.8', true],
  ['1.1.1.1', true],
  ['2606:4700:4700::1111', true],
])('isPublicAddress(%s) is %s', (address, expected) => {
  expect(isPublicAddress(address)).toBe(expected);
});

const lookupTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('a literal private address in the URL is refused before any connection', async () => {
  for (const url of [
    'http://127.0.0.1:9/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://10.0.0.5/x',
  ])
    await expect(guardedRequest(url, {})).rejects.toThrow(/not a public address/);
});

test('a hostname resolving to a private address is refused (DNS rebinding included)', async () => {
  await expect(
    guardedRequest('http://internal.example/', { lookup: lookupTo('10.0.0.7') }),
  ).rejects.toThrow(/not a public address/);
  // One private address among public ones is enough to refuse: the connection could land on it.
  await expect(
    guardedRequest('http://mixed.example/', { lookup: lookupTo('93.184.216.34', '127.0.0.1') }),
  ).rejects.toThrow(/not a public address/);
});

test('only http and https, and no credentials in the URL', async () => {
  await expect(guardedRequest('file:///etc/passwd', {})).rejects.toThrow(/http or https/);
  await expect(guardedRequest('ftp://example.com/', {})).rejects.toThrow(/http or https/);
  await expect(guardedRequest('https://user:pw@example.com/', {})).rejects.toThrow(/credentials/);
});

// A loopback test server, reachable only because the test allows loopback explicitly.
async function server(
  handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; close: () => Promise<void> }> {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => s.close(() => r())),
  };
}

test('a body over the size cap is cut and marked truncated', async () => {
  const s = await server((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('x'.repeat(50_000));
  });
  try {
    const r = await guardedRequest(s.url + '/big', { maxBytes: 1000, allowLoopbackForTests: true });
    expect(r.body.length).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.status).toBe(200);
  } finally {
    await s.close();
  }
});

test('a slow server times out', async () => {
  const s = await server(() => {
    /* never answers */
  });
  try {
    await expect(
      guardedRequest(s.url + '/slow', { timeoutMs: 200, allowLoopbackForTests: true }),
    ).rejects.toThrow(/timed out/);
  } finally {
    await s.close();
  }
});

test('every redirect hop is checked again: a redirect to loopback is refused', async () => {
  let port = 0;
  const s = await server((req, res) => {
    if (req.url === '/landed') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reached loopback');
      return;
    }
    res.writeHead(302, { location: `http://127.0.0.1:${port}/landed` });
    res.end();
  });
  port = Number(new URL(s.url).port);
  try {
    await expect(
      guardedRequest(s.url + '/r', {
        allowLoopbackForTests: true,
        allowLoopbackOnlyFirstHop: true,
      }),
    ).rejects.toThrow(/not a public address/);
  } finally {
    await s.close();
  }
});
