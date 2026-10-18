import { SalaamService } from '../../dist/src/service.js';
import { ROOT } from '../../dist/src/config.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const [dir, fault] = process.argv.slice(2);
const service = await SalaamService.open({
  stateDir: dir,
  extensionPath: join(ROOT, 'test/fixtures/child-extension.mjs'),
});
const block = () => {
  writeFileSync(join(dir, 'boundary-pending'), fault);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const boundary = service.store.workerBoundary;
const freeze = boundary.freeze.bind(boundary);
boundary.freeze = (...args) => {
  if (fault === 'before-intent') block();
  return freeze(...args);
};
const start = service.supervisor.start.bind(service.supervisor);
service.supervisor.start = async (id) => {
  if (fault === 'after-intent' && service.children.owned(id)) block();
  return start(id);
};
const claim = boundary.claim.bind(boundary);
boundary.claim = (...args) => {
  claim(...args);
  if (fault === 'after-dispatch') block();
};
const accepted = boundary.accepted.bind(boundary);
boundary.accepted = (...args) => {
  accepted(...args);
  if (fault === 'after-acceptance') block();
};
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
