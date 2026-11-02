import { expect, test } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { StationWork, StationFilesDefiniteFailure } from '../../src/agentpod/station-work.js';

// Item 11b: restoring files writes each one through the protected helper, exactly as planned,
// chaining the expected tree, with a receipt per file; it never starts on a changed workspace.
function fixture(fail?: { at: number; definite: boolean }) {
  const dir = mkdtempSync('/tmp/sal-restore-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const session = store.create(dir, 'create').id;
  let live = 't6',
    patches = 0;
  const sent: Record<string, unknown>[] = [];
  const work = Object.assign(Object.create(StationWork.prototype), {
    store,
    artifacts,
    configurationDigest: 'c'.repeat(64),
    helper: async (request: Record<string, unknown>) => {
      if (request.action === 'inspect') return { tree_digest: live };
      // The real helper (agentpod stationfs) refuses any patch whose request id is not 64 hex.
      if (!/^[a-f0-9]{64}$/.test(String(request.request_id)))
        throw new StationFilesDefiniteFailure('station_request_invalid');
      sent.push(request);
      if (fail && ++patches === fail.at)
        throw fail.definite
          ? new StationFilesDefiniteFailure('station_request_invalid')
          : new Error('unconfirmed');
      live = 'r' + sent.length;
      return {
        ok: true,
        path: request.path,
        before_tree_digest: request.expected_tree,
        tree_digest: live,
        sha256: null,
      };
    },
  }) as StationWork;
  const plan = {
    restore_digest: 'd'.repeat(64),
    current_tree: 't6',
    writes: [
      { path: 'runs/r/a.md', content: 'v1', expected_hash: 'h-v2' },
      { path: 'runs/r/b.md', content: null, expected_hash: 'h-new' },
      ...(fail ? [{ path: 'runs/r/c.md', content: 'c', expected_hash: null }] : []),
    ],
  };
  const calls = () =>
    store.db
      .prepare(
        'SELECT w.path,w.state,w.artifact_id FROM station_restore_writes w JOIN station_restores r ON r.id=w.restore_id WHERE r.session_id=? ORDER BY w.n',
      )
      .all(session);
  return { store, artifacts, work, session, plan, sent, calls, setLive: (t: string) => (live = t) };
}

test('each planned write goes through the helper in order, chained, with a receipt', async () => {
  const f = fixture();
  const receipt = (await f.work.restore(
    f.session,
    'root',
    f.plan,
    'restore:1',
    'prn_admin',
  )) as Record<string, any>;
  expect(receipt).toMatchObject({
    state: 'restored',
    restore_digest: 'd'.repeat(64),
    tree_digest: 'r2',
  });
  expect(f.sent.map((r) => [r.path, r.expected_tree, r.expected_hash, r.content])).toEqual([
    ['runs/r/a.md', 't6', 'h-v2', 'v1'],
    ['runs/r/b.md', 'r1', 'h-new', null],
  ]);
  expect(Object.keys(f.sent[0]!).sort()).toEqual([
    'action',
    'content',
    'deadline_ms',
    'expected_hash',
    'expected_tree',
    'path',
    'request_id',
  ]);
  const calls = f.calls();
  expect(calls.map((c) => [c.path, c.state])).toEqual([
    ['runs/r/a.md', 'returned'],
    ['runs/r/b.md', 'returned'],
  ]);
  // Each write has its own receipt, naming the approver and the approved digest.
  const receiptDoc = JSON.parse(f.artifacts.read(String(calls[0]!.artifact_id)));
  expect(receiptDoc).toMatchObject({
    kind: 'station-restore-receipt',
    approved_by: 'prn_admin',
    restore_digest: 'd'.repeat(64),
    path: 'runs/r/a.md',
  });
  // The same request replays its receipt and writes nothing more.
  expect(await f.work.restore(f.session, 'root', f.plan, 'restore:1', 'prn_admin')).toEqual(
    receipt,
  );
  expect(f.sent).toHaveLength(2);
});

test('a workspace that changed since the review is refused before any write', async () => {
  const f = fixture();
  f.setLive('t7');
  await expect(f.work.restore(f.session, 'root', f.plan, 'restore:1', 'prn_admin')).rejects.toThrow(
    'changed',
  );
  expect(f.sent).toHaveLength(0);
  expect(f.calls()).toHaveLength(0);
});

test('a helper failure stops the restore: definite is failed, anything else is unknown', async () => {
  for (const definite of [true, false]) {
    const f = fixture({ at: 2, definite });
    const receipt = (await f.work.restore(
      f.session,
      'root',
      f.plan,
      'restore:1',
      'prn_admin',
    )) as Record<string, any>;
    expect(receipt).toMatchObject({ state: 'partial', stopped_at: 'runs/r/b.md' });
    expect(f.calls().map((c) => c.state)).toEqual([
      'returned',
      definite ? 'failed' : 'outcome_unknown',
    ]);
    // Nothing after the failed write is attempted.
    expect(f.sent.map((r) => r.path)).toEqual(['runs/r/a.md', 'runs/r/b.md']);
  }
});

test('a write still in flight when the daemon stopped becomes an honest unknown', () => {
  const f = fixture();
  f.store.db.exec('PRAGMA foreign_keys=OFF');
  (f.work as any).restoreTables();
  f.store.db
    .prepare(
      "INSERT INTO station_restores VALUES ('rs','" +
        f.session +
        "','restore:9','d','p','running',NULL)",
    )
    .run();
  f.store.db
    .prepare(
      "INSERT INTO station_restore_writes VALUES ('rs',0,'runs/r/a.md','{}','dispatching',NULL,NULL)",
    )
    .run();
  (f.work as any).recoverRestores();
  expect(f.store.db.prepare('SELECT state FROM station_restore_writes').get()!.state).toBe(
    'outcome_unknown',
  );
  expect(f.store.db.prepare('SELECT state FROM station_restores').get()!.state).toBe('partial');
});

// The checkpoint diff reads the live workspace through the helper's closed verbs only.
test('the live workspace comes from inspect, an exact search and a read, and guesses nothing', async () => {
  const asked: Record<string, unknown>[] = [];
  const files: Record<string, string> = {
    'runs/r/a.md': 'by hand',
    'runs/r/a.md.bak': 'x',
    'runs/r/big.bin': '',
  };
  const work = Object.assign(Object.create(StationWork.prototype), {
    helper: async (request: Record<string, unknown>) => {
      asked.push(request);
      if (request.action === 'inspect') return { tree_digest: 'live-tree' };
      if (request.action === 'search')
        return {
          entries: Object.keys(files)
            .filter((p) => p.includes(String(request.query)))
            .map((path) => ({ path })),
          next_offset: null,
        };
      if (request.action === 'read') {
        if (request.path === 'runs/r/big.bin') throw new Error('refused');
        return { path: request.path, content: files[String(request.path)], sha256: 'h' };
      }
      throw new Error('unexpected ' + String(request.action));
    },
  }) as StationWork;
  const live = await work.live();
  expect(live.tree).toBe('live-tree');
  expect(await live.file('runs/r/a.md')).toEqual({
    state: 'content',
    content: 'by hand',
    sha256: 'h',
  });
  // A path that only appears inside a longer one is absent, not found.
  expect(await live.file('runs/r/a')).toEqual({ state: 'absent' });
  expect(await live.file('runs/r/big.bin')).toEqual({ state: 'unreadable' });
  expect(new Set(asked.map((r) => r.action))).toEqual(new Set(['inspect', 'search', 'read']));
});
