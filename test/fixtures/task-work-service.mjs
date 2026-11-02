import { SalaamService } from '../../dist/src/service/service.js';
import { ROOT } from '../../dist/src/core/config.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const dir = process.argv[2];
const service = await SalaamService.open({
  stateDir: dir,
  extensionPath: join(ROOT, 'test/fixtures/task-work-extension.mjs'),
});
if (process.argv[3] === 'queued') service.dispatcher.pause();
if (process.argv[3] === 'completion-gap') {
  const finish = service.store.finish.bind(service.store);
  service.store.finish = (...args) => {
    if (args[1] === 'completed') {
      writeFileSync(
        join(dir, 'completion-pending'),
        'Pi settled; task and attempt transaction not committed',
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return finish(...args);
  };
}
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
