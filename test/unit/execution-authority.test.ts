import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { ChildWork } from '../../src/children.js';
import { Artifacts } from '../../src/artifacts.js';
import type { Supervisor } from '../../src/supervisor.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('revocation validates control, rolls back partial cancellation, inherits to children and leaves unrelated owners active', async () => {
  const dir = mkdtempSync('/tmp/sal-revoke-unit-');
  const store = new Store(':memory:');
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    reply: () => {},
    failed: () => {},
  });
  const children = new ChildWork(store, new Artifacts(join(dir, 'artifacts'), store), {
    assertActive: () => {},
    assertSessionProviderSupported: () => {},
    start: async () => {},
  } as unknown as Supervisor);
  try {
    const parent = store.create(dir, 'parent'),
      other = store.create(dir, 'other');
    const epoch = store.allocate(parent.id, 'boot');
    store.state(parent.id, epoch, 'ready');
    const attempt = store.accept(parent.id, 'prompt', store.session(parent.id).revision, 'Analyze');
    store.claim(parent.id, epoch);
    const child = children.spawn(parent.id, epoch, attempt.attempt_id, 'child', 'Read only', 1, [
      'salaam_probe',
    ]);
    const lease = store.control(parent.id, 'control', 'operator', 'acquire', 0);
    const controller = { client_id: 'operator', token: lease.token };
    let revision = store.session(parent.id).revision;
    const cancel = (id: string) => {
      managed.cancelInTransaction(id, 'revoke');
    };
    expect(() =>
      store.execution.revoke(
        parent.id,
        'bad-control',
        revision,
        'Revoke',
        { ...controller, token: 'wrong' },
        cancel,
      ),
    ).toThrow(/controller/i);
    expect(store.execution.revocation(parent.id)).toBeNull();
    expect(() =>
      store.execution.revoke(parent.id, 'stale', revision - 1, 'Revoke', controller, cancel),
    ).toThrow(/revision/i);
    const events = store.events(parent.id, 0);
    expect(() =>
      store.execution.revoke(parent.id, 'failed', revision, 'Revoke', controller, (id) => {
        cancel(id);
        throw Error('Cancellation recording failed');
      }),
    ).toThrow('recording failed');
    expect(store.execution.revocation(parent.id)).toBeNull();
    expect(store.cancelled(attempt.attempt_id)).toBe(false);
    expect(store.cancelled(child.child_attempt)).toBe(false);
    expect(store.events(parent.id, 0)).toEqual(events);
    const receipt = store.execution.revoke(
      parent.id,
      'revoke',
      revision,
      'Revoke',
      controller,
      cancel,
    );
    expect(receipt.session_ids).toContain(child.child_session);
    expect(store.execution.revocation(child.child_session)).toEqual(receipt);
    expect(store.cancelled(attempt.attempt_id)).toBe(true);
    expect(store.cancelled(child.child_attempt)).toBe(true);
    expect(() => store.allocate(child.child_session, 'replacement')).toThrow(/revoked/i);
    expect(() =>
      store.usage.admit(child.child_session, child.child_attempt, 'late', 'proof', 'model'),
    ).toThrow(/revoked/i);
    expect(() =>
      children.spawn(parent.id, epoch, attempt.attempt_id, 'late-child', 'Read', 1, [
        'salaam_probe',
      ]),
    ).toThrow(/revoked/i);
    expect(store.execution.revocation(other.id)).toBeNull();
    expect(
      store.accept(other.id, 'unrelated', store.session(other.id).revision, 'Still authorized')
        .state,
    ).toBe('accepted');
    expect(() =>
      store.execution.revoke(parent.id, 'revoke', revision, 'Changed reason', controller, cancel),
    ).toThrow(/different input/i);
  } finally {
    await children.close();
    await managed.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revocation preserves ambiguous dispatched effects instead of acknowledging a successful stop', async () => {
  const store = new Store(':memory:');
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    reply: () => {},
    failed: () => {},
  });
  try {
    const session = store.create('/tmp', 'session');
    const work = store.accept(session.id, 'prompt', session.revision, 'Review');
    const epoch = store.allocate(session.id, 'boot');
    store.state(session.id, epoch, 'ready');
    store.claim(session.id, epoch);
    const { operation } = await managed.prepare(
      session.id,
      epoch,
      work.attempt_id,
      'tool',
      'review',
      'target',
      'value',
    );
    // A recorded dispatch with no receipt is the conservative external-write boundary.
    store.db.prepare("UPDATE operations SET state='dispatching' WHERE id=?").run(operation.id);
    const lease = store.control(session.id, 'control', 'operator', 'acquire', 0);
    const receipt = store.execution.revoke(
      session.id,
      'revoke',
      store.session(session.id).revision,
      'Stop',
      { client_id: 'operator', token: lease.token },
      (id) => {
        managed.cancelInTransaction(id, 'revoke');
      },
    );
    expect(receipt.unresolved_operations).toEqual([operation.id]);
    expect(receipt.stop_confirmation).toBe('not_reported');
    expect(managed.operation(operation.id).state).toBe('outcome_unknown');
    expect(store.hasUnknown(session.id)).toBe(true);
  } finally {
    await managed.close();
    store.close();
  }
});
