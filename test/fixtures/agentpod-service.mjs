import { SalaamService } from '../../dist/src/service.js';
import { ROOT } from '../../dist/src/config.js';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
const service = await SalaamService.open({
  stateDir: process.argv[2],
  agentpodConfig: process.argv[3],
  extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs'),
});
const request = service.store.request.bind(service.store);
service.store.request = (...args) => {
  const result = request(...args);
  if (args[2]?.kind === 'revoke' && existsSync(join(process.argv[2], 'hold-revocation'))) {
    writeFileSync(
      join(process.argv[2], 'revocation-committed'),
      'committed before reply and process abort',
    );
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return result;
};
process.stdout.write('ready\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
