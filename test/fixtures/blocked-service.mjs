import { SalaamService } from '../../dist/src/service.js';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const service = await SalaamService.open({
  stateDir: process.argv[2],
  extensionPath: fileURLToPath(new URL('./blocked-extension.mjs', import.meta.url)),
});
if (process.argv[3] === 'completion-gap') {
  const finish = service.store.finish.bind(service.store);
  service.store.finish = (...args) => {
    if (args[1] === 'completed') {
      writeFileSync(
        join(process.argv[2], 'completion-pending'),
        'Pi settled; SQLite completion not committed',
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return finish(...args);
  };
}
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
