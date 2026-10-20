import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

test('v16 upgrade preserves saved admissions and event bytes before enabling peer mappings; reopen is idempotent', () => {
  const dir = mkdtempSync('/tmp/sal-a2a-migration-'),
    path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'session');
    store.request('peer-fixture', 'saved', { version: 1 }, () => {
      store.event(session.id, 'fixture.bound', { task: 'owned', authority: 'analysis-only' });
      return { id: 'same-owned-task', acknowledged: true };
    });
    const requests = store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all(),
      events = store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all();
    store.db.exec(
      'DROP TABLE local_calls; DROP TABLE station_units; DROP TABLE station_calls; DROP TABLE toolkit_resolution_controls; DROP TABLE toolkit_resolutions; DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; PRAGMA user_version=16;',
    );
    store.close();
    store = new Store(path);
    expect(store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all()).toEqual(requests);
    expect(store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all()).toEqual(events);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(27);
    expect(() =>
      store.db
        .prepare('INSERT INTO a2a_inbound VALUES (?,?,?,?,?,?,?,?,?,?,?,0)')
        .run(
          'x',
          'peer',
          'tenant',
          'message',
          'hash',
          'unowned-assignment',
          'grant',
          'context',
          'unowned-child',
          1,
          'review',
        ),
    ).toThrow(/FOREIGN KEY/);
    store.close();
    store = new Store(path);
    expect(
      store.request('peer-fixture', 'saved', { version: 1 }, () => {
        throw Error('Must not resubmit');
      }),
    ).toEqual({ id: 'same-owned-task', acknowledged: true });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
