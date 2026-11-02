import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { acquireStateLock } from '../../src/core/state-lock.js';
import { ROOT } from '../../src/core/config.js';

test('a second service cannot lock state; process death releases the OS lock', async () => {
  const dir = mkdtempSync('/tmp/sal-lock-');
  const module = pathToFileURL(join(ROOT, 'dist/src/core/state-lock.js')).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {acquireStateLock} from ${JSON.stringify(module)}; globalThis.salaamUnlock=acquireStateLock(${JSON.stringify(dir)}); console.log('locked'); setInterval(()=>{},1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await once(child.stdout, 'data');
    expect(() => acquireStateLock(dir)).toThrow('Another Salaam service');
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    const release = acquireStateLock(dir);
    release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
