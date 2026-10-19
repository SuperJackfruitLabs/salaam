import { expect, test, vi } from 'vitest';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import type { EffectConnector, EffectInput, EffectReceipt } from '../../src/effect-connector.js';
import { until } from '../helpers.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Outbox } from '../../src/attach.js';
import { randomUUID } from 'node:crypto';

function setup(connector?: EffectConnector) {
  const store = new Store(':memory:');
  const session = store.create('/tmp', 'create');
  const submission = store.accept(session.id, 'submit', session.revision, 'Test');
  const epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const failures: Error[] = [];
  const managed = new ManagedWork(store, {
    connector,
    assertActive: (id, number, attempt) => {
      store.assertEpoch(id, number);
      if (attempt !== submission.attempt_id || store.cancelled(attempt))
        throw new Error('inactive attempt');
    },
    reply: () => {},
    failed: (_id, error) => failures.push(error),
  });
  return {
    store,
    managed,
    session,
    submission,
    epoch,
    failures,
    async close() {
      await managed.close();
      store.close();
    },
  };
}

test('managed MCP permissions bind the reviewed call context and require the owning controller', async () => {
  const f = setup();
  const context = 'a'.repeat(64);
  try {
    await expect(
      f.managed.prepareMcp(
        f.session.id,
        f.epoch,
        f.submission.attempt_id,
        'mcp-call',
        'superlibrary/fixture-write',
        '{}',
        context,
      ),
    ).rejects.toThrow('MCP');
    let current = context;
    f.managed.options.assertMcpOperation = (op) => {
      if (op.target_version !== current) throw Error('MCP assignment changed');
    };
    const { operation, approval } = await f.managed.prepareMcp(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'mcp-call',
      'superlibrary/fixture-write',
      '{}',
      context,
    );
    expect(operation).toMatchObject({ kind: 'mcp', replay: 'opaque', target_version: context });
    expect(f.managed.takePermission(operation.id)).toBe(false);
    expect(() =>
      f.managed.start(operation.id, f.session.id, f.epoch, f.submission.attempt_id),
    ).toThrow('owned');
    f.managed.decide(
      approval.id,
      'allow',
      approval.revision,
      operation.operation_digest,
      'approve',
    );
    const next = await f.managed.prepareMcp(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'preapproved-next',
      'superlibrary/other-fixture-write',
      '{}',
      context,
    );
    f.managed.decide(
      next.approval.id,
      'allow-next',
      next.approval.revision,
      next.operation.operation_digest,
      'approve',
    );
    current = 'b'.repeat(64);
    expect(() => f.managed.takePermission(operation.id)).toThrow('changed');
    expect(f.managed.operation(operation.id).state).toBe('prepared');
    await expect(
      f.managed.prepareMcp(
        f.session.id,
        f.epoch,
        f.submission.attempt_id,
        'mcp-call',
        operation.target,
        '{}',
        current,
      ),
    ).rejects.toThrow('different');
    current = context;
    expect(f.managed.takePermission(operation.id)).toBe(true);
    expect(f.managed.takePermission(operation.id)).toBe(false);
    expect(() =>
      f.managed.recordReceipt(operation.id, {
        id: 'unrelated-fixture-receipt',
        accepted: true,
        payload: {
          target: operation.target,
          value: operation.value,
          target_version: operation.target_version,
          argument_digest: operation.argument_digest,
        },
      }),
    ).toThrow('owned');
    f.managed.permissionResult(operation.id, false, {
      protocol_result: 'unknown',
      external_effect: 'unverified',
    });
    expect(f.managed.operation(operation.id).state).toBe('outcome_unknown');
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
    expect(() => f.managed.takePermission(next.operation.id)).toThrow('Unresolved');
    expect(f.managed.operation(next.operation.id).state).toBe('prepared');
    await expect(
      f.managed.prepareMcp(
        f.session.id,
        f.epoch,
        f.submission.attempt_id,
        'another-call',
        operation.target,
        '{}',
        context,
      ),
    ).rejects.toThrow('Unresolved');
  } finally {
    await f.close();
  }
});

test('a permission with no transport handoff settles only that MCP call and invalidates its approval', async () => {
  const f = setup();
  try {
    f.managed.options.assertMcpOperation = () => {};
    const { operation, approval } = await f.managed.prepareMcp(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'not-sent',
      'superlibrary/fixture-write',
      '{}',
      'a'.repeat(64),
    );
    f.managed.mcpNotSent(operation.id);
    expect(f.managed.operation(operation.id).state).toBe('failed_definite');
    expect(f.managed.approval(approval.id).state).toBe('invalidated');
    expect(f.store.hasUnknown(f.session.id)).toBe(false);
  } finally {
    await f.close();
  }
});

test('MCP call acceptance and its permission can roll back together without publishing authority', async () => {
  const f = setup();
  try {
    f.managed.options.assertMcpOperation = () => {};
    const published: unknown[] = [];
    f.store.changes.on('event', (event) => published.push(event));
    expect(() =>
      f.store.transaction(() => {
        f.managed.prepareMcpInTransaction(
          f.session.id,
          f.epoch,
          f.submission.attempt_id,
          'atomic-mcp',
          'superlibrary/fixture-write',
          '{}',
          'a'.repeat(64),
        );
        throw Error('Injected call acceptance failure');
      }),
    ).toThrow('acceptance failure');
    expect(f.store.operations(f.session.id)).toEqual([]);
    expect(f.store.approvals(f.session.id)).toEqual([]);
    expect(published).toEqual([]);
  } finally {
    await f.close();
  }
});

test('a generic MCP protocol reply cannot verify an external mutation', async () => {
  const f = setup();
  try {
    f.managed.options.assertMcpOperation = () => {};
    const { operation, approval } = await f.managed.prepareMcp(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'opaque-mcp',
      'agentpod/fixture-write',
      '{}',
      'a'.repeat(64),
    );
    f.managed.decide(
      approval.id,
      'allow-opaque',
      approval.revision,
      operation.operation_digest,
      'approve',
    );
    expect(f.managed.takePermission(operation.id)).toBe(true);
    f.managed.permissionResult(operation.id, true, {
      protocol_result: 'returned',
      external_effect: 'unverified',
    });
    expect(f.managed.operation(operation.id).state).toBe('outcome_unknown');
    expect(f.store.hasUnknown(f.session.id)).toBe(true);
  } finally {
    await f.close();
  }
});
test('before intent commit a storage failure cannot publish an approval or dispatch an effect', async () => {
  const f = setup();
  try {
    const published: unknown[] = [];
    f.store.changes.on('event', (event) => published.push(event));
    const event = f.store.event.bind(f.store);
    f.store.event = (...args) => {
      if (args[1] === 'approval.requested') throw new Error('Injected intent commit failure');
      return event(...args);
    };
    await expect(
      f.managed.prepare(
        f.session.id,
        f.epoch,
        f.submission.attempt_id,
        'tool',
        'review',
        'target',
        'value',
      ),
    ).rejects.toThrow('intent commit');
    expect(f.store.operations(f.session.id)).toHaveLength(0);
    expect(f.store.approvals(f.session.id)).toHaveLength(0);
    expect(published).toHaveLength(0);
  } finally {
    await f.close();
  }
});
test('a dispatch journal failure denies the external request and reports failed required control', async () => {
  let dispatches = 0;
  const connector: EffectConnector = {
    id: 'test',
    replay: 'lookup',
    version: async () => '1',
    dispatch: async (key, input) => {
      dispatches++;
      return { id: key, accepted: true, payload: input };
    },
  };
  const f = setup(connector);
  try {
    const { operation, approval } = await f.managed.prepare(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'tool',
      'effect',
      'target',
      'value',
    );
    f.managed.decide(
      approval.id,
      'approve',
      approval.revision,
      operation.operation_digest,
      'approve',
    );
    f.store.db.exec('PRAGMA query_only=ON');
    f.managed.start(operation.id, f.session.id, f.epoch, f.submission.attempt_id);
    await until(
      () => f.failures.length,
      (n) => n === 1,
    );
    expect(dispatches).toBe(0);
    expect(f.managed.operation(operation.id).state).toBe('prepared');
    f.store.db.exec('PRAGMA query_only=OFF');
  } finally {
    f.store.db.exec('PRAGMA query_only=OFF');
    await f.close();
  }
});
test('argument changes cannot reuse a call identity and distinct calls receive distinct service action keys', async () => {
  const f = setup();
  try {
    const one = await f.managed.prepare(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'call-one',
      'review',
      'target',
      'first',
    );
    const retry = await f.managed.prepare(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'call-one',
      'review',
      'target',
      'first',
    );
    expect(retry.operation.id).toBe(one.operation.id);
    await expect(
      f.managed.prepare(
        f.session.id,
        f.epoch,
        f.submission.attempt_id,
        'call-one',
        'review',
        'target',
        'changed',
      ),
    ).rejects.toThrow('different arguments');
    const two = await f.managed.prepare(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'call-two',
      'review',
      'target',
      'first',
    );
    expect(two.operation.action_key).not.toBe(one.operation.action_key);
    expect(() =>
      f.managed.decide(one.approval.id, 'mismatch', 1, two.operation.operation_digest, 'approve'),
    ).toThrow('bound operation');
  } finally {
    await f.close();
  }
});
test('an in-progress status lookup cannot race an operator resolution or another lookup', async () => {
  let release!: (receipt: EffectReceipt | null) => void;
  let input!: EffectInput;
  let key = '';
  const connector: EffectConnector = {
    id: 'test',
    replay: 'lookup',
    version: async () => '1',
    dispatch: async (k, body) => {
      key = k;
      input = body;
      throw new Error('lost response');
    },
    lookup: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const f = setup(connector);
  try {
    const { operation, approval } = await f.managed.prepare(
      f.session.id,
      f.epoch,
      f.submission.attempt_id,
      'tool',
      'effect',
      'target',
      'value',
    );
    f.managed.decide(approval.id, 'approve', 1, operation.operation_digest, 'approve');
    f.managed.start(operation.id, f.session.id, f.epoch, f.submission.attempt_id);
    await until(
      () => f.managed.operation(operation.id).state,
      (state) => state === 'outcome_unknown',
    );
    const lookup = f.managed.reconcile(operation.id);
    // The first lookup is intentionally held. A second lookup and resolution
    // cannot overwrite evidence while it is being collected.
    const op = f.managed.operation(operation.id);
    expect(() =>
      f.managed.resolve(
        op.id,
        'resolution',
        op.revision,
        op.operation_digest,
        'failed_definite',
        'operator evidence',
      ),
    ).toThrow('transport is active');
    await expect(f.managed.reconcile(op.id)).rejects.toThrow('still settling');
    release({ id: key, accepted: true, payload: input });
    await lookup;
    expect(f.managed.operation(op.id).state).toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('schema v2 upgrades without changing accepted request replies or completed attempts', () => {
  const dir = mkdtempSync('/tmp/sal-v2-');
  const path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    const session = store.create(dir, 'create');
    const accepted = store.accept(session.id, 'submit', session.revision, 'M3 input');
    const epoch = store.allocate(session.id, 'old');
    store.state(session.id, epoch, 'ready');
    store.claim(session.id, epoch);
    store.finish(accepted.attempt_id, 'completed', 'M3 result', null);
    store.db.exec(
      'DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; DROP TABLE job_occurrences; DROP TABLE jobs; DROP TABLE task_compactions; DROP TABLE task_grants; DROP TABLE task_restores; DROP TABLE task_mutations; DROP TABLE task_checkpoints; DROP TABLE task_completions; DROP TABLE task_checks; DROP TABLE task_reservations; DROP TABLE task_runtime; DROP TABLE task_step_attempts; DROP TABLE task_steps; DROP TABLE task_plans; DROP TABLE durable_tasks; DROP TABLE compaction_cancellations; DROP TABLE compactions; DROP TABLE task_facts; DROP TABLE task_heads; DROP TABLE session_routes; DROP TABLE usage_observations; DROP TABLE attempt_budgets; DROP TABLE child_tasks; DROP TABLE cancellations;DROP TABLE approval_dialogs;DROP TABLE approvals;DROP TABLE operations;PRAGMA user_version=2;',
    );
    store.close();
    store = new Store(path);
    expect(store.attempt(accepted.attempt_id)).toMatchObject({
      state: 'completed',
      result: 'M3 result',
    });
    expect(store.accept(session.id, 'submit', session.revision, 'M3 input')).toEqual(accepted);
    expect(store.approvals(session.id)).toEqual([]);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 21 });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a pending command cannot be overwritten with a changed decision or an unsafe request filename', () => {
  const dir = mkdtempSync('/tmp/sal-command-');
  try {
    const outbox = new Outbox(dir, randomUUID());
    const approval = randomUUID();
    const request = randomUUID();
    const binding = 'a'.repeat(64);
    const record = outbox.enqueueDecision(approval, binding, 1, 'approve', request);
    expect(outbox.enqueueDecision(approval, binding, 1, 'approve', request)).toEqual(record);
    expect(() => outbox.enqueueDecision(approval, binding, 1, 'deny', request)).toThrow(
      'different input',
    );
    expect(() => outbox.enqueueDecision(approval, binding, 1, 'approve', '../outside')).toThrow(
      'Invalid decision identity',
    );
    expect(outbox.records()).toEqual([record]);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(record.created_at);
    try {
      const first = outbox.enqueueDecision(
        approval,
        binding,
        1,
        'deny',
        'ffffffff-ffff-4fff-afff-fffffffffff1',
      );
      const second = outbox.enqueueDecision(
        approval,
        binding,
        1,
        'approve',
        '00000000-0000-4000-8000-000000000002',
      );
      expect(outbox.records().map((value) => value.request_id)).toEqual([
        record.request_id,
        first.request_id,
        second.request_id,
      ]);
    } finally {
      clock.mockRestore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
