import { expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { AgentPodAuthority } from '../../src/agentpod-authority.js';
import { ToolkitResources } from '../../src/toolkit-resources.js';
import { ToolkitCalls, type ToolkitActionPin } from '../../src/toolkit-calls.js';
import { ManagedWork } from '../../src/managed.js';
import { digest } from '../../src/protocol.js';
import type { ToolkitRequest } from '../../src/toolkit-protocol.js';

async function fixture(read = false) {
  const base = realpathSync(mkdtempSync('/tmp/stkc-')),
    workspace = join(base, 'work'),
    state = join(base, 'private');
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(state, { mode: 0o700 });
  const binding = {
    version: 1 as const,
    organization_id: 'org_00000000000000000001',
    principal_id: 'prn_00000000000000000002',
    node_id: 'node_fixture',
    station_id: 'station_fixture',
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
    occupancy_epoch: 1,
    hub_session_id: 'hub_fixture',
    workspace,
    run: { source: 'agentpod' as const, id: 'run_fixture', epoch: 1 },
  };
  const pins = join(state, 'pins.json');
  const { version, organization_id, node_id, station_key } = binding;
  writeFileSync(
    pins,
    JSON.stringify({ version, organization_id, node_id, station_key, workspace }),
    { mode: 0o600 },
  );
  const store = new Store(join(state, 'journal.sqlite'));
  const authority = new AgentPodAuthority(store, state, pins, () => {});
  const session = authority.admit(binding, 'admit').session_id;
  authority.renew(binding, 'renew', 1);
  const s = store.session(session),
    accepted = store.accept(
      session,
      'prompt',
      s.revision,
      'Synthetic worker epoch; no model or native effect',
    );
  const epoch = store.allocate(session, 'worker-fixture');
  store.state(session, epoch, 'ready');
  store.claim(session, epoch);
  store.running(accepted.attempt_id);
  const assertActive = (id: string, e: number, attempt: string) => {
    store.assertEpoch(id, e);
    store.execution.assert(id);
    if (
      attempt !== accepted.attempt_id ||
      store.attempt(attempt).state !== 'running' ||
      store.cancelled(attempt)
    )
      throw Error('Inactive worker fixture');
  };
  const managed = new ManagedWork(store, { assertActive, reply: () => {}, failed: () => {} }),
    resources = new ToolkitResources(store, authority);
  store.nativeResourceCheck = (id) => resources.assertSession(id);
  const peer = join(state, 'peer.mjs');
  writeFileSync(
    peer,
    `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'resource-only-fixture',version:'1'}}})+'\\n');});setInterval(()=>{},1000);`,
    { mode: 0o600 },
  );
  const stateDir = join(state, 'broker');
  mkdirSync(stateDir, { mode: 0o700 });
  const launch = {
    command: realpathSync(process.execPath),
    executable_digest: createHash('sha256')
      .update(readFileSync(realpathSync(process.execPath)))
      .digest('hex'),
    args: [peer],
    cwd: workspace,
    env: { HOME: state },
    protocol_version: '2025-06-18' as const,
    limits: { request_bytes: 65536, response_bytes: 131072, stderr_bytes: 4096, timeout_ms: 3000 },
  };
  const spec = {
    id: 'broker-resource',
    session_id: session,
    root_digest: digest(binding),
    profile_digest: 'b'.repeat(64),
    manifest_digest: 'c'.repeat(64),
    state_dir: stateDir,
    launch_digest: digest(launch),
  };
  const client = new Client(
    { name: 'native-call-resource-fixture', version: '1' },
    { capabilities: {} },
  );
  await client.connect(resources.transport(spec, launch));
  const pin: ToolkitActionPin = {
    kind: read ? 'read' : 'write',
    policy: read ? 'agent' : 'approval',
    digest: 'd'.repeat(64),
  };
  const calls = new ToolkitCalls(store, managed, {
    authority,
    resources,
    assertActive,
    action: () => ({ ...pin }),
  });
  const request: ToolkitRequest = {
    version: 1,
    root_digest: digest(binding),
    profile_digest: spec.profile_digest,
    invocation_id: 'invocation-1',
    service: 'fixture',
    action: read ? 'read' : 'write',
    args: { value: 'synthetic' },
    approval: !read,
    expires_at_ms: Date.now() + 60000,
  };
  const prepare = (input = request, tool = 'tool-1') =>
    calls.prepare(session, epoch, accepted.attempt_id, tool, spec.id, input);
  const approve = (id: string) => {
    const op = managed.operation(calls.get(id).operation_id!),
      a = managed.forOperation(op.id);
    managed.decide(a.id, 'approve:' + id, a.revision, op.operation_digest, 'approve');
  };
  return {
    base,
    store,
    authority,
    managed,
    resources,
    calls,
    request,
    pin,
    spec,
    binding,
    session,
    epoch,
    attempt: accepted.attempt_id,
    prepare,
    approve,
    async close() {
      calls.close();
      await client.close();
      await resources.close();
      await managed.close();
      store.close();
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('delivery and credential admission do not consume the exact human-bound native permission; dispatch consumes once', async () => {
  const f = await fixture();
  try {
    const call = f.prepare();
    expect(JSON.parse(f.managed.operation(call.operation_id!).value)).toEqual(f.request.args);
    expect(f.managed.operation(call.operation_id!).target_version).toBe(call.context_digest);
    f.calls.deliver(call.id);
    expect(f.calls.verify(f.spec.id, 'review', f.request).decision).toBe('pending');
    expect(f.calls.verify(f.spec.id, 'admit', f.request).decision).toBe('denied');
    f.approve(call.id);
    expect(f.calls.verify(f.spec.id, 'review', f.request)).toMatchObject({
      decision: 'allowed',
      decision_id: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(f.calls.verify(f.spec.id, 'admit', f.request)).toMatchObject({
      decision: 'allowed',
      authority_for_ms: expect.any(Number),
    });
    expect(f.managed.operation(call.operation_id!).state).toBe('prepared');
    const granted = f.calls.verify(f.spec.id, 'dispatch', f.request);
    expect(granted).toMatchObject({ decision: 'allowed', send_within_ms: 1000 });
    expect(granted.authority_for_ms).toBeLessThanOrEqual(60000);
    expect(f.managed.operation(call.operation_id!).state).toBe('dispatching');
    expect(f.calls.get(call.id).state).toBe('dispatching');
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('denied');
  } finally {
    await f.close();
  }
});

test('SQL failure rolls the dispatch marker and managed permission back together', async () => {
  const f = await fixture();
  try {
    const call = f.prepare();
    f.approve(call.id);
    f.calls.deliver(call.id);
    f.store.db.exec(
      "CREATE TEMP TRIGGER fail_toolkit_dispatch BEFORE INSERT ON events WHEN NEW.kind='toolkit.call.dispatching' BEGIN SELECT RAISE(ABORT,'fixture dispatch failure'); END;",
    );
    expect(() => f.calls.verify(f.spec.id, 'dispatch', f.request)).toThrow(
      'fixture dispatch failure',
    );
    expect(f.calls.get(call.id).state).toBe('delivered');
    expect(f.managed.operation(call.operation_id!).state).toBe('prepared');
    f.store.db.exec('DROP TRIGGER fail_toolkit_dispatch');
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('allowed');
  } finally {
    await f.close();
  }
});

test('a read still gets one durable native dispatch grant without fabricating a human approval', async () => {
  const f = await fixture(true);
  try {
    const call = f.prepare();
    expect(call.operation_id).toBeNull();
    f.calls.deliver(call.id);
    expect(f.calls.verify(f.spec.id, 'admit', f.request).decision).toBe('allowed');
    expect(f.calls.get(call.id).state).toBe('delivered');
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('allowed');
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('denied');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM approvals').get()!.n).toBe(0);
  } finally {
    await f.close();
  }
});

test('saved uncertainty precedes new authority checks, remains root/principal scoped, and cannot replay', async () => {
  const f = await fixture();
  try {
    const call = f.prepare();
    f.approve(call.id);
    f.calls.deliver(call.id);
    f.calls.verify(f.spec.id, 'dispatch', f.request);
    f.calls.recover();
    f.store.db.exec('UPDATE agentpod_admissions SET expires_at=0');
    expect(f.prepare()).toMatchObject({ id: call.id, state: 'outcome_unknown' });
    expect(f.calls.saved(call.id, f.binding).state).toBe('outcome_unknown');
    expect(() =>
      f.calls.saved(call.id, { ...f.binding, principal_id: 'prn_00000000000000000003' }),
    ).toThrow();
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('denied');
    expect(() => f.calls.deliver(call.id)).toThrow();
    expect(f.managed.operation(call.operation_id!).state).toBe('outcome_unknown');
    expect(() => f.prepare({ ...f.request, args: { value: 'changed' } })).toThrow();
  } finally {
    await f.close();
  }
});

for (const change of [
  'resource',
  'arguments',
  'expiry',
  'action-kind',
  'worker',
  'root-expiry',
] as const)
  test(`fresh native grants reject ${change} changes`, async () => {
    const f = await fixture();
    try {
      const call = f.prepare();
      f.approve(call.id);
      f.calls.deliver(call.id);
      let resource = f.spec.id,
        input = f.request;
      if (change === 'resource') resource = 'wrong-resource';
      if (change === 'arguments') input = { ...input, args: { value: 'changed' } };
      if (change === 'expiry') input = { ...input, expires_at_ms: input.expires_at_ms + 1 };
      if (change === 'action-kind') f.pin.kind = 'destructive';
      if (change === 'worker')
        f.store.db.prepare('UPDATE sessions SET epoch=epoch+1 WHERE id=?').run(f.session);
      if (change === 'root-expiry') f.store.db.exec('UPDATE agentpod_admissions SET expires_at=0');
      expect(() => f.calls.verify(resource, 'dispatch', input)).toThrow();
      expect(f.managed.operation(call.operation_id!).state).toBe('prepared');
    } finally {
      await f.close();
    }
  });

test('native automatic-write policies are not misclassified as reads', async () => {
  const f = await fixture(true);
  try {
    f.pin.kind = 'write';
    expect(() => f.prepare()).toThrow();
    expect(f.store.db.prepare('SELECT count(*) AS n FROM toolkit_calls').get()!.n).toBe(0);
  } finally {
    await f.close();
  }
});

test('uncertain read dispatch fences actual root renewal even after its local broker has stopped', async () => {
  const f = await fixture(true);
  try {
    const call = f.prepare();
    f.calls.deliver(call.id);
    f.calls.verify(f.spec.id, 'dispatch', f.request);
    f.calls.recover();
    expect(f.store.hasUnknown(f.session)).toBe(true);
    await f.resources.stop(f.spec.id);
    expect(f.resources.stopped(f.session)).toBe(true);
    expect(() => f.authority.renew(f.binding, 'renew-after-native-uncertainty', 2)).toThrowError(
      expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }),
    );
    expect(f.authority.inspect(f.binding).authorized).toBe(false);
    expect(f.calls.saved(call.id, f.binding).state).toBe('outcome_unknown');
  } finally {
    await f.close();
  }
});

test('a native pending receipt preserves the original call and immutable review deadline', async () => {
  const f = await fixture();
  try {
    const call = f.prepare();
    f.calls.deliver(call.id);
    const receipt = {
      id: call.id,
      request_digest: call.request_digest,
      state: 'awaiting_decision',
    };
    expect(f.calls.record(call.id, f.spec.id, receipt).state).toBe('pending');
    expect(f.calls.record(call.id, f.spec.id, receipt).revision).toBe(
      f.calls.get(call.id).revision,
    );
    f.approve(call.id);
    f.calls.deliver(call.id);
    expect(f.calls.verify(f.spec.id, 'review', f.request).decision).toBe('allowed');
    expect(JSON.parse(f.calls.get(call.id).request_json).expires_at_ms).toBe(
      f.request.expires_at_ms,
    );
  } finally {
    await f.close();
  }
});

test('an opaque native write result remains uncertain, whereas an admitted read can return protocol data', async () => {
  for (const read of [false, true]) {
    const f = await fixture(read);
    try {
      const call = f.prepare();
      if (!read) f.approve(call.id);
      f.calls.deliver(call.id);
      f.calls.verify(f.spec.id, 'dispatch', f.request);
      const receipt = {
        id: call.id,
        request_digest: call.request_digest,
        state: 'returned',
        result: '{"status":"protocol result only"}',
      };
      expect(f.calls.record(call.id, f.spec.id, receipt).state).toBe(
        read ? 'returned' : 'outcome_unknown',
      );
      expect(f.store.hasUnknown(f.session)).toBe(!read);
      if (!read) expect(f.managed.operation(call.operation_id!).state).toBe('outcome_unknown');
      const revision = f.calls.get(call.id).revision;
      expect(f.calls.record(call.id, f.spec.id, receipt).revision).toBe(revision);
      expect(() => f.calls.record(call.id, f.spec.id, { ...receipt, result: 'changed' })).toThrow();
    } finally {
      await f.close();
    }
  }
});

test('a native denial before grant is definite; a denial after a spent grant cannot erase uncertainty', async () => {
  for (const spent of [false, true]) {
    const f = await fixture();
    try {
      const call = f.prepare();
      f.approve(call.id);
      f.calls.deliver(call.id);
      if (spent) f.calls.verify(f.spec.id, 'dispatch', f.request);
      const receipt = { id: call.id, request_digest: call.request_digest, state: 'denied' };
      expect(f.calls.record(call.id, f.spec.id, receipt).state).toBe(
        spent ? 'outcome_unknown' : 'denied',
      );
      expect(f.managed.operation(call.operation_id!).state).toBe(
        spent ? 'outcome_unknown' : 'failed_definite',
      );
    } finally {
      await f.close();
    }
  }
});

test('closing the native owner denies new read grants while retaining saved data', async () => {
  const f = await fixture(true);
  try {
    const call = f.prepare();
    f.calls.deliver(call.id);
    f.calls.close();
    expect(f.calls.verify(f.spec.id, 'dispatch', f.request).decision).toBe('denied');
    expect(f.prepare().id).toBe(call.id);
    expect(f.calls.saved(call.id, f.binding).state).toBe('delivered');
  } finally {
    await f.close();
  }
});

test('receipt persistence failure immediately fences grants even when the uncertainty write also fails', async () => {
  const f = await fixture(true);
  try {
    const call = f.prepare();
    f.calls.deliver(call.id);
    f.calls.verify(f.spec.id, 'dispatch', f.request);
    f.store.db.exec('PRAGMA query_only=ON');
    expect(() =>
      f.calls.record(call.id, f.spec.id, {
        id: call.id,
        request_digest: call.request_digest,
        state: 'returned',
        result: '{"protocol":"only"}',
      }),
    ).toThrow();
    expect(f.calls.get(call.id).state).toBe('dispatching');
    expect(() => f.authority.leaseWindow(f.session, digest(f.binding), 1000)).toThrowError(
      expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }),
    );
    f.store.db.exec('PRAGMA query_only=OFF');
    await f.resources.stop(f.spec.id);
    expect(() => f.authority.renew(f.binding, 'still-cannot-renew-after-stop', 2)).toThrow();
    f.calls.recover();
    expect(f.calls.get(call.id).state).toBe('outcome_unknown');
  } finally {
    f.store.db.exec('PRAGMA query_only=OFF');
    await f.close();
  }
});
