import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { workerTools } from '../../src/core/protocol.js';

// Web search and fetch are offered to interactive local coding sessions only: never to child
// workers, and not to station (board) work, which reaches the web through the broker.
const src = (f: string) => readFileSync(new URL(`../../src/${f}`, import.meta.url), 'utf8');

test('an interactive coding worker gets web search and fetch in its tool allowlist', () => {
  const coding = workerTools(false, false, undefined, undefined, false, false, false, true, true);
  expect(coding).toContain('salaam_web_search');
  // Background commands are read and stopped with salaam_tasks (found missing in a live pass).
  expect(coding).toContain('salaam_tasks');
  expect(coding).toContain('salaam_web_fetch');
  const station = workerTools(false, false, undefined, undefined, false, false, true);
  expect(station).not.toContain('salaam_web_search');
  const child = workerTools(false, true, undefined, ['salaam_probe']);
  expect(child).not.toContain('salaam_web_fetch');
  const plainLocal = workerTools(
    false,
    false,
    undefined,
    undefined,
    false,
    false,
    false,
    true,
    false,
  );
  expect(plainLocal).not.toContain('salaam_web_search');
});

test('the extension registers both tools for interactive coding roots only', () => {
  const ext = src('runtime/house-extension.ts');
  const registered = [
    ...ext.matchAll(
      /if \(c\.localCoding && !c\.child\)\s*pi\.registerTool\(\{\s*name: '([a-z_]+)'/g,
    ),
  ].map((m) => m[1]);
  expect(registered).toEqual(expect.arrayContaining(['salaam_web_search', 'salaam_web_fetch']));
  // Their bridge calls get a timeout long enough for a real HTTP round trip.
  // (Phase 4b: the same long timeout as local calls, since PreToolUse hooks run first.)
  expect(ext).toMatch(/method\.startsWith\('web\.'\)\s*\?\s*HOOKED_BRIDGE_TIMEOUT/);
  expect(ext).toMatch(/const HOOKED_BRIDGE_TIMEOUT = \d+ \* 60 \* 1000;/);
});

test('the supervisor serves web calls only to admitted interactive coding sessions', () => {
  const sup = src('runtime/supervisor.ts');
  const block =
    /if \(method === 'web\.search' \|\| method === 'web\.fetch'\) \{([\s\S]*?)\n {6}\}/.exec(sup);
  expect(block, 'web dispatch block').toBeTruthy();
  expect(block![1]).toMatch(/!this\.web/);
  expect(block![1]).toMatch(/!this\.store\.localCoding\(id\)/);
  expect(block![1]).toMatch(/this\.children\?\.owned\(id\)/);
  expect(block![1]).toMatch(/this\.assertActive\(id, w\.epoch, w\.attempt\)/);
  // What is recorded: kind, backends and timings — never the provider keys.
  expect(block![1]).toMatch(/'web\.search'/);
});
