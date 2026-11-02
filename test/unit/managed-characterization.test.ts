import { afterEach, expect, test, vi } from 'vitest';
import { Store } from '../../src/store/store.js';
import { ManagedWork } from '../../src/execution/managed.js';
import type { EffectConnector } from '../../src/execution/effect-connector.js';
import { traceSql } from '../sql-trace.js';

// Phase 7a (modularity): what managed work does for each kind of permission, as the statements it
// runs, the events it commits and the errors it gives, in order. Pinned before managed.ts splits by
// concern: the split must not change one of them.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('managed work runs the same statements and commits the same events for every permission', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const store = new Store(':memory:');
  const session = store.create('/tmp', 'create');
  const submission = store.accept(session.id, 'submit', session.revision, 'Test');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const attempt = submission.attempt_id;
  const log: unknown[] = [];
  const ids = new Map<string, string>();
  const label = (value: string) => {
    if (!ids.has(value)) ids.set(value, `#${ids.size}`);
    return ids.get(value);
  };
  store.changes.on('event', (e: { kind: string; payload: unknown }) =>
    log.push({ event: e.kind, keys: Object.keys(Object(e.payload)) }),
  );
  const connector: EffectConnector = {
    id: 'fixture-connector',
    replay: 'lookup',
    version: () => Promise.resolve('v1'),
    dispatch: (key, input) => Promise.resolve({ id: key, accepted: true, payload: input }),
    lookup: () => Promise.resolve(null),
  };
  const replies: unknown[] = [];
  const managed = new ManagedWork(store, {
    connector,
    approvalTtlMs: 60000,
    assertActive: (id, number, owner) => {
      store.assertEpoch(id, number);
      if (owner !== attempt || store.cancelled(owner)) throw new Error('inactive attempt');
    },
    reply: (_s, _e, request, confirmed) => replies.push({ request, confirmed }),
    failed: (_s, error) => log.push({ failed: error.message }),
  });
  let owned = new Set<string>();
  const unregister = managed.registerMcpController('fixture-owner', {
    owns: (op) => owned.has(op.id),
    assert: () => {},
    assertSettled: () => {},
  });
  managed.registerMcpResolutionController('fixture-resolver', {
    owns: (op) => op.target === 'resolve-me',
    assertResolution: () => {},
  });
  const trace = traceSql();
  const step = async (name: string, fn: () => unknown) => {
    const from = trace().length;
    try {
      const value = await fn();
      log.push({ step: name, ok: typeof value === 'object' && value ? Object.keys(value) : value });
    } catch (error) {
      log.push({ step: name, error: String(error) });
    }
    log.push({ statements: trace().slice(from) });
  };
  const context = 'c'.repeat(64);
  const workspace = (call: string, target = 'local') =>
    store.transaction(() => {
      const prepared = managed.prepareWorkspaceInTransaction(
        session.id,
        epoch,
        attempt,
        call,
        target,
        'value',
        context,
      );
      owned = new Set([...owned, prepared.operation.id]);
      return prepared;
    });
  const approve = (p: { approval: { id: string; revision: number; operation_digest: string } }) =>
    managed.decide(
      p.approval.id,
      'd-' + p.approval.id,
      p.approval.revision,
      p.approval.operation_digest,
      'approve',
    );

  const review = await managed.prepare(session.id, epoch, attempt, 'r1', 'review', 'doc', 'read');
  await step('review again', () =>
    managed.prepare(session.id, epoch, attempt, 'r1', 'review', 'doc', 'read'),
  );
  await step('review conflict', () =>
    managed.prepare(session.id, epoch, attempt, 'r1', 'review', 'doc', 'x'),
  );
  await step('dialog', () =>
    managed.bindDialog(
      session.id,
      epoch,
      review.approval.id,
      review.operation.operation_digest,
      'pi-1',
    ),
  );
  await step('offer', () => managed.assertDecisionOffer(review.approval.id));
  await step('approve review', () => approve(review));
  await step('start review', () => managed.start(review.operation.id, session.id, epoch, attempt));
  await vi.waitFor(() => expect(managed.operation(review.operation.id).state).toBe('succeeded'));
  await step('effect', async () => {
    const effect = await managed.prepare(session.id, epoch, attempt, 'e1', 'effect', 't', 'v');
    approve(effect);
    managed.start(effect.operation.id, session.id, epoch, attempt);
    await vi.waitFor(() => expect(managed.operation(effect.operation.id).state).toBe('succeeded'));
    return managed.operation(effect.operation.id);
  });
  await step('deny', async () => {
    const denied = await managed.prepare(session.id, epoch, attempt, 'd1', 'harness', 'h', 'v');
    return managed.decide(
      denied.approval.id,
      'deny-1',
      denied.approval.revision,
      denied.approval.operation_digest,
      'deny',
    );
  });
  await step('stale decision', () =>
    managed.decide(review.approval.id, 'late', 1, review.approval.operation_digest, 'approve'),
  );
  await step('workspace result', () => {
    const w = workspace('w1');
    approve(w);
    store.transaction(() => managed.takePermissionInTransaction(w.operation.id));
    store.transaction(() => managed.workspaceResultInTransaction(w.operation.id, { ok: true }));
    return managed.operation(w.operation.id);
  });
  await step('workspace scoped', () => {
    const w = workspace('w2');
    return managed.decide(
      w.approval.id,
      'scoped',
      w.approval.revision,
      w.approval.operation_digest,
      'approve',
      {
        receipt: { policy: 'p' },
        authorize: () => {},
        decidedBy: 'rule:user',
      },
    );
  });
  await step('local failure', () => {
    const w = workspace('w3');
    approve(w);
    managed.takePermission(w.operation.id);
    store.transaction(() =>
      managed.localExecutionResultInTransaction(w.operation.id, false, { code: 1 }),
    );
    return managed.operation(w.operation.id);
  });
  await step('workspace unknown', () => {
    const w = workspace('w4');
    approve(w);
    managed.takePermission(w.operation.id);
    store.transaction(() => managed.workspaceUnknownInTransaction(w.operation.id));
    return managed.operation(w.operation.id);
  });
  await step('blocked by unknown', () => workspace('w5'));
  await step('resolve', () => {
    const op = managed.operation([...owned].at(-1) ?? '');
    return managed.resolve(
      op.id,
      'res-1',
      op.revision,
      op.operation_digest,
      'failed_definite',
      'checked',
    );
  });
  await step('workspace definite failure', () => {
    const w = workspace('w6');
    approve(w);
    managed.takePermission(w.operation.id);
    store.transaction(() => managed.workspaceDefiniteFailureInTransaction(w.operation.id));
    return managed.operation(w.operation.id);
  });
  await step('workspace not sent', () => {
    const w = workspace('w7');
    store.transaction(() => managed.workspaceNotSentInTransaction(w.operation.id));
    return managed.operation(w.operation.id);
  });
  await step('mcp not sent', async () => {
    const m = await managed.prepareMcp(session.id, epoch, attempt, 'm1', 'mcp/x', '{}', context);
    owned = new Set([...owned, m.operation.id]);
    managed.mcpNotSent(m.operation.id);
    return managed.operation(m.operation.id);
  });
  await step('mcp result', async () => {
    const m = await managed.prepareMcp(
      session.id,
      epoch,
      attempt,
      'm2',
      'resolve-me',
      '{}',
      context,
    );
    owned = new Set([...owned, m.operation.id]);
    approve(m);
    managed.takePermission(m.operation.id);
    managed.permissionResult(m.operation.id, true, { protocol_result: 'ok' });
    const op = managed.operation(m.operation.id);
    return managed.resolve(op.id, 'res-2', op.revision, op.operation_digest, 'succeeded', 'seen');
  });
  await step('mcp unknown', async () => {
    const m = await managed.prepareMcp(
      session.id,
      epoch,
      attempt,
      'm3',
      'resolve-me',
      '{}',
      context,
    );
    owned = new Set([...owned, m.operation.id]);
    store.transaction(() => managed.mcpUnknownInTransaction(m.operation.id));
    const op = managed.operation(m.operation.id);
    await managed.reconcile(op.id);
    await managed.reconcileAll();
    return managed.resolve(op.id, 'res-3', op.revision, op.operation_digest, 'succeeded', 'seen');
  });
  await step('expire', async () => {
    const h = await managed.prepare(session.id, epoch, attempt, 'x1', 'harness', 'h2', 'v');
    store.db.prepare('UPDATE approvals SET expires_at=0 WHERE id=?').run(h.approval.id);
    managed.expire();
    return managed.operation(h.operation.id);
  });
  await step('invalidate worker', async () => {
    const h = await managed.prepare(session.id, epoch, attempt, 'x2', 'harness', 'h3', 'v');
    managed.invalidateWorker(session.id, epoch);
    return managed.operation(h.operation.id);
  });
  await step('recover', () => managed.recover());
  await step('pending', () => managed.pending().length);
  await step('cancel', async () => {
    await managed.prepare(session.id, epoch, attempt, 'x3', 'harness', 'h4', 'v');
    const lease = store.control(session.id, 'lease', 'client', 'acquire', 0);
    return managed.cancel(attempt, 'cancel-1', store.session(session.id).revision, {
      client_id: 'client',
      token: lease.token,
    });
  });
  await step('cancel settled', () =>
    managed.cancel(attempt, 'cancel-2', store.session(session.id).revision, {
      client_id: 'x',
      token: 'y',
    }),
  );
  await step('register twice', () =>
    managed.registerMcpController('fixture-owner', {
      owns: () => false,
      assert: () => {},
      assertSettled: () => {},
    }),
  );
  unregister();
  await managed.close();
  store.close();
  const text = JSON.stringify(log, (_k, v: unknown) =>
    typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? label(v) : v,
  );
  expect({ log: JSON.parse(text), replies }).toMatchSnapshot();
});
