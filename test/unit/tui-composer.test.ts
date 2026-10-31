import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  ComposerHistory,
  CTRL_C_WINDOW_MS,
  HISTORY_LIMIT,
  ctrlCAction,
  historyPath,
  looksSecret,
  searchHistory,
  searchPrompt,
  shellPassthrough,
} from '../../src/tui-composer.js';

test('ctrl+c interrupts a turn, clears text, then needs a second press to leave', () => {
  expect(ctrlCAction({ running: true, text: 'x', armedAt: 1, now: 2 })).toBe('interrupt');
  expect(ctrlCAction({ running: false, text: 'draft', armedAt: undefined, now: 0 })).toBe('clear');
  expect(ctrlCAction({ running: false, text: '', armedAt: undefined, now: 0 })).toBe('arm');
  expect(ctrlCAction({ running: false, text: '', armedAt: 1000, now: 1500 })).toBe('exit');
  expect(
    ctrlCAction({ running: false, text: '', armedAt: 1000, now: 1001 + CTRL_C_WINDOW_MS }),
  ).toBe('arm');
});

test('secret-looking input is recognised', () => {
  for (const s of [
    'use sk-ant-api03-abcdefghijklmnop',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123',
    'AWS AKIAABCDEFGHIJKLMNOP',
    'password=hunter2hunter2',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'xoxb-1234567890-abcdef',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    'k=' + 'A1b2'.repeat(14),
  ])
    expect(looksSecret(s), s).toBe(true);
  for (const s of [
    'fix the failing test in src/components/very/long/path/to/some/component/file.ts',
    'revert 3f2a9c1d4e5b6a7980c1d2e3f4a5b6c7d8e9f001',
    'what does the token budget do?',
    'npm test -- --profile quick',
  ])
    expect(looksSecret(s), s).toBe(false);
});

test('history persists per user, bounded, newest last, private, without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salaam-hist-'));
  const path = join(dir, 'salaam', 'history.json');
  const h = new ComposerHistory(path);
  expect(h.add('first')).toBe(true);
  expect(h.add('my key is sk-ant-api03-abcdefghijklmnop')).toBe(false);
  expect(h.add('   ')).toBe(false);
  expect(h.add('second')).toBe(true);
  expect(h.add('first')).toBe(true);
  expect(new ComposerHistory(path).entries).toEqual(['second', 'first']);
  expect(readFileSync(path, 'utf8')).not.toContain('sk-ant');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.add('m' + i);
  expect(h.entries.length).toBe(HISTORY_LIMIT);
  expect(JSON.parse(readFileSync(path, 'utf8')).length).toBe(HISTORY_LIMIT);
  expect(new ComposerHistory(path).entries.length).toBe(HISTORY_LIMIT);
  // A file someone else wrote with a secret in it is filtered on load.
  writeFileSync(path, JSON.stringify(['ok', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 7]));
  expect(new ComposerHistory(path).entries).toEqual(['ok']);
  writeFileSync(path, 'not json');
  expect(new ComposerHistory(path).entries).toEqual([]);
});

test('history lives under XDG_STATE_HOME', () => {
  expect(historyPath({ XDG_STATE_HOME: '/s' })).toBe('/s/salaam/history.json');
  expect(historyPath({ HOME: '/h' })).toBe('/h/.local/state/salaam/history.json');
  expect(historyPath({ HOME: '/h', SALAAM_HISTORY: 'off' })).toBeUndefined();
});

test('reverse search finds newer matches first, then older ones', () => {
  const e = ['run npm test', 'fix lint', 'run go test', 'docs'];
  expect(searchHistory(e, 'test', e.length)).toBe(2);
  expect(searchHistory(e, 'test', 2)).toBe(0);
  expect(searchHistory(e, 'TEST', e.length)).toBe(2);
  expect(searchHistory(e, 'nope', e.length)).toBe(-1);
  expect(searchPrompt('te', 'run go test')).toContain("(reverse-i-search)`te': run go test");
  expect(searchPrompt('zz', undefined)).toContain('failing reverse-i-search');
});

test('!command becomes an instruction to run exactly that command through salaam_local', () => {
  const out = shellPassthrough('!git status --short')!;
  expect(out).toContain('salaam_local');
  expect(out).toContain('```sh\ngit status --short\n```');
  expect(shellPassthrough('  ! ls')).toContain('\nls\n');
  for (const t of ['git status', '!', '!!', '!!ls', '!a\nb', '/model'])
    expect(shellPassthrough(t)).toBeUndefined();
});
