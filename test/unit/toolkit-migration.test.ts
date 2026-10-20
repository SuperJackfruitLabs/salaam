import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

test('v21 upgrade preserves all saved receipts and events without inventing native resource ownership', () => {
  const dir = mkdtempSync('/tmp/stkm-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'original');
    const accepted = store.accept(session.id, 'prompt', session.revision, 'Original instruction');
    const saved = store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all();
    const events = store.events(session.id, 0);
    store.db.exec('DROP TABLE toolkit_resources; PRAGMA user_version=21;');
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(22);
    expect(store.db.prepare('SELECT count(*) AS n FROM toolkit_resources').get()!.n).toBe(0);
    expect(store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all()).toEqual(saved);
    expect(store.events(session.id, 0)).toEqual(events);
    expect(store.accept(session.id, 'prompt', session.revision, 'Original instruction')).toEqual(
      accepted,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('partial native ownership upgrade and unknown future schema fail closed', () => {
  for (const version of [21, 23]) {
    const dir = mkdtempSync('/tmp/stkm-bad-'),
      path = join(dir, 'journal.sqlite');
    const store = new Store(path);
    store.db.exec(`PRAGMA user_version=${version}`);
    store.close();
    try {
      expect(() => new Store(path)).toThrow(
        version === 21 ? 'already exists' : 'newer than this service',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
