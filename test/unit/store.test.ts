import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const dir = mkdtempSync('/tmp/sal-store-');
  const store = new Store(join(dir, 'state.sqlite'));
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close(),
  );
  return { dir, store };
}
describe('transactional journal', () => {
  test('deduplicates a command before checking its old revision', () => {
    const { store, dir } = fixture();
    const session = store.create(dir, 'create');
    const result = store.accept(session.id, 'R1', session.revision, 'Do the work');
    expect(store.session(session.id).revision).toBeGreaterThan(session.revision);
    expect(store.accept(session.id, 'R1', session.revision, 'Do the work')).toEqual(result);
    expect(() => store.accept(session.id, 'R1', session.revision, 'Different work')).toThrow(
      'different input',
    );
    expect(() => store.accept(session.id, 'R2', session.revision, 'Do the work')).toThrow(
      'revision changed',
    );
    expect(store.db.prepare('SELECT count(*) AS n FROM submissions').get()).toMatchObject({ n: 1 });
  });
  test('rolls state and events back together and publishes only commits', () => {
    const { store, dir } = fixture();
    const session = store.create(dir, 'create');
    const published: unknown[] = [];
    store.changes.on('event', (x) => published.push(x));
    expect(() =>
      store.transaction(() => {
        store.event(session.id, 'will.rollback', {});
        throw new Error('fault');
      }),
    ).toThrow('fault');
    expect(store.events(session.id, 0).map((x) => x.kind)).toEqual(['session.created']);
    expect(store.session(session.id).seq).toBe(1);
    expect(published).toHaveLength(0);
    store.transaction(() => store.event(session.id, 'committed', {}));
    expect(published).toHaveLength(1);
    expect(store.events(session.id, 1)[0]?.seq).toBe(2);
  });
  test('rejects an unwritable transaction without acceptance or event', () => {
    const { store, dir } = fixture();
    const session = store.create(dir, 'create');
    store.db.exec('PRAGMA query_only=ON');
    expect(() => store.accept(session.id, 'R1', session.revision, 'Work')).toThrow();
    expect(store.events(session.id, 0)).toHaveLength(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM requests').get()).toMatchObject({ n: 1 });
    store.db.exec('PRAGMA query_only=OFF');
  });
  test('retains events and request results after reopening', () => {
    const dir = mkdtempSync('/tmp/sal-persist-');
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'state.sqlite');
    let store = new Store(path);
    const created = store.create(dir, 'create');
    store.close();
    store = new Store(path);
    cleanups.push(() => store.close());
    expect(store.create(dir, 'create')).toEqual(created);
    expect(store.events(created.id, 0)).toHaveLength(1);
    expect(store.db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(store.db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 });
    expect(store.db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });
  test('a full SQLite database cannot acknowledge an unrecorded submission', () => {
    const { store, dir } = fixture();
    const session = store.create(dir, 'create');
    const count = (store.db.prepare('PRAGMA page_count').get() as { page_count: number })
      .page_count;
    store.db.exec(`PRAGMA max_page_count=${count}`);
    expect(() =>
      store.accept(session.id, 'full', session.revision, 'x'.repeat(256 * 1024)),
    ).toThrow(/full/i);
    expect(store.events(session.id, 0)).toHaveLength(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM submissions').get()).toMatchObject({ n: 0 });
  });
  test('atomic artifact references have verified content digests', () => {
    const { store, dir } = fixture();
    const session = store.create(dir, 'create');
    const artifacts = new Artifacts(join(dir, 'artifacts'), store);
    const id = artifacts.put(session.id, 'Salaam 🌍');
    expect(artifacts.read(id)).toBe('Salaam 🌍');
    writeFileSync(join(dir, 'artifacts', id), 'changed');
    expect(() => artifacts.read(id)).toThrow('digest mismatch');
  });
});
