import { expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ROOT } from '../../src/config.js';

const { downloadPinnedSource } = await import(
  pathToFileURL(join(ROOT, 'scripts/download-pinned-source.mjs')).href
);
const payload = Buffer.from('immutable fixture source');
const sha = createHash('sha256').update(payload).digest('hex');

test('immutable source GET retries a bounded 429/503 sequence and verifies the original digest', async () => {
  let requests = 0;
  const waits: number[] = [];
  const bytes = await downloadPinnedSource('https://source.example/pinned', {
    maxBytes: 1024,
    integrity: { kind: 'sha256', value: sha },
    fetcher: async () => {
      requests++;
      return requests === 1
        ? new Response(null, { status: 429, headers: { 'retry-after': '2' } })
        : requests === 2
          ? new Response(null, { status: 503 })
          : new Response(payload);
    },
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  });
  expect(bytes).toEqual(payload);
  expect(requests).toBe(3);
  expect(waits).toEqual([2000, 30000]);
});

test('rate limiting stops after four requests and never trusts an unbounded Retry-After', async () => {
  let requests = 0;
  const waits: number[] = [];
  await expect(
    downloadPinnedSource('https://source.example/pinned', {
      maxBytes: 1024,
      integrity: { kind: 'sha256', value: sha },
      fetcher: async () => {
        requests++;
        return new Response(null, { status: 429, headers: { 'retry-after': '99999999' } });
      },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    }),
  ).rejects.toThrow('HTTP 429');
  expect(requests).toBe(4);
  expect(waits).toEqual([60000, 60000, 60000]);
});

test('integrity errors and definite HTTP errors are never retried', async () => {
  for (const status of [200, 403, 404]) {
    let requests = 0;
    await expect(
      downloadPinnedSource('https://source.example/pinned', {
        maxBytes: 1024,
        integrity: { kind: 'sha256', value: sha },
        fetcher: async () => {
          requests++;
          return new Response('changed bytes', { status });
        },
        sleep: async () => {
          throw Error('Unexpected retry');
        },
      }),
    ).rejects.toThrow(status === 200 ? 'integrity' : 'HTTP');
    expect(requests).toBe(1);
  }
});

test('stream byte bounds and Git blob identity are checked before admitting downloaded source', async () => {
  const blob = createHash('sha1').update(`blob ${payload.length}\0`).update(payload).digest('hex');
  expect(
    await downloadPinnedSource('https://source.example/pinned', {
      maxBytes: 1024,
      integrity: { kind: 'git-blob-sha1', value: blob },
      fetcher: async () => new Response(payload),
    }),
  ).toEqual(payload);
  let cancelled = false;
  await expect(
    downloadPinnedSource('https://source.example/pinned', {
      maxBytes: 8,
      integrity: { kind: 'sha256', value: sha },
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(payload);
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    }),
  ).rejects.toThrow('bound');
  expect(cancelled).toBe(true);
});
