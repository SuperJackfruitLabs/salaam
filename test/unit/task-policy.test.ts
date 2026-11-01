import { expect, test } from 'vitest';
import { taskPolicy } from '../../src/tasks/policy.js';

test('token budgeting defaults remain capped and null explicitly disables aggregate and default output bounds', () => {
  expect(taskPolicy({}).limits).toMatchObject({ token_units: 16777216, output_token_bound: 8192 });
  const policy = taskPolicy({ limits: { token_units: null, requests: 3 } });
  expect(policy.limits).toMatchObject({
    token_units: null,
    output_token_bound: null,
    requests: 3,
    input_token_bound: 131072,
  });
  expect(taskPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  expect(
    taskPolicy({ limits: { token_units: null, output_token_bound: 512 } }).limits
      .output_token_bound,
  ).toBe(512);
});

test.each([
  { output_token_bound: null },
  { token_units: 1, output_token_bound: null },
  { token_units: false },
  { token_units: 0 },
  { token_units: -1 },
  { token_units: 'none' },
  { token_units: null, requests: null },
  { token_units: null, runtime_ms: null },
  { token_units: null, concurrency: null },
  { token_units: null, verification_runs: null },
  { token_units: null, input_token_bound: null },
])('invalid or ambiguous token opt-outs cannot disable other required limits: %j', (limits) => {
  expect(() => taskPolicy({ limits })).toThrow();
});

// Item 8: completion hooks are checks required at completion, keyed hook-<key>. A plan without a
// gate keeps its exact shape (and so its digest).
import { requiredChecks } from '../../src/tasks/policy.js';
const hook = (key: string) => ({ key, command: 'true', cwd: '.' });
test('a completion gate parses, round-trips, and adds its hooks to the required checks', () => {
  const policy = taskPolicy({
    acceptance: [hook('tests')],
    completion_gate: { critic: null, hooks: [hook('lint')] },
  });
  expect(policy.completion_gate).toEqual({ critic: null, hooks: [hook('lint')] });
  expect(taskPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
  expect(requiredChecks(policy).map((c) => c.key)).toEqual(['tests', 'hook-lint']);
  expect(policy.acceptance.map((c) => c.key)).toEqual(['tests']);
  const plain = taskPolicy({ acceptance: [hook('tests')] });
  expect('completion_gate' in plain).toBe(false);
  expect(requiredChecks(plain)).toEqual(plain.acceptance);
});

test.each([
  ['no hooks', { critic: null, hooks: [] }],
  ['too many', { critic: null, hooks: Array.from({ length: 9 }, (_, n) => hook('h' + n)) }],
  ['duplicate', { critic: null, hooks: [hook('a'), hook('a')] }],
  [
    'a critic naming anything but a rubric',
    { critic: { rubric: 'x', profile: 'salaam/builder' }, hooks: [] },
  ],
  ['an empty rubric', { critic: { rubric: '' }, hooks: [] }],
  ['a rubric too long', { critic: { rubric: 'x'.repeat(4097) }, hooks: [] }],
  ['extra field', { critic: null, hooks: [hook('a')], extra: 1 }],
  ['critic missing', { hooks: [hook('a')] }],
  ['bad hook key', { critic: null, hooks: [hook('a b')] }],
  ['collides with an acceptance check', { critic: null, hooks: [hook('x')] }],
])('a completion gate is refused: %s', (_why, gate) => {
  expect(() => taskPolicy({ acceptance: [hook('hook-x')], completion_gate: gate })).toThrow();
});

test('a completion gate may declare a critic rubric, with or without hooks', () => {
  const alone = taskPolicy({
    acceptance: [hook('tests')],
    completion_gate: { critic: { rubric: 'Cite RFC 9110.' }, hooks: [] },
  });
  expect(alone.completion_gate).toEqual({ critic: { rubric: 'Cite RFC 9110.' }, hooks: [] });
  expect(taskPolicy(JSON.parse(JSON.stringify(alone)))).toEqual(alone);
  expect(requiredChecks(alone).map((c) => c.key)).toEqual(['tests']);
  const both = taskPolicy({
    acceptance: [hook('tests')],
    completion_gate: { critic: { rubric: 'r' }, hooks: [hook('lint')] },
  });
  expect(requiredChecks(both).map((c) => c.key)).toEqual(['tests', 'hook-lint']);
});
