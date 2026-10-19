import { expect, test } from 'vitest';
import { Store } from '../../src/store.js';
import { ManagedWork, type McpPermissionController } from '../../src/managed.js';
import type { Operation } from '../../src/protocol.js';

function fixture() {
  const store = new Store(':memory:');
  const session = store.create('/tmp', 'create');
  const accepted = store.accept(session.id, 'submit', session.revision, 'Owner routing fixture');
  const epoch = store.allocate(session.id, 'fixture-boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(accepted.attempt_id);
  store.db.exec(
    'CREATE TABLE fixture_mcp_owners(operation_id TEXT,owner TEXT,context TEXT,PRIMARY KEY(operation_id,owner))',
  );
  const managed = new ManagedWork(store, {
    assertActive: (id, e, attempt) => {
      store.assertEpoch(id, e);
      if (attempt !== accepted.attempt_id) throw Error('Wrong fixture attempt');
    },
    reply: () => {},
    failed: () => {},
  });
  const calls: string[] = [];
  const active = { value: true },
    settled = { value: true };
  const controller = (owner: string): McpPermissionController => ({
    owns: (op) =>
      !!store.db
        .prepare('SELECT 1 FROM fixture_mcp_owners WHERE operation_id=? AND owner=?')
        .get(op.id, owner),
    assert: (op) => {
      const row = store.db
        .prepare('SELECT context FROM fixture_mcp_owners WHERE operation_id=? AND owner=?')
        .get(op.id, owner);
      if (!active.value || !row || row.context !== op.target_version)
        throw Error('Fixture authority or context changed');
      calls.push(owner + ':' + op.id);
    },
    assertSettled: () => {
      if (!settled.value) throw Error('Fixture resources remain unconfirmed');
    },
  });
  let serial = 0;
  const prepare = (owner?: string) =>
    store.transaction(() => {
      const out = managed.prepareMcpInTransaction(
        session.id,
        epoch,
        accepted.attempt_id,
        'call-' + ++serial,
        'same-target/fixture-action',
        '{}',
        'a'.repeat(64),
      );
      if (owner)
        store.db
          .prepare('INSERT INTO fixture_mcp_owners VALUES (?,?,?)')
          .run(out.operation.id, owner, out.operation.target_version);
      return out;
    });
  const approve = (op: Operation) => {
    const approval = managed.forOperation(op.id);
    managed.decide(
      approval.id,
      'approve:' + op.id,
      approval.revision,
      op.operation_digest,
      'approve',
    );
  };
  return {
    store,
    managed,
    controller,
    calls,
    active,
    settled,
    prepare,
    approve,
    async close() {
      await managed.close();
      store.close();
    },
  };
}

test('distinct MCP controllers grant only their own durable records even with identical targets', async () => {
  const f = fixture();
  try {
    f.managed.registerMcpController('http-fixture', f.controller('http'));
    f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    const http = f.prepare('http').operation,
      toolkit = f.prepare('toolkit').operation;
    f.approve(http);
    f.approve(toolkit);
    f.calls.length = 0;
    expect(f.managed.takePermission(http.id)).toBe(true);
    expect(f.managed.takePermission(toolkit.id)).toBe(true);
    expect(f.managed.takePermission(http.id)).toBe(false);
    expect(f.managed.takePermission(toolkit.id)).toBe(false);
    expect(f.calls).toEqual(['http:' + http.id, 'toolkit:' + toolkit.id]);
    f.managed.permissionResult(http.id, true, { protocol_result: 'returned' });
    f.managed.permissionResult(toolkit.id, true, { protocol_result: 'returned' });
    expect(f.managed.operation(http.id).state).toBe('outcome_unknown');
    expect(f.managed.operation(toolkit.id).state).toBe('outcome_unknown');
  } finally {
    await f.close();
  }
});

test('an apparent MCP target cannot substitute for a durable execution owner', async () => {
  const f = fixture();
  try {
    f.managed.registerMcpController('http-fixture', f.controller('http'));
    const { operation, approval } = f.prepare();
    expect(() => f.approve(operation)).toThrow(/unique execution owner/i);
    expect(f.managed.approval(approval.id).state).toBe('pending');
    expect(f.managed.operation(operation.id).state).toBe('prepared');
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

test('two controllers claiming the same permission fail closed without choosing a winner', async () => {
  const f = fixture();
  try {
    f.managed.registerMcpController('http-fixture', f.controller('http'));
    f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    const { operation } = f.prepare('http');
    f.store.db
      .prepare('INSERT INTO fixture_mcp_owners VALUES (?,?,?)')
      .run(operation.id, 'toolkit', operation.target_version);
    expect(() => f.approve(operation)).toThrow(/unique execution owner/i);
    expect(f.calls).toEqual([]);
    expect(f.managed.operation(operation.id).state).toBe('prepared');
  } finally {
    await f.close();
  }
});

test('fresh authority and immutable owner context are still checked after human approval', async () => {
  const f = fixture();
  try {
    f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    const { operation } = f.prepare('toolkit');
    f.approve(operation);
    f.active.value = false;
    expect(() => f.managed.takePermission(operation.id)).toThrow(/authority/i);
    f.active.value = true;
    f.store.db
      .prepare('UPDATE fixture_mcp_owners SET context=? WHERE operation_id=?')
      .run('b'.repeat(64), operation.id);
    expect(() => f.managed.takePermission(operation.id)).toThrow(/context/i);
    expect(f.managed.operation(operation.id).state).toBe('prepared');
  } finally {
    await f.close();
  }
});

test('a stale controller disposer cannot unregister its replacement', async () => {
  const f = fixture();
  try {
    const old = f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    old();
    f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    old();
    const { operation } = f.prepare('toolkit');
    f.approve(operation);
    expect(f.managed.takePermission(operation.id)).toBe(true);
  } finally {
    await f.close();
  }
});

test('removing an owner or introducing a conflicting legacy callback cannot regrant permission', async () => {
  const f = fixture();
  try {
    const release = f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    const { operation } = f.prepare('toolkit');
    f.approve(operation);
    f.managed.options.assertMcpOperation = () => {};
    expect(() => f.managed.takePermission(operation.id)).toThrow(/conflicts/i);
    f.managed.options.assertMcpOperation = undefined;
    release();
    expect(() => f.managed.takePermission(operation.id)).toThrow(/unique execution owner/i);
    expect(f.managed.operation(operation.id).state).toBe('prepared');
  } finally {
    await f.close();
  }
});

test('operator attestation waits for the actual owner settlement but grants no new authority', async () => {
  const f = fixture();
  try {
    f.managed.registerMcpController('toolkit-fixture', f.controller('toolkit'));
    const { operation } = f.prepare('toolkit');
    f.approve(operation);
    expect(f.managed.takePermission(operation.id)).toBe(true);
    f.managed.permissionResult(operation.id, false, { protocol_result: 'unknown' });
    const unknown = f.managed.operation(operation.id);
    f.settled.value = false;
    const resolve = () =>
      f.managed.resolve(
        unknown.id,
        'resolve-fixture',
        unknown.revision,
        unknown.operation_digest,
        'failed_definite',
        'Synthetic explicit operator attestation',
      );
    expect(resolve).toThrow(/resources/i);
    expect(f.managed.operation(unknown.id).state).toBe('outcome_unknown');
    f.settled.value = true;
    f.active.value = false; // Reconciliation is allowed after authority ends; new effects are not.
    const result = resolve();
    expect(result.state).toBe('failed_definite');
    expect(JSON.parse(result.resolution!)).toMatchObject({ source: 'operator-attestation' });
    expect(f.managed.takePermission(result.id)).toBe(false);
  } finally {
    await f.close();
  }
});
