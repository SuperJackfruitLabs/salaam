import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { workerTools } from '../../src/core/protocol.js';

// 2026-10-28: salaam_board was registered for station workers but missing from the worker's
// `--tools` allowlist, so the model never saw it (cards F and G). Every tool the house extension
// registers for a root station worker must be in that allowlist.
test('every station tool the extension registers reaches the worker allowlist', () => {
  const src = readFileSync(new URL('../../src/runtime/house/station.ts', import.meta.url), 'utf8');
  const registered = [
    ...src.matchAll(/if \(c\.station && !c\.child\)\s*pi\.registerTool\(\{\s*name: '([a-z_]+)'/g),
  ].map((m) => m[1]);
  expect(registered.sort()).toEqual(['salaam_board', 'salaam_station']);
  const allowed = workerTools(false, false, undefined, undefined, false, false, true);
  for (const name of registered) expect(allowed, name).toContain(name);
  // A station-less or child worker gets neither.
  expect(workerTools(false, false, undefined, undefined, false, false, false)).not.toContain(
    'salaam_board',
  );
  expect(workerTools(false, true, undefined, undefined, false, false, true)).not.toContain(
    'salaam_board',
  );
});
