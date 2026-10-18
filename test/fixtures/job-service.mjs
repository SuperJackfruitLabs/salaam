import { SalaamService } from '../../dist/src/service.js';
import { ROOT } from '../../dist/src/config.js';
import { TaskFixtureBackend } from './task-backend.mjs';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const [dir, mode] = process.argv.slice(2),
  codingRoot = join(dir, 'owned');
mkdirSync(codingRoot, { recursive: true, mode: 0o700 });
const service = await SalaamService.open({
  stateDir: join(dir, 'state'),
  codingRoot,
  codingBackend: new TaskFixtureBackend(join(dir, 'executor-events.jsonl')),
  ...(['active', 'cancel-committed'].includes(mode)
    ? { extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') }
    : {}),
});
const hold = (name) => {
  writeFileSync(join(dir, name), 'durable boundary reached');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (mode === 'before-commit') {
  await service.taskDriver.close();
  const configure = service.taskDriver.configureInTransaction.bind(service.taskDriver);
  service.taskDriver.configureInTransaction = (...args) => {
    const result = configure(...args);
    hold('before-job-commit');
    return result;
  };
}
if (mode === 'after-commit') {
  await service.taskDriver.close();
  const trigger = service.jobs.trigger.bind(service.jobs);
  service.jobs.trigger = (...args) => {
    const result = trigger(...args);
    hold('after-job-commit');
    return result;
  };
}
if (mode === 'cancel-committed') {
  const stop = service.taskDriver.stopCancelled.bind(service.taskDriver);
  service.taskDriver.stopCancelled = async (...args) => {
    hold('after-cancel-commit');
    return stop(...args);
  };
}
if (mode.startsWith('recurring-')) {
  await service.taskDriver.close();
  if (mode === 'recurring-reserved') {
    const trigger = service.recurring.trigger.bind(service.recurring);
    service.recurring.trigger = (...args) => {
      const result = trigger(...args);
      hold(mode);
      return result;
    };
  }
  if (mode === 'recurring-cloned') {
    const clone = service.workspaces.cloneSnapshot.bind(service.workspaces);
    service.workspaces.cloneSnapshot = (...args) => {
      const result = clone(...args);
      hold(mode);
      return result;
    };
  }
  if (mode === 'recurring-admitted') {
    const provision = service.recurring.provision.bind(service.recurring);
    service.recurring.provision = (...args) => {
      const result = provision(...args);
      hold(mode);
      return result;
    };
  }
}
console.log('started');
process.once('SIGTERM', () => void service.close());
await service.closed;
