import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/store/store.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { fixture } from '../helpers.js';
import { traceSql } from '../sql-trace.js';

// Phase 7a (modularity): the state schema a fresh database gets, and the exact SQL the store runs
// for a session's life, in order. Pinned before the store splits into its schema, event log and
// query groups: the split must not change a table, an index or a statement.

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function master(db: DatabaseSync) {
  return {
    user_version: db.prepare('PRAGMA user_version').get()?.user_version,
    objects: db
      .prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY rowid')
      .all()
      .map((row) => ({ ...row })),
  };
}

test('a fresh store creates the same schema', () => {
  const dir = mkdtempSync('/tmp/sal-schema-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(join(dir, 'journal.sqlite'));
  try {
    expect(master(store.db)).toMatchSnapshot('fresh store');
    store.enableStationTaskChecks();
    expect(master(store.db)).toMatchSnapshot('after station task checks');
  } finally {
    store.close();
  }
  // Reopening a current database changes nothing.
  const again = new Store(join(dir, 'journal.sqlite'));
  try {
    expect(master(again.db)).toMatchSnapshot('after station task checks');
  } finally {
    again.close();
  }
});

test('a fresh service journal has the same schema', async () => {
  const f = await fixture();
  const path = join(f.dir, 'journal.sqlite');
  await f.service.close();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(master(db)).toMatchSnapshot();
  } finally {
    db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a newer schema is refused and the database is left closed', () => {
  const dir = mkdtempSync('/tmp/sal-schema-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA user_version=32');
  db.close();
  expect(() => new Store(path)).toThrow('Database schema is newer than this service');
});

test("the store runs the same statements, in the same order, through a session's life", () => {
  const trace = traceSql();
  const root = mkdtempSync('/tmp/sal-store-trace-');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(':memory:');
  cleanups.push(() => store.close());
  const steps: [string, number][] = [];
  const step = (name: string) => steps.push([name, trace().length]);
  step('opened');
  store.toolExecution = { mode: 'service-user', user: 'me', uid: 501 };
  const session = store.create(root, 'create', false, {
    workspace: true,
    coding: true,
    route: OFFLINE_ROUTE,
  });
  store.create(root, 'create', false, { workspace: true, coding: true, route: OFFLINE_ROUTE });
  step('created');
  store.writable();
  expect(store.localCoding(session.id)).toBe(true);
  expect(store.localWorkspace(session.id)).toBe(true);
  expect(store.localOutputCap(session.id)).toBe(true);
  expect(store.providerRoute(session.id)).toEqual(OFFLINE_ROUTE);
  store.bindRoute(session.id, OFFLINE_ROUTE);
  step('read');
  const lease = store.control(session.id, 'c1', 'client', 'acquire', 0);
  const renewed = store.control(session.id, 'c2', 'client', 'renew', lease.epoch, lease.token);
  const controller = { client_id: 'client', token: renewed.token };
  expect(store.controlView(session.id).client_id).toBe('client');
  store.nameSession(session.id, 'n1', 'named', controller);
  expect(store.sessionName(session.id)).toBe('named');
  step('controlled');
  const revision = store.session(session.id).revision;
  const accepted = store.accept(session.id, 's1', revision, 'hello');
  const submit = { kind: 'submit', session: session.id, expectedRevision: revision, text: 'hello' };
  expect(store.cachedRequest('local-operator', 's1', submit)).toEqual(accepted);
  expect(store.cachedRequest('local-operator', 'unused', submit)).toBeUndefined();
  const epoch = store.allocate(session.id, 'boot');
  store.process(session.id, epoch, 123, 'identity');
  store.state(session.id, epoch, 'ready', null, ['x'], join(root, 'pi.jsonl'));
  step('ready');
  const claimed = store.claim(session.id, epoch);
  expect(claimed?.attempt.id).toBe(accepted.attempt_id);
  expect(store.claim(session.id, epoch)).toBeNull();
  store.running(accepted.attempt_id);
  const entries = [
    { id: 'e1', parentId: null, message: { role: 'user', content: 'hello' } },
    {
      id: 'e2',
      parentId: 'e1',
      message: {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 't1' },
          { type: 'text', text: 'hi' },
        ],
      },
    },
  ];
  store.importEntries(session.id, epoch, entries.slice(0, 1), 'e1');
  store.finish(
    accepted.attempt_id,
    'completed',
    'done',
    null,
    { epoch, entries, leaf: 'e2' },
    { version: 1, stopReason: 'end_turn' },
  );
  step('finished');
  expect(store.lastPrompt(session.id)).toBe('hello');
  expect(store.toolMetadata(session.id, 't1')).toBeNull();
  expect(store.hasUnknown(session.id)).toBe(false);
  expect(store.cancelled(accepted.attempt_id)).toBe(false);
  expect(store.attempt(accepted.attempt_id).outcome?.stopReason).toBe('end_turn');
  const snapshot = store.snapshot(session.id);
  expect(snapshot.messages.map((m) => m.text)).toEqual(['hello', 'hi']);
  expect(store.events(session.id, 0).length).toBeGreaterThan(5);
  expect(store.sessions().length).toBe(1);
  expect(store.approvals(session.id)).toEqual([]);
  expect(store.operations(session.id)).toEqual([]);
  step('snapshot');
  store.state(session.id, epoch, 'stopped');
  const fork = store.forkLocal(
    session.id,
    'f1',
    store.session(session.id).revision,
    controller,
    () => join(root, 'fork.jsonl'),
  );
  const rewound = store.forkLocal(
    session.id,
    'f2',
    store.session(session.id).revision,
    controller,
    () => join(root, 'rewind.jsonl'),
    { leaf: 'e1' },
  );
  expect(store.session(rewound.id).pi_leaf).toBe('e1');
  step('forked');
  const switched = store.switchRoute(fork.id, { ...OFFLINE_ROUTE, max_tokens: 2048 });
  expect(switched.from).toEqual(OFFLINE_ROUTE);
  const next = store.accept(fork.id, 's2', store.session(fork.id).revision, 'again');
  const forkEpoch = store.allocate(fork.id, 'boot');
  store.state(fork.id, forkEpoch, 'ready');
  store.claim(fork.id, forkEpoch);
  step('switched');
  store.recoverWork();
  expect(store.attempt(next.attempt_id).state).toBe('interrupted');
  step('recovered');
  store.control(session.id, 'c3', 'client', 'takeover', store.controlView(session.id).epoch);
  store.control(
    session.id,
    'c4',
    'client',
    'release',
    store.controlView(session.id).epoch,
    store.control(session.id, 'c3', 'client', 'takeover', store.controlView(session.id).epoch - 1)
      .token,
  );
  step('released');
  store.enableStationTaskChecks();
  step('migrated');
  expect(steps).toMatchSnapshot('steps');
  expect(trace()).toMatchSnapshot('statements');
});
