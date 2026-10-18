import { test, expect } from 'vitest';
import { harnessToolIds, matchesCodexCommandScope } from '../../src/harness-tool-identity.js';
test('only pinned Gemini namespaces correlate to the recorded model tool call', () => {
  expect(harnessToolIds('gemini-acp', '0.64.0', { id: 'toolu_fixture', name: 'replace' })).toEqual([
    'toolu_fixture',
    'replace__toolu_fixture',
  ]);
  expect(harnessToolIds('claude-acp', '0.23.1', { id: 'toolu_fixture', name: 'Edit' })).toEqual([
    'toolu_fixture',
  ]);
  expect(() =>
    harnessToolIds('gemini-acp', '0.65.0', { id: 'toolu_fixture', name: 'replace' }),
  ).toThrow('Unproved');
  expect(() =>
    harnessToolIds('gemini-acp', '0.64.0', { id: '../foreign', name: 'replace' }),
  ).toThrow('malformed');
});
test('Codex approval binds the actual shell argv, workdir and model-call ID rather than a display title or command summary', () => {
  const intent = {
    id: 'toolu_fixture',
    name: 'exec_command',
    arguments: { cmd: 'node --test app.test.js', workdir: '/workspace' },
  };
  const params = {
    itemId: intent.id,
    cwd: '/workspace',
    command: "/usr/bin/bash -lc 'node --test app.test.js'",
  };
  expect(matchesCodexCommandScope('0.163.0', intent, params)).toBe(true);
  for (const changed of [
    { ...params, itemId: 'foreign' },
    { ...params, cwd: '/another' },
    { ...params, command: params.command + '; touch /workspace/escape' },
    { ...params, command: '/usr/bin/bash -lc "$(touch /workspace/escape)"' },
    { ...params, command: "/usr/bin/bash -lc 'node --test app.test.js' extra" },
    { ...params, command: "/usr/bin/bash -lc 'node --test app.test.js" },
    { ...params, command: "/usr/bin/bash -lc 'node --test app.test.js; touch escape'" },
    { ...params, command: "/usr/bin/sh -c 'node --test app.test.js'" },
    { ...params, command: "/usr/bin/bash\n-lc 'node --test app.test.js'" },
  ])
    expect(matchesCodexCommandScope('0.163.0', intent, changed)).toBe(false);
  expect(matchesCodexCommandScope('0.164.0', intent, params)).toBe(false);
  expect(matchesCodexCommandScope('0.163.0', undefined, params)).toBe(false);
  const cmd =
    'node -e \'require("node:fs").writeFileSync("app.js","export const answer = 42;\\n")\'';
  expect(
    matchesCodexCommandScope(
      '0.163.0',
      { ...intent, arguments: { ...intent.arguments, cmd } },
      {
        ...params,
        command: '/usr/bin/bash -lc "' + cmd.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"',
      },
    ),
  ).toBe(true);
});
