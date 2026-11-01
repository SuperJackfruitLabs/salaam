import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOCAL_TOOL_ERRORS } from '../../src/runtime/supervisor.js';

// Live pass 2026-10-31: a replacement whose old text was not found (edit_mismatch) was missing
// from this list, so one mistyped edit turned a desk session unhealthy instead of telling the
// model to read the file again.
test('every error a local edit can raise is feedback to the model, not a failed worker', () => {
  const source = readFileSync(new URL('../../src/local/edits.ts', import.meta.url), 'utf8');
  const codes = [...source.matchAll(/new ServiceError\(\s*'([a-z_]+)'/g)].map((m) => m[1]!);
  expect(codes).toContain('edit_mismatch');
  for (const code of new Set(codes)) expect(LOCAL_TOOL_ERRORS).toContain(code);
});

// Trial polish #12: a refused `!command` substitute is feedback, so the model can retry the exact
// command instead of the session turning unhealthy.
test('a refused !command substitute is feedback to the model', () => {
  expect(LOCAL_TOOL_ERRORS).toContain('shell_binding');
});
