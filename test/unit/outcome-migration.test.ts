import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

test('v19 upgrade preserves immutable receipts and history without inventing verified outcomes', () => {
  const dir = mkdtempSync('/tmp/sal-outcome-migration-'),
    path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'session');
    const accepted = store.accept(
      session.id,
      'legacy-prompt',
      session.revision,
      'Legacy completed turn',
    );
    const epoch = store.allocate(session.id, 'legacy-boot');
    store.state(session.id, epoch, 'ready');
    store.claim(session.id, epoch);
    store.running(accepted.attempt_id);
    store.finish(accepted.attempt_id, 'completed', 'Legacy reply', null);
    store.request('fixture', 'saved', { input: 'immutable' }, () => {
      store.event(session.id, 'fixture.history', { text: 'Preserved bytes' });
      return { accepted: true, logical: 'same-instruction' };
    });
    const requests = store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all();
    const events = store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all();
    store.db.exec(
      'DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; PRAGMA user_version=19;',
    );
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(20);
    expect(store.attempt(accepted.attempt_id)).toMatchObject({
      state: 'completed',
      result: 'Legacy reply',
      outcome: null,
    });
    expect(store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all()).toEqual(requests);
    expect(store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all()).toEqual(events);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM turn_cancellations').get()!.n).toBe(0);
    expect(
      store.request('fixture', 'saved', { input: 'immutable' }, () => {
        throw Error('No replay');
      }),
    ).toEqual({ accepted: true, logical: 'same-instruction' });
    store.close();
    store = new Store(path);
    expect(store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all()).toEqual(events);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
