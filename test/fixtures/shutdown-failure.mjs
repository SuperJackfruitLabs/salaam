import { SalaamService } from '../../dist/src/service/service.js';
import { PiProcess } from '../../dist/src/runtime/pi.js';
import { ROOT } from '../../dist/src/core/config.js';
import { join } from 'node:path';

let workerStopped = true;
const service = await SalaamService.open({
  stateDir: process.argv[2],
  launch: (launch) => {
    const pi = new PiProcess(
      process.execPath,
      [join(ROOT, 'test/fixtures/fake-pi.mjs'), ...launch.args.slice(1)],
      launch.cwd,
      launch.env,
    );
    workerStopped = false;
    pi.closed.then(() => {
      workerStopped = true;
    });
    return pi;
  },
});
if (process.argv[3] === 'journal') {
  const session = service.store.create(process.argv[2], 'shutdown-worker');
  await service.supervisor.start(session.id);
  service.store.db.exec('PRAGMA query_only=ON');
} else {
  service.coding.close = async () => {
    throw new Error('injected unconfirmed resource cleanup');
  };
}
let supervisorClosed = false;
const closeSupervisor = service.supervisor.close.bind(service.supervisor);
service.supervisor.close = async () => {
  await closeSupervisor();
  supervisorClosed = true;
};
const failures = [];
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    await service.close();
    failures.push(false);
  } catch {
    failures.push(true);
  }
}
process.send({ failures, supervisorClosed, workerStopped });
setInterval(() => {}, 1000);
