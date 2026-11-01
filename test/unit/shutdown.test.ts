import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/core/config.js';
import { acquireStateLock } from '../../src/core/state-lock.js';

test.each(['resource', 'journal'])(
  'failed %s shutdown retains ownership until process death and still attempts other cleanup',
  async (mode) => {
    const dir = mkdtempSync('/tmp/sal-stop-');
    const child = fork(join(ROOT, 'test/fixtures/shutdown-failure.mjs'), [dir, mode], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    try {
      const [result] = await once(child, 'message');
      let unexpectedlyReleased = false;
      try {
        const release = acquireStateLock(dir);
        unexpectedlyReleased = true;
        release();
      } catch (error) {
        expect((error as Error).message).toContain('Another Salaam service');
      }
      expect({ result, unexpectedlyReleased }).toEqual({
        result: {
          failures: [true, true],
          supervisorClosed: mode === 'resource',
          workerStopped: true,
        },
        unexpectedlyReleased: false,
      });
      child.kill('SIGKILL');
      await exited;
      const release = acquireStateLock(dir);
      release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
