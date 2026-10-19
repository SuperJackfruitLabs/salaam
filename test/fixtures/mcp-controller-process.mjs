// Disposable crash-proof controller. Real SDK/HTTP/SQLite, synthetic work authority.
import { readFileSync } from 'node:fs';
import { Store } from '../../dist/src/store.js';
import { ManagedWork } from '../../dist/src/managed.js';
import { Artifacts } from '../../dist/src/artifacts.js';
import { McpAdmission } from '../../dist/src/mcp-admission.js';
import { McpWork } from '../../dist/src/mcp-work.js';

const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const store = new Store(c.database);
const assertActive = (session, epoch, attempt) => {
  store.assertEpoch(session, epoch);
  if (
    session !== c.session ||
    epoch !== c.epoch ||
    attempt !== c.attempt ||
    store.cancelled(attempt)
  )
    throw Error('Synthetic authority is not active');
};
const managed = new ManagedWork(store, { assertActive, reply() {}, failed() {} });
const artifacts = new Artifacts(c.artifacts, store);
const work = new McpWork(store, managed, artifacts, {
  admission: new McpAdmission(c.profile, c.pins, c.profileDigest),
  assertActive,
  current: () => c.assignment.binding,
  failed() {},
});
managed.recover();
work.recover();
work.assign(c.session, c.assignment);
store.changes.on('event', (event) => {
  if (event.kind.startsWith('mcp.'))
    process.send?.({ type: 'event', kind: event.kind, payload: event.payload });
});
process.on('message', (message) => {
  try {
    let value;
    if (message.command === 'prepare')
      value = work.prepare(c.session, c.epoch, c.attempt, message.logical, {
        server: 'superlibrary',
        tool: message.tool,
        arguments: { query: 'offline crash fixture' },
      });
    else if (message.command === 'approve') {
      const call = work.get(message.call),
        op = managed.operation(call.operation_id),
        approval = managed.forOperation(op.id);
      value = managed.decide(
        approval.id,
        'approve:' + call.id,
        approval.revision,
        op.operation_digest,
        'approve',
      );
    } else if (message.command === 'start')
      value = work.start(message.call, c.session, c.epoch, c.attempt);
    else if (message.command === 'get') value = work.get(message.call);
    else if (message.command === 'result')
      value = artifacts.read(work.get(message.call).result_artifact);
    else if (message.command === 'status')
      value = { ...work.status(c.session), unknown: store.hasUnknown(c.session) };
    else if (message.command === 'cancel') {
      value = store.transaction(() => {
        const receipt = managed.cancelInTransaction(c.attempt, 'fixture-root-cancel');
        work.cancelInTransaction(c.attempt);
        return receipt;
      });
      work.abortAttempt(c.attempt);
    } else throw Error('Unsupported fixture command');
    process.send?.({ type: 'reply', id: message.id, value });
  } catch (error) {
    process.send?.({
      type: 'reply',
      id: message.id,
      error: { code: error.code ?? 'fixture_error', message: error.message },
    });
  }
});
process.on('disconnect', () => {
  work
    .close()
    .then(() => managed.close())
    .then(
      () => {
        store.close();
        process.exit(0);
      },
      () => process.exit(1),
    );
});
process.send?.({ type: 'ready' });
