import { SalaamService } from '../../dist/src/service.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const [stateDir, codingRoot, codingSocket, mode] = process.argv.slice(2);
const service = await SalaamService.open({ stateDir, codingRoot, codingSocket });
if (mode === 'between-steps') {
  const advance = service.taskWork.advance.bind(service.taskWork);
  service.taskWork.advance = (id) => {
    const step = service.store.db
      .prepare(
        'SELECT s.ordinal FROM task_grants g JOIN task_steps s ON s.id=g.step_id WHERE g.id=?',
      )
      .get(id);
    if (step?.ordinal === 1) {
      writeFileSync(
        join(stateDir, 'between-steps'),
        'first step verified; next grant not admitted',
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return advance(id);
  };
}
console.log('started');
process.once('SIGTERM', () => void service.close());
await service.closed;
