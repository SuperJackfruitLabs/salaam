import { test, expect } from 'vitest';
import {
  HerdrReporter,
  statusEnabled,
  terminalState,
  titleFor,
} from '../../src/terminal-status.js';

// Trial polish C (2026-10-31): Salaam tells the terminal whether it is working, needs you, or is
// idle: in the window title, and to Herdr through its documented `pane report-agent` command
// (docs/next/website/src/content/docs/add-herdr-support.mdx in herdrdev/herdr; Herdr defines no
// OSC 7501 sequence there, so none is sent).
const snap = (attempts: string[], approvals: string[] = []) => ({
  attempts: attempts.map((state, i) => ({ id: 'a' + i, state })),
  approvals: approvals.map((state, i) => ({ id: 'p' + i, state })),
});

test('a pending approval is blocked, a live turn is working, anything else is idle', () => {
  expect(terminalState(undefined)).toBe('idle');
  expect(terminalState(snap(['completed']))).toBe('idle');
  expect(terminalState(snap(['running']))).toBe('working');
  expect(terminalState(snap(['dispatching']))).toBe('working');
  expect(terminalState(snap(['accepted']))).toBe('working');
  expect(terminalState(snap(['running'], ['pending']))).toBe('blocked');
  expect(terminalState(snap([], ['approved']))).toBe('idle');
  // The first snapshot can arrive before its lists (tui.test.ts).
  expect(terminalState({})).toBe('idle');
  expect(terminalState({ attempts: [{ state: 'running' }] })).toBe('working');
});

test('the title is short, says the state in words, and cannot carry control characters', () => {
  expect(titleFor('working', 'app')).toBe('Salaam · app · working');
  expect(titleFor('blocked', 'app')).toBe('Salaam · app · needs you');
  expect(titleFor('idle', undefined)).toBe('Salaam');
  const evil = titleFor('idle', 'x\x1b]0;pwned\x07' + 'y'.repeat(80));
  expect(evil).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(evil.length).toBeLessThanOrEqual(60);
});

test('SALAAM_TERMINAL_STATUS=off turns both off; on by default', () => {
  expect(statusEnabled({})).toBe(true);
  expect(statusEnabled({ SALAAM_TERMINAL_STATUS: 'off' })).toBe(false);
});

const herdrEnv = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2', HERDR_BIN_PATH: '/opt/herdr' };
function reporter(env: Record<string, string> = herdrEnv) {
  const calls: { bin: string; args: string[] }[] = [];
  const finish: (() => void)[] = [];
  let clock = 1000;
  const r = new HerdrReporter(
    env,
    (bin, args, done) => {
      calls.push({ bin, args });
      finish.push(done);
    },
    () => clock,
  );
  return { r, calls, finish, tick: (n: number) => (clock += n) };
}

test('outside Herdr nothing is reported', () => {
  const { r, calls } = reporter({ HERDR_ENV: '1' });
  r.report('working', 's1');
  r.release();
  expect(calls).toEqual([]);
  expect(reporter({}).r.enabled).toBe(false);
});

test('a state report names the pane, our source, the state, a rising seq and the resume command', () => {
  const { r, calls, finish } = reporter();
  r.report('working', '0b6c2f4e-0000-4000-8000-000000000001');
  expect(calls[0]).toEqual({
    bin: '/opt/herdr',
    args: [
      'pane',
      'report-agent',
      'w1:p2',
      '--source',
      'salaam',
      '--agent',
      'salaam',
      '--state',
      'working',
      '--seq',
      '1000',
      '--agent-session-id',
      '0b6c2f4e-0000-4000-8000-000000000001',
      '--',
      'salaam',
      '--session',
      '0b6c2f4e-0000-4000-8000-000000000001',
    ],
  });
  finish[0]!();
  r.report('blocked', '0b6c2f4e-0000-4000-8000-000000000001');
  expect(calls[1]!.args).toContain('--message');
  expect(calls[1]!.args[calls[1]!.args.indexOf('--message') + 1]).toBe('Waiting for your approval');
  // Same clock, still a higher seq: Herdr drops reports whose seq is not higher.
  expect(Number(calls[1]!.args[calls[1]!.args.indexOf('--seq') + 1])).toBe(1001);
});

test('one report in flight at a time; only the newest queued state is sent next', () => {
  const { r, calls, finish } = reporter();
  r.report('working', 's');
  r.report('blocked', 's');
  r.report('idle', 's');
  expect(calls).toHaveLength(1);
  finish[0]!();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.args[calls[1]!.args.indexOf('--state') + 1]).toBe('idle');
  finish[1]!();
  r.report('idle', 's');
  expect(calls).toHaveLength(2);
});

test('release clears the pane on exit, with a higher seq than any report', () => {
  const { r, calls, finish } = reporter();
  r.report('idle', 's');
  finish[0]!();
  r.release();
  expect(calls[1]!.args.slice(0, 7)).toEqual([
    'pane',
    'release-agent',
    'w1:p2',
    '--source',
    'salaam',
    '--agent',
    'salaam',
  ]);
  expect(Number(calls[1]!.args.at(-1))).toBeGreaterThan(1000);
});

test('no session id means no resume command', () => {
  const { r, calls } = reporter();
  r.report('idle', undefined);
  expect(calls[0]!.args).not.toContain('--');
});
