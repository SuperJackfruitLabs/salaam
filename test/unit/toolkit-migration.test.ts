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
    store.db.exec(
      'DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; PRAGMA user_version=21;',
    );
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(24);
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
  for (const version of [21, 23, 25]) {
    const dir = mkdtempSync('/tmp/stkm-bad-'),
      path = join(dir, 'journal.sqlite');
    const store = new Store(path);
    store.db.exec(`PRAGMA user_version=${version}`);
    store.close();
    try {
      expect(() => new Store(path)).toThrow(
        version === 25 ? 'newer than this service' : 'already exists',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('v22 call-owner migration preserves existing resource ownership and session ledger', () => {
  const dir = mkdtempSync('/tmp/stkm-calls-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'original'),
      saved = store.events(session.id, 0);
    store.db.exec(
      'DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; PRAGMA user_version=22;',
    );
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(24);
    expect(store.db.prepare('SELECT count(*) AS n FROM toolkit_calls').get()!.n).toBe(0);
    expect(store.events(session.id, 0)).toEqual(saved);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v23 cleanup upgrade preserves owner records and never invents historical cleanup delegation', () => {
  const dir = mkdtempSync('/tmp/stkm-cleanup-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'original');
    store.db
      .prepare(
        'INSERT INTO toolkit_resources(id,session_id,root_digest,profile_digest,state_dir,input_digest,spec,owner_boot,state) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'legacy-prepared',
        session.id,
        'a'.repeat(64),
        'b'.repeat(64),
        join(dir, 'private'),
        'c'.repeat(64),
        '{}',
        'old-daemon',
        'prepared',
      );
    store.db
      .prepare('INSERT INTO toolkit_owners VALUES(?,?)')
      .run('legacy-prepared', 'd'.repeat(64));
    const rows = store.db.prepare('SELECT * FROM toolkit_resources').all(),
      owners = store.db.prepare('SELECT * FROM toolkit_owners').all(),
      events = store.events(session.id, 0);
    store.db.exec('DROP TABLE toolkit_cleanup_profiles; PRAGMA user_version=23;');
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(24);
    expect(store.db.prepare('SELECT * FROM toolkit_resources').all()).toEqual(rows);
    expect(store.db.prepare('SELECT * FROM toolkit_owners').all()).toEqual(owners);
    expect(store.db.prepare('SELECT count(*) AS n FROM toolkit_cleanup_profiles').get()!.n).toBe(0);
    expect(store.events(session.id, 0)).toEqual(events);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
