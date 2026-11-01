import { test, expect } from 'vitest';
import {
  BREAKER_FAILURES,
  BREAKER_PAUSE_MS,
  HostBreaker,
  callThroughBreaker,
  fetchHost,
} from '../../src/host/breaker.js';

test('the host comes from the call url; anything else has none', () => {
  expect(fetchHost({ url: 'https://Example.com/a?b' })).toBe('example.com');
  for (const args of [{}, { url: 3 }, { url: 'not a url' }, null, 'x'])
    expect(fetchHost(args)).toBeNull();
});

test('repeated failures to one host pause it briefly; a success closes it again', () => {
  let now = 1000;
  const b = new HostBreaker(() => now);
  for (let i = 1; i < BREAKER_FAILURES; i++) expect(b.record('s', 'h', false)).toBe(false);
  expect(b.paused('s', 'h')).toBe(0);
  expect(b.record('s', 'h', false)).toBe(true);
  expect(b.paused('s', 'h')).toBe(BREAKER_PAUSE_MS);
  // Other hosts and other sessions are not paused.
  expect(b.paused('s', 'other')).toBe(0);
  expect(b.paused('t', 'h')).toBe(0);
  now += BREAKER_PAUSE_MS;
  expect(b.paused('s', 'h')).toBe(0);
  // A success in between resets the count.
  b.record('s', 'h', false);
  b.record('s', 'h', true);
  for (let i = 1; i < BREAKER_FAILURES; i++) expect(b.record('s', 'h', false)).toBe(false);
  b.forget('s');
  expect(b.record('s', 'h', false)).toBe(false);
});

test('calls through the breaker: a paused host is not called, and opening it records one event', async () => {
  let now = 0;
  const b = new HostBreaker(() => now);
  const events: Record<string, unknown>[] = [];
  let calls = 0;
  const failing = async () => {
    calls++;
    return { content: [{ type: 'text' as const, text: '503' }], is_error: true };
  };
  const args = { url: 'https://flaky.example/x' };
  for (let i = 0; i < BREAKER_FAILURES; i++)
    await callThroughBreaker(b, 's', args, (e) => events.push(e), failing);
  expect(calls).toBe(BREAKER_FAILURES);
  expect(events).toEqual([
    { host: 'flaky.example', failures: BREAKER_FAILURES, pause_ms: BREAKER_PAUSE_MS },
  ]);
  const paused = await callThroughBreaker(b, 's', args, (e) => events.push(e), failing);
  expect(calls).toBe(BREAKER_FAILURES);
  expect(paused.is_error).toBe(true);
  expect(paused.content[0]!.text).toContain('flaky.example');
  // A thrown failure counts too, and is rethrown unchanged.
  now += BREAKER_PAUSE_MS;
  const boom = async () => {
    calls++;
    throw Error('boom');
  };
  for (let i = 0; i < BREAKER_FAILURES; i++)
    await expect(callThroughBreaker(b, 's', args, (e) => events.push(e), boom)).rejects.toThrow(
      'boom',
    );
  expect(events).toHaveLength(2);
  // A call with no url is never paused.
  const plain = await callThroughBreaker(
    b,
    's',
    {},
    () => {},
    async () => ({ content: [], is_error: false }),
  );
  expect(plain.is_error).toBe(false);
});
