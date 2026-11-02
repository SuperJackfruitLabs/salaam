import { vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/** Every statement any database prepares or executes from now on, in order (restore with
 * vi.restoreAllMocks). */
export function traceSql(): () => string[] {
  const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
  return () =>
    [
      ...prepare.mock.calls.map((args, n) => ({
        at: prepare.mock.invocationCallOrder[n] ?? 0,
        sql: args[0],
      })),
      ...exec.mock.calls.map((args, n) => ({
        at: exec.mock.invocationCallOrder[n] ?? 0,
        sql: 'exec: ' + args[0],
      })),
    ]
      .toSorted((a, b) => a.at - b.at)
      .map((call) => call.sql);
}
