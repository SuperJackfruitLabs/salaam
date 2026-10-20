import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

test('v20 migration preserves receipts and history without inventing MCP assignments or calls', () => {
  const dir = mkdtempSync('/tmp/smm-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'create');
    const accepted = store.accept(
      session.id,
      'original',
      session.revision,
      'Preserved logical instruction',
    );
    const requests = store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all();
    const events = store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all();
    // Represent an actual old database: it cannot contain tables introduced later.
    store.db.exec(
      'DROP TABLE station_units; DROP TABLE station_calls; DROP TABLE toolkit_resolution_controls; DROP TABLE toolkit_resolutions; DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; PRAGMA user_version=20;',
    );
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(26);
    expect(store.db.prepare('SELECT * FROM requests ORDER BY actor,id').all()).toEqual(requests);
    expect(store.db.prepare('SELECT * FROM events ORDER BY session_id,seq').all()).toEqual(events);
    expect(store.db.prepare('SELECT count(*) AS n FROM mcp_calls').get()!.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM mcp_assignments').get()!.n).toBe(0);
    expect(
      store.accept(session.id, 'original', session.revision, 'Preserved logical instruction'),
    ).toEqual(accepted);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backdated database with unexpected future MCP tables fails instead of accepting partial upgrade state', () => {
  const dir = mkdtempSync('/tmp/smm-partial-'),
    path = join(dir, 'journal.sqlite');
  const store = new Store(path);
  store.db.exec('PRAGMA user_version=20');
  store.close();
  try {
    expect(() => new Store(path)).toThrow('already exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
