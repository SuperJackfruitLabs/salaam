import { test, expect } from 'vitest';
import { sessionFailure } from '../../src/tui/client.js';

// PR #103 live pass: a desk session whose worker failed showed "Instruction accepted." and "no
// coding workspace", never the error. The TUI now shows what actually happened.
test('a failed worker is described with its recorded error', () => {
  expect(sessionFailure({ state: 'unhealthy', error: 'pi exited: ENOENT pi' })).toBe(
    'Session stopped: pi exited: ENOENT pi. Fix it, then /new or ctrl+n for a fresh session.',
  );
  expect(sessionFailure({ state: 'exited', error: 'worker crashed' })).toMatch(/worker crashed/);
  expect(sessionFailure({ state: 'unhealthy', error: null })).toMatch(
    /Session stopped: the worker/,
  );
});

test('a healthy or starting session reports nothing', () => {
  for (const state of ['ready', 'starting', 'stopped'] as const)
    expect(sessionFailure({ state, error: 'old' })).toBeUndefined();
  expect(sessionFailure({ state: 'exited', error: null })).toBeUndefined();
  expect(sessionFailure(undefined)).toBeUndefined();
});
