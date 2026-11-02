// Internal proof helper, deliberately killed by the operator-only boundary proof.
import { BoundaryBroker, engineRequest } from './boundary.js';
import { setTimeout as delay } from 'node:timers/promises';

async function main(): Promise<void> {
  const [socket, workspace, run] = process.argv.slice(2);
  if (!socket || !workspace || !run || !process.send) throw new Error('Internal proof helper');
  const broker = new BoundaryBroker(run, engineRequest(socket));
  await broker.prepare();
  const id = await broker.create(workspace, 'descendants');
  await broker.start(id);
  for (let n = 0; n < 40; n++) {
    if ((await broker.logs(id)).includes('descendant-started')) {
      process.send({ id });
      return; // IPC keeps this process alive until the proof kills it.
    }
    await delay(25);
  }
  throw new Error('Descendant did not start');
}
// No finally cleanup: this helper models a broker dying while its owned work is live.
main().catch(() => {
  process.exitCode = 1;
  process.disconnect?.();
});
