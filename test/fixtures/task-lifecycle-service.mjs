import { SalaamService } from '../../dist/src/service.js';
import { ROOT } from '../../dist/src/config.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TaskFixtureBackend } from './task-backend.mjs';
const [dir, mode] = process.argv.slice(2),
  state = join(dir, 'state'),
  codingRoot = join(dir, 'owned');
mkdirSync(codingRoot, { recursive: true, mode: 0o700 });
const backend = new TaskFixtureBackend(join(dir, 'executor-events.jsonl'));
const service = await SalaamService.open({
  stateDir: state,
  codingRoot,
  codingBackend: backend,
  ...(mode === 'active-step'
    ? { extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') }
    : mode === 'compaction'
      ? { extensionPath: join(ROOT, 'test/fixtures/task-extension.mjs') }
      : {}),
});
const hold = (name) => {
  writeFileSync(join(dir, name), 'durable boundary reached');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
if (mode === 'between-steps') {
  const advance = service.taskWork.advance.bind(service.taskWork);
  service.taskWork.advance = (id) => {
    const step = service.store.db
      .prepare(
        'SELECT s.ordinal FROM task_grants g JOIN task_steps s ON s.id=g.step_id WHERE g.id=?',
      )
      .get(id);
    if (step?.ordinal === 1) hold('between-steps');
    return advance(id);
  };
}
if (mode === 'check-link') {
  const start = service.coding.start.bind(service.coding);
  service.coding.start = (...args) => {
    const result = start(...args);
    if (String(args[2].step_key).startsWith('task-check:')) hold('command-before-link');
    return result;
  };
}
if (mode === 'restore-prepared') {
  const replace = service.workspaces.replace.bind(service.workspaces);
  service.workspaces.replace = (...args) => {
    if (String(args[1]).startsWith('task-restore:')) hold('restore-before-write');
    return replace(...args);
  };
}
process.stdout.write('started\n');
process.once('SIGTERM', () => void service.close());
await service.closed;
