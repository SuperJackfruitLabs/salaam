import { SalaamService } from '../../dist/src/service/service.js';
import { ROOT } from '../../dist/src/core/config.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const service = await SalaamService.open({
  stateDir: process.argv[2],
  extensionPath: join(ROOT, 'test/fixtures/child-extension.mjs'),
});
if (process.argv.includes('--before-usage')) {
  const observe = service.store.usage.observe.bind(service.store.usage);
  service.store.usage.observe = (session, ...args) => {
    if (service.children.owned(session)) {
      writeFileSync(join(process.argv[2], 'usage-pending'), session);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return observe(session, ...args);
  };
}
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
