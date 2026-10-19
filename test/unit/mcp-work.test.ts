import { expect, test } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';
import { ManagedWork } from '../../src/managed.js';
import { McpWork } from '../../src/mcp-work.js';
import { McpAdmission } from '../../src/mcp-admission.js';
import { McpHttpFailure, McpInputFailure } from '../../src/mcp-http.js';
import { mcpProfile } from '../../src/mcp-protocol.js';
import { agentpodBinding } from '../../src/agentpod-protocol.js';
import { digest, ServiceError } from '../../src/protocol.js';
import corpus from '../fixtures/agentpod-mcp-v1.json' with { type: 'json' };
import { until } from '../helpers.js';

function fixture(calls = 16) {
  const dir = realpathSync(mkdtempSync('/tmp/smw-')),
    workspace = join(dir, 'work');
  mkdirSync(workspace, { mode: 0o700 });
  const binding = agentpodBinding({
    ...corpus.assignments[0]!.value.binding,
    workspace,
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
  });
  const { version, organization_id, node_id, station_key } = binding;
  const pins = { version, organization_id, node_id, station_key, workspace };
  const profile = mcpProfile(corpus.profiles[0]!.value);
  profile.limits.calls_per_attempt = calls;
  profile.servers[0]!.tools.push({
    name: 'fixture_mutate',
    schema_digest: 'b'.repeat(64),
    policy: 'approval',
  });
  const config = join(dir, 'mcp.json');
  writeFileSync(config, JSON.stringify(profile), { mode: 0o600 });
  const profileDigest = digest({ profile, pins_digest: digest(pins) });
  const admission = new McpAdmission(config, pins, profileDigest);
  const assignment = {
    ...corpus.assignments[0]!.value,
    binding,
    profile_digest: profileDigest,
    servers: corpus.assignments[0]!.value.servers.map((server) => ({
      ...server,
      url: server.url.replace(
        /mcp-managed-v1\/[a-f0-9]{64}\//,
        `mcp-managed-v1/${digest(binding)}/`,
      ),
    })),
  };
  const path = join(dir, 'state.sqlite');
  let store = new Store(path),
    artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const session = store.create(workspace, 'create');
  const accepted = store.accept(session.id, 'submit', session.revision, 'Offline MCP fixture');
  const epoch = store.allocate(session.id, 'fixture-boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(accepted.attempt_id);
  const mode = {
    active: true,
    lost: false,
    hold: false,
    echo: false,
    ungated: false,
    expireDuringConnect: false,
    invalidArguments: false,
    closeFailure: false,
  };
  const counters = { connects: 0 };
  const sent: { name: string; args: unknown }[] = [],
    failures: Error[] = [];
  const assertActive = (id: string, e: number, attempt: string) => {
    store.assertEpoch(id, e);
    if (!mode.active || attempt !== accepted.attempt_id || store.cancelled(attempt))
      throw new ServiceError('authority_expired', 'Fixture authority expired');
  };
  const managedOptions = {
    assertActive,
    reply: () => {},
    failed: (_id: string, error: Error) => {
      failures.push(error);
    },
  };
  let managed = new ManagedWork(store, managedOptions);
  const makeWork = () =>
    new McpWork(store, managed, artifacts, {
      admission,
      assertActive,
      current: (_id: string) => {
        if (!mode.active) throw new ServiceError('authority_expired', 'Fixture authority expired');
        return binding;
      },
      failed: (_id: string, error: Error) => {
        failures.push(error);
      },
      connection: (server) => ({
        async connect() {
          counters.connects++;
          if (mode.expireDuringConnect) mode.active = false;
        },
        describe() {
          return [{ name: 'library_search', inputSchema: { type: 'object' } }];
        },
        async call(
          name: string,
          args: Record<string, unknown>,
          signal: AbortSignal,
          beforeSend: () => void,
        ) {
          if (mode.invalidArguments) throw new McpInputFailure();
          if (!mode.ungated)
            try {
              beforeSend();
            } catch {
              throw new McpHttpFailure(false);
            }
          sent.push({ name, args });
          if (mode.lost) throw new McpHttpFailure(true);
          if (mode.hold)
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new McpHttpFailure(true));
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort, { once: true });
            });
          return {
            protocol_result: 'returned' as const,
            is_error: false,
            content: [
              {
                type: 'text' as const,
                text: mode.echo ? server.headers[0]!.value : 'Offline fixture result',
              },
            ],
          };
        },
        async close() {
          if (mode.closeFailure) throw new Error('fixture cleanup failed');
        },
      }),
    });
  let work = makeWork();
  work.assign(session.id, assignment);
  return {
    dir,
    session,
    epoch,
    accepted,
    mode,
    sent,
    failures,
    assignment,
    binding,
    profile,
    counters,
    get store() {
      return store;
    },
    get artifacts() {
      return artifacts;
    },
    get managed() {
      return managed;
    },
    get work() {
      return work;
    },
    prepare(
      id: string,
      tool = 'library_search',
      args: Record<string, unknown> = { query: 'fixture' },
    ) {
      return work.prepare(session.id, epoch, accepted.attempt_id, id, {
        server: 'superlibrary',
        tool,
        arguments: args,
      });
    },
    start(id: string) {
      return work.start(id, session.id, epoch, accepted.attempt_id);
    },
    approve(id: string) {
      const call = work.get(id),
        op = managed.operation(call.operation_id!),
        approval = managed.forOperation(op.id);
      return managed.decide(
        approval.id,
        'approve:' + id,
        approval.revision,
        op.operation_digest,
        'approve',
      );
    },
    async reopen() {
      await work.close();
      await managed.close();
      store.close();
      store = new Store(path);
      artifacts = new Artifacts(join(dir, 'artifacts'), store);
      managed = new ManagedWork(store, managedOptions);
      work = makeWork();
      managed.recover();
      work.recover();
      work.assign(session.id, assignment);
    },
    async close() {
      await work.close().catch((error) => {
        if (!mode.closeFailure) throw error;
      });
      await managed.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('one logical MCP read retains its call and result receipt through retry and reopen', async () => {
  const f = fixture();
  try {
    const call = f.prepare('read-once');
    expect(call.operation_id).toBeNull();
    f.start(call.id);
    f.start(call.id);
    const returned = await until(
      () => f.work.get(call.id),
      (c) => c.state === 'returned',
    );
    expect(f.sent).toHaveLength(1);
    expect(JSON.parse(f.artifacts.read(returned.result_artifact!))).toMatchObject({
      protocol_result: 'returned',
      is_error: false,
    });
    await f.reopen();
    f.mode.active = false;
    expect(f.prepare('read-once')).toEqual(returned);
    expect(f.start(call.id)).toEqual(returned);
    expect(f.sent).toHaveLength(1);
    expect(() => f.prepare('read-once', 'library_search', { query: 'changed' })).toThrow(
      'different',
    );
  } finally {
    await f.close();
  }
});

test('an operator cannot clear MCP uncertainty while local resource cleanup is unconfirmed', async () => {
  const f = fixture();
  try {
    f.mode.closeFailure = true;
    const call = f.prepare('unconfirmed-resolution', 'fixture_mutate', { value: 'fixture' });
    f.approve(call.id);
    f.start(call.id);
    await until(
      () => f.work.status(f.session.id),
      (s) => s.active_calls.length === 0 && s.control_error !== null,
    );
    const op = f.managed.operation(call.operation_id!);
    expect(op.state).toBe('outcome_unknown');
    expect(() =>
      f.managed.resolve(
        op.id,
        'unsafe-resolution',
        op.revision,
        op.operation_digest,
        'failed_definite',
        'Synthetic operator observation does not confirm local resource cleanup',
      ),
    ).toThrow(/resource|settled|cleanup/i);
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
    await expect(f.work.close()).rejects.toThrow(/cleanup|reconciliation/i);
    expect(() => new McpWork(f.store, f.managed, f.artifacts, f.work.options)).toThrow(
      /registered/i,
    );
  } finally {
    await f.close();
  }
});

test('readiness binds progressive discovery to the current assignment without sending tools/call', async () => {
  const f = fixture();
  try {
    const binding = await f.work.ready(f.session.id);
    expect(f.work.describe(f.session.id, binding, 'superlibrary', 'library_search')).toMatchObject({
      name: 'library_search',
    });
    expect(f.sent).toHaveLength(0);
    f.work.assign(f.session.id, { ...f.assignment, credential_generation: 2 });
    expect(() => f.work.describe(f.session.id, binding)).toThrow(/changed/i);
  } finally {
    await f.close();
  }
});

test('ordinary invalid tool arguments send nothing and preserve controller readiness', async () => {
  const f = fixture();
  try {
    f.mode.invalidArguments = true;
    const c = f.prepare('bad-arguments', 'fixture_mutate');
    f.approve(c.id);
    f.start(c.id);
    await until(
      () => f.work.get(c.id),
      (v) => v.state === 'failed_definite',
    );
    expect(f.sent).toHaveLength(0);
    expect(f.failures).toEqual([]);
    expect(f.managed.operation(c.operation_id!).state).toBe('failed_definite');
    f.mode.invalidArguments = false;
    const next = f.prepare('valid-read');
    f.start(next.id);
    await until(
      () => f.work.get(next.id),
      (v) => v.state === 'returned',
    );
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a failed transport close cannot be reported as stopped or cleared by reinstalling assignment', async () => {
  const f = fixture();
  try {
    f.mode.closeFailure = true;
    await expect(f.work.ready(f.session.id)).rejects.toThrow(/readiness/i);
    expect(f.work.status(f.session.id).active_calls).toEqual([]);
    expect(f.work.stopped(f.session.id)).toBe(false);
    f.work.assign(f.session.id, f.assignment);
    expect(() => f.prepare('after-cleanup-failure')).toThrow(/unavailable/i);
    await expect(f.work.stopSession(f.session.id)).rejects.toThrow(/stopped/i);
  } finally {
    await f.close();
  }
});

test('MCP mutation permission is exact, once-only and opaque until its owner effect is reconciled', async () => {
  const f = fixture();
  try {
    const call = f.prepare('write-once', 'fixture_mutate');
    f.start(call.id);
    expect(f.sent).toHaveLength(0);
    f.approve(call.id);
    f.start(call.id);
    const returned = await until(
      () => f.work.get(call.id),
      (c) => c.state === 'outcome_unknown',
    );
    expect(f.sent).toHaveLength(1);
    expect(returned.result_artifact).not.toBeNull();
    expect(f.managed.operation(call.operation_id!).state).toBe('outcome_unknown');
    expect(f.prepare('write-once', 'fixture_mutate').id).toBe(call.id);
    f.start(call.id);
    expect(f.sent).toHaveLength(1);
    expect(() => f.prepare('another-write', 'fixture_mutate')).toThrow('Unresolved');
  } finally {
    await f.close();
  }
});

test('lost MCP mutation response remains fenced after reopening and cannot be blindly resent', async () => {
  const f = fixture();
  try {
    f.mode.lost = true;
    const call = f.prepare('lost-write', 'fixture_mutate');
    f.approve(call.id);
    f.start(call.id);
    await until(
      () => f.work.get(call.id),
      (c) => c.state === 'outcome_unknown',
    );
    await f.reopen();
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
    expect(f.start(call.id).state).toBe('outcome_unknown');
    expect(f.sent).toHaveLength(1);
    expect(() => f.prepare('retry-with-new-id', 'fixture_mutate')).toThrow('Unresolved');
  } finally {
    await f.close();
  }
});

test('an uncertain persisted dispatch marker reopens as unknown without replay', async () => {
  const f = fixture();
  try {
    const call = f.prepare('marker-only', 'fixture_mutate');
    f.approve(call.id);
    f.store.transaction(() => {
      expect(f.managed.takePermissionInTransaction(call.operation_id!)).toBe(true);
      f.store.db.prepare("UPDATE mcp_calls SET state='dispatching' WHERE id=?").run(call.id);
    });
    await f.reopen();
    expect(f.work.get(call.id).state).toBe('outcome_unknown');
    f.start(call.id);
    expect(f.sent).toHaveLength(0);
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
  } finally {
    await f.close();
  }
});

test('call acceptance rolls its approval and events back together on storage failure', async () => {
  const f = fixture();
  try {
    const published: unknown[] = [];
    f.store.changes.on('event', (e) => published.push(e));
    f.store.db.exec(
      "CREATE TEMP TRIGGER deny_mcp BEFORE INSERT ON mcp_calls BEGIN SELECT RAISE(ABORT,'mcp receipt full'); END;",
    );
    expect(() => f.prepare('atomic-write', 'fixture_mutate')).toThrow('receipt full');
    expect(f.store.operations(f.session.id)).toEqual([]);
    expect(f.store.approvals(f.session.id)).toEqual([]);
    expect(f.store.db.prepare('SELECT count(*) AS n FROM mcp_calls').get()!.n).toBe(0);
    expect(published).toEqual([]);
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('failed dispatch-marker storage cannot consume permission or send a mutation', async () => {
  const f = fixture();
  try {
    const call = f.prepare('dispatch-full', 'fixture_mutate');
    f.approve(call.id);
    f.store.db.exec(
      "CREATE TEMP TRIGGER deny_mcp_dispatch BEFORE UPDATE OF state ON mcp_calls WHEN NEW.state='dispatching' BEGIN SELECT RAISE(ABORT,'dispatch receipt full'); END;",
    );
    f.start(call.id);
    await until(
      () => f.work.get(call.id),
      (c) => c.state === 'failed_definite',
    );
    expect(f.sent).toHaveLength(0);
    expect(f.managed.operation(call.operation_id!).state).toBe('failed_definite');
  } finally {
    await f.close();
  }
});

test('authority expiry before send and exact call limits deny new grants', async () => {
  const f = fixture(2);
  try {
    const first = f.prepare('first'),
      second = f.prepare('second');
    expect(f.prepare('first').id).toBe(first.id);
    expect(() => f.prepare('third')).toThrow('limit');
    f.mode.active = false;
    f.start(second.id);
    await until(
      () => f.work.get(second.id),
      (c) => c.state === 'failed_definite',
    );
    expect(f.sent).toHaveLength(0);
    expect(f.counters.connects).toBe(0);
  } finally {
    await f.close();
  }
});

test('authority expiring during preflight cannot consume its approved mutation permission', async () => {
  const f = fixture();
  try {
    const call = f.prepare('expire-in-preflight', 'fixture_mutate');
    f.approve(call.id);
    f.mode.expireDuringConnect = true;
    f.start(call.id);
    await until(
      () => f.work.get(call.id),
      (c) => c.state === 'failed_definite',
    );
    expect(f.counters.connects).toBe(1);
    expect(f.sent).toHaveLength(0);
    expect(f.managed.operation(call.operation_id!).state).toBe('failed_definite');
  } finally {
    await f.close();
  }
});

test('repeating an identical node assignment during reconnect does not cancel accepted work', async () => {
  const f = fixture();
  try {
    f.mode.hold = true;
    const call = f.prepare('hold-through-reconnect', 'fixture_mutate');
    f.approve(call.id);
    f.start(call.id);
    await until(
      () => f.sent.length,
      (n) => n === 1,
    );
    f.work.assign(f.session.id, f.assignment);
    expect(f.work.get(call.id).state).toBe('dispatching');
    f.store.transaction(() => f.work.cancelInTransaction(f.accepted.attempt_id));
    f.work.abortAttempt(f.accepted.attempt_id);
    await until(
      () => f.work.status(f.session.id).active_calls,
      (calls) => calls.length === 0,
    );
    expect(f.work.get(call.id).state).toBe('outcome_unknown');
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('the final receipt boundary redacts private keys even when another transport adapter returns them', async () => {
  const f = fixture();
  try {
    f.mode.echo = true;
    const call = f.prepare('adapter-secret-echo');
    f.start(call.id);
    const returned = await until(
      () => f.work.get(call.id),
      (c) => c.state === 'returned',
    );
    const artifact = f.artifacts.read(returned.result_artifact!);
    expect(artifact).not.toContain('fixture-proxy-key');
    expect(artifact).toContain('[redacted]');
  } finally {
    await f.close();
  }
});

test('an adapter returning without the durable handoff is a control failure with uncertain effects', async () => {
  const f = fixture();
  try {
    f.mode.ungated = true;
    const call = f.prepare('ungated-adapter', 'fixture_mutate');
    f.approve(call.id);
    f.start(call.id);
    const result = await until(
      () => f.work.get(call.id),
      (c) => c.state !== 'prepared',
    );
    expect(result.state).toBe('outcome_unknown');
    expect(f.managed.operation(call.operation_id!).state).toBe('outcome_unknown');
    expect(f.sent).toHaveLength(1);
    expect(f.failures.length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});

test('credential generations cannot roll back or silently change and private keys never enter the journal', async () => {
  const f = fixture();
  try {
    const rotated = {
      ...f.assignment,
      credential_generation: 2,
      servers: f.assignment.servers.map((s) => ({
        ...s,
        headers: [
          { name: 'X-Agentpod-Proxy-Key', value: 'rotated-fixture-key-never-use-as-a-live-secret' },
        ],
      })),
    };
    f.work.assign(f.session.id, rotated);
    expect(() => f.work.assign(f.session.id, f.assignment)).toThrow('generation');
    expect(() =>
      f.work.assign(f.session.id, { ...f.assignment, credential_generation: 2 }),
    ).toThrow('generation');
    expect(() =>
      f.prepare('leak-key', 'library_search', {
        query: 'rotated-fixture-key-never-use-as-a-live-secret',
      }),
    ).toThrow();
    const journal = JSON.stringify([
      f.store.db.prepare('SELECT * FROM mcp_assignments').all(),
      f.store.db.prepare('SELECT * FROM mcp_calls').all(),
      f.store.events(f.session.id, 0),
    ]);
    expect(journal).not.toContain('rotated-fixture-key');
    expect(journal).not.toContain('fixture-proxy-key');
    expect(journal).not.toContain('X-Agentpod');
  } finally {
    await f.close();
  }
});
