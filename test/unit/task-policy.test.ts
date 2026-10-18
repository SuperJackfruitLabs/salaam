import { expect, test } from 'vitest';
import { taskPolicy } from '../../src/task-policy.js';

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
