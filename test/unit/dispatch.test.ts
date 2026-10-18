import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';

test('a committed handoff without a pipe write is interrupted, never requeued', () => {
  const dir = mkdtempSync('/tmp/sal-handoff-');
  const path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'create');
    const accepted = store.accept(session.id, 'submit', session.revision, 'Do once');
    const epoch = store.allocate(session.id, 'first-boot');
    store.state(session.id, epoch, 'ready');
    expect(store.claim(session.id, epoch)?.attempt.id).toBe(accepted.attempt_id);
    store.close();
    store = new Store(path);
    store.recoverWork();
    expect(store.attempt(accepted.attempt_id).state).toBe('interrupted');
    expect(store.claim(session.id, epoch)).toBe(null);
    expect(store.accept(session.id, 'submit', session.revision, 'Do once')).toEqual(accepted);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('controller expiry and takeover fence new mutations while preserving accepted-request retries', () => {
  const store = new Store(':memory:');
  try {
    const session = store.create('/tmp', 'create');
    const first = store.control(session.id, 'acquire', 'first', 'acquire', 0);
    const controller = { client_id: 'first', token: first.token };
    const revision = store.session(session.id).revision;
    const accepted = store.accept(session.id, 'submit', revision, 'One prompt', controller);
    const taken = store.control(session.id, 'takeover', 'second', 'takeover', first.epoch);
    expect(() =>
      store.accept(
        session.id,
        'new',
        store.session(session.id).revision,
        'Other prompt',
        controller,
      ),
    ).toThrow('controller lease');
    expect(store.accept(session.id, 'submit', revision, 'One prompt', controller)).toEqual(
      accepted,
    );
    expect(() =>
      store.control(session.id, 'stale', 'first', 'renew', first.epoch, first.token),
    ).toThrow('epoch changed');
    store.db.prepare('UPDATE controls SET expires_at=0 WHERE session_id=?').run(session.id);
    expect(() =>
      store.authorizeControl(session.id, { client_id: 'second', token: taken.token }),
    ).toThrow('controller lease');
    const next = store.control(session.id, 'expired', 'third', 'acquire', taken.epoch);
    expect(next.epoch).toBe(taken.epoch + 1);
  } finally {
    store.close();
  }
});

test('v1 queued submissions migrate to one accepted attempt and retain legacy request replies', () => {
  const dir = mkdtempSync('/tmp/sal-migrate-');
  const path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'create');
    const response = store.accept(session.id, 'old-submit', session.revision, 'Queued in M2');
    const legacy = { id: response.id, state: 'accepted' };
    store.db
      .prepare('UPDATE requests SET response=? WHERE id=?')
      .run(JSON.stringify(legacy), 'old-submit');
    store.db.exec(
      'PRAGMA foreign_keys=OFF; DROP TABLE task_step_attempts; DROP TABLE task_steps; DROP TABLE task_plans; DROP TABLE durable_tasks; DROP TABLE compaction_cancellations; DROP TABLE compactions; DROP TABLE task_facts; DROP TABLE task_heads; DROP TABLE session_routes; DROP TABLE usage_observations; DROP TABLE attempt_budgets; DROP TABLE child_tasks; DROP TABLE cancellations; DROP TABLE approval_dialogs; DROP TABLE approvals; DROP TABLE operations; DROP TABLE attempts; DROP TABLE controls; ALTER TABLE submissions DROP COLUMN attempt_id; PRAGMA user_version=1;',
    );
    store.close();
    store = new Store(path);
    expect(store.snapshot(session.id).attempts).toHaveLength(1);
    expect(store.snapshot(session.id).attempts[0]).toMatchObject({
      state: 'accepted',
      submission_id: response.id,
    });
    expect(store.accept(session.id, 'old-submit', session.revision, 'Queued in M2')).toEqual(
      legacy,
    );
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completed work is not interrupted by recovery and an unclaimed queue remains accepted', () => {
  const store = new Store(':memory:');
  try {
    const session = store.create('/tmp', 'create');
    const first = store.accept(session.id, 'first', session.revision, 'First');
    const epoch = store.allocate(session.id, 'boot');
    store.state(session.id, epoch, 'ready');
    store.claim(session.id, epoch);
    store.running(first.attempt_id);
    store.finish(first.attempt_id, 'completed', 'Result', null);
    const second = store.accept(session.id, 'second', store.session(session.id).revision, 'Second');
    store.recoverWork();
    expect(store.attempt(first.attempt_id)).toMatchObject({ state: 'completed', result: 'Result' });
    expect(store.attempt(second.attempt_id).state).toBe('accepted');
  } finally {
    store.close();
  }
});

test('snapshot publication sees transcript and completion together', () => {
  const store = new Store(':memory:');
  try {
    const session = store.create('/tmp', 'create');
    const accepted = store.accept(session.id, 'submit', session.revision, 'Hello');
    const epoch = store.allocate(session.id, 'boot');
    store.state(session.id, epoch, 'ready');
    store.claim(session.id, epoch);
    const snapshots: ReturnType<Store['snapshot']>[] = [];
    store.changes.on('event', () => snapshots.push(store.snapshot(session.id)));
    const entry = {
      id: 'assistant',
      parentId: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello back' }] },
    };
    store.finish(accepted.attempt_id, 'completed', 'Hello back', null, {
      epoch,
      entries: [entry],
      leaf: 'assistant',
    });
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.attempts[0]?.state).toBe('completed');
      expect(snapshot.messages).toMatchObject([{ role: 'assistant', text: 'Hello back' }]);
    }
  } finally {
    store.close();
  }
});
