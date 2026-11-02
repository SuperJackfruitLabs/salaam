import { SalaamService } from '../../dist/src/service/service.js';
import { ROOT } from '../../dist/src/core/config.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const dir = process.argv[2];
const service = await SalaamService.open({
  stateDir: dir,
  extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs'),
});
const request = service.store.request.bind(service.store);
service.store.request = (...args) => {
  const result = request(...args);
  if (args[2]?.kind === 'revoke-session') {
    writeFileSync(join(dir, 'revocation-committed'), JSON.stringify(result));
    // Hold the exact commit/abort gap; the test kills the daemon here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
