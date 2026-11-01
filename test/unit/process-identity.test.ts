import { expect, test } from 'vitest';
import { processIdentity } from '../../src/process-identity.js';
test('process identity is stable for the current process and absent for nonexistent PIDs', () => {
  const identity = processIdentity(process.pid);
  expect(identity).toBeTruthy();
  expect(processIdentity(process.pid)).toBe(identity);
  expect(processIdentity(-1)).toBeNull();
  expect(processIdentity(2147483647)).toBeNull();
  if (process.platform === 'linux') expect(identity).toMatch(/^linux-proc-v1:[a-f0-9]{64}$/);
});
