import { expect, test } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';

test('mock external service retains an accepted effect across process death', async () => {
  const dir = mkdtempSync('/tmp/sal-effect-');
  let child: ChildProcessWithoutNullStreams | undefined;
  const start = async () => {
    child = spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-effect.mjs'), dir]);
    await once(child.stdout, 'data');
  };
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  };
  const socket = join(dir, 'effects.sock');
  try {
    await start();
    // The response is deliberately withheld after acceptance.
    const req = request({
      socketPath: socket,
      path: '/effects',
      method: 'POST',
      headers: { 'idempotency-key': 'action-1', 'x-hold-after-accept': 'true' },
    });
    req.on('error', () => {});
    req.end(JSON.stringify({ target: 'fixture-only' }));
    let receipt: unknown;
    for (let i = 0; i < 50; i++) {
      try {
        receipt = await call(socket, '/effects/action-1');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
    expect(receipt).toMatchObject({ id: 'action-1', accepted: true });
    await stop();
    req.destroy();
    await start();
    expect(await call(socket, '/effects/action-1')).toEqual(receipt);
    const retry = await new Promise((resolve, reject) => {
      const retry = request(
        {
          socketPath: socket,
          path: '/effects',
          method: 'POST',
          headers: { 'idempotency-key': 'action-1' },
        },
        (res) => {
          let text = '';
          res.on('data', (x) => {
            text += x;
          });
          res.on('end', () => resolve(JSON.parse(text)));
        },
      );
      retry.on('error', reject);
      retry.end(JSON.stringify({ target: 'fixture-only' }));
    });
    expect(retry).toEqual(receipt);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
