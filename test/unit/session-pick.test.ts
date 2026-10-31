import { expect, test } from 'vitest';
import { OFFLINE_ROUTE } from '../../src/provider-config.js';
import { deskUsesAnthropic, latestSessionFor, parseCodeStart } from '../../src/session-pick.js';

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
  const { SalaamService } = await import('../../src/service.js');
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
