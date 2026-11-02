import { expect, test } from 'vitest';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import {
  continueArgs,
  deskUsesAnthropic,
  latestSessionFor,
  parseCodeStart,
  pickerOrder,
  relativeTime,
  sessionDescription,
} from '../../src/tui/session-pick.js';

// `salaam code` in a folder continues that folder's latest session, or starts one (step 0,
// 2026-10-31: starting took three commands and resuming needed the full session id).
test('the latest session for a folder is the last one created there, whatever its trailing slash', () => {
  const sessions = [
    { id: 'a', cwd: '/work/app' },
    { id: 'b', cwd: '/work/other' },
    { id: 'c', cwd: '/work/app/' },
    { id: 'd', cwd: '/work/app-two' },
  ];
  expect(latestSessionFor(sessions, '/work/app')).toBe('c');
  expect(latestSessionFor(sessions, '/work/app/')).toBe('c');
  expect(latestSessionFor(sessions, '/work/none')).toBeUndefined();
});

test('salaam code takes one of --continue (the default), --new or --resume', () => {
  expect(parseCodeStart([])).toBe('continue');
  expect(parseCodeStart(['--continue'])).toBe('continue');
  expect(parseCodeStart(['--new'])).toBe('new');
  expect(parseCodeStart(['--resume'])).toBe('resume');
  expect(() => parseCodeStart(['--new', '--resume'])).toThrow('one of');
});

test('a state path too long for a Unix socket names its length and the fix', async () => {
  const { SalaamService } = await import('../../src/service/service.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const base = mkdtempSync('/tmp/sal-long-');
  const long = base + '/' + 'x'.repeat(110);
  try {
    const error = await SalaamService.open({ stateDir: long }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/bytes/);
    expect(error?.message).toContain('SALAAM_STATE_DIR');
    expect(error?.message).toContain('salaam code');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// Live pass, 2026-10-31: `salaam code --new` against a running TUI-started service opened an
// offline demo session although an Anthropic key was stored.
test('a new desk session uses Anthropic when the running service defaults to offline', () => {
  // `service start --provider offline` reports the scripted fixture's provider id.
  const offline = OFFLINE_ROUTE.provider;
  expect(offline).not.toBe('offline');
  expect(deskUsesAnthropic(false, offline, true)).toBe(true);
  expect(deskUsesAnthropic(false, undefined, true)).toBe(true);
  expect(deskUsesAnthropic(false, offline, false)).toBe(false);
  expect(deskUsesAnthropic(true, offline, true)).toBe(false);
  expect(deskUsesAnthropic(false, 'openai', true)).toBe(false);
});

// Trial polish C (2026-10-31): `salaam -c` continues here, and the picker puts this folder first
// with what you last asked and when, instead of a bare state and path.
test('salaam -c and salaam --continue open salaam code --continue', () => {
  expect(continueArgs(['-c'])).toEqual(['code', '--continue']);
  expect(continueArgs(['--continue', '--cwd', '/w'])).toEqual([
    'code',
    '--continue',
    '--cwd',
    '/w',
  ]);
  expect(continueArgs(['code', '-c'])).toBeUndefined();
  expect(continueArgs(['--session', 'x'])).toBeUndefined();
  expect(continueArgs([])).toBeUndefined();
});

test('the picker lists this folder first, each group newest first', () => {
  const now = 1_000_000;
  const sessions = [
    { id: 'old-here', cwd: '/w/app', last_active_at: new Date(now - 9000).toISOString() },
    { id: 'new-there', cwd: '/w/other', last_active_at: new Date(now - 10).toISOString() },
    { id: 'new-here', cwd: '/w/app/', last_active_at: new Date(now - 100).toISOString() },
    { id: 'unknown-there', cwd: '/w/x' },
  ];
  expect(pickerOrder(sessions, '/w/app').map((s) => s.id)).toEqual([
    'new-here',
    'old-here',
    'new-there',
    'unknown-there',
  ]);
});

test('relative times read like a person would say them', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now);
  expect(ago(5_000)).toBe('just now');
  expect(ago(3 * 60_000)).toBe('3 min ago');
  expect(ago(2 * 3_600_000)).toBe('2 h ago');
  expect(ago(30 * 3_600_000)).toBe('yesterday');
  expect(ago(4 * 86_400_000)).toBe('4 days ago');
  expect(relativeTime(undefined, now)).toBe('');
});

test('a picker row shows the last prompt on one short line, then when and where', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const row = sessionDescription(
    {
      cwd: '/w/app',
      state: 'ready',
      last_prompt: 'fix the help line\nand then run the tests '.padEnd(200, 'x'),
      last_active_at: new Date(now - 120_000).toISOString(),
    },
    now,
  );
  expect(row).toMatch(/^“fix the help line and then run the tests x+…” · 2 min ago · \/w\/app$/);
  expect(row.length).toBeLessThan(120);
  expect(sessionDescription({ cwd: '/w/app', state: 'stopped' }, now)).toBe('stopped · /w/app');
});
