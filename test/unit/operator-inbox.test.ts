import { expect, test } from 'vitest';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until } from '../helpers.js';
import { call } from '../../src/core/transport.js';
import { client } from '../acp-helpers.js';
import { acquireControl } from '../../src/tui/attach.js';
test('shared inbox survives restart and acknowledgement never decides approval; changed revisions reopen attention', async () => {
  const f = await taskFixture();
  try {
    const plan = checkedPlan();
    plan.steps[0]!.instruction = '[review] inbox-review';
    const task = await f.plan(plan);
    f.service.taskDriver.configure(task.id, 'auto', task.revision, 1, false, f.actor);
    const approvals = await until(
      () => f.service.managed.pending(),
      (a) => a.length === 1,
    );
    f.service.inbox.reconcile();
    const entry = f.service.inbox.list().items.find((i) => i.kind === 'approval')!;
    expect(entry).toBeDefined();
    await call(f.service.socket, `/v1/inbox/${entry.id}/ack`, {
      ...f.actor,
      request_id: 'ack',
      expected_revision: entry.revision,
    });
    expect(f.service.managed.approval(approvals[0]!.id).decision).toBeNull();
    expect(f.service.inbox.list().items.some((i) => i.id === entry.id)).toBe(false);
    const otherLease = await acquireControl(
        f.service.socket,
        f.session.id,
        'second-operator',
        true,
      ),
      other = { client_id: 'second-operator', token: otherLease.token };
    expect(f.service.inbox.get(entry.id).ack_revision).toBe(entry.revision);
    f.service.store.transaction(() => {
      f.service.store.db
        .prepare('UPDATE approvals SET expires_at=0 WHERE id=?')
        .run(approvals[0]!.id);
      f.service.store.event(f.session.id, 'fixture.expired', {});
    });
    f.service.inbox.reconcile();
    const changed = f.service.inbox.get(entry.id);
    expect(changed.kind).toBe('approval_expired');
    expect(changed.revision).toBeGreaterThan(entry.revision);
    expect(() => f.service.inbox.ack(entry.id, 'stale', entry.revision, other)).toThrow('changed');
    await f.restart();
    expect(f.service.inbox.get(entry.id).id).toBe(entry.id);
    expect(f.service.managed.approval(approvals[0]!.id).decision).not.toBe('approve');
  } finally {
    await f.close();
  }
});
test('inbox write failure rolls back acknowledgement and required attention failure denies job admission', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const task = await f.plan(),
      job = f.service.jobs.create(task.id, 'job', task.revision, 'Checked', 1, false, f.actor);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER fail_inbox BEFORE INSERT ON operator_inbox BEGIN SELECT RAISE(ABORT,'inbox full');END;",
    );
    f.service.store.transaction(() => {
      f.service.store.db
        .prepare("UPDATE sessions SET error='host unavailable' WHERE id=?")
        .run(f.session.id);
      f.service.store.event(f.session.id, 'fixture.host_down', {});
    });
    await until(() => f.service.inbox.controlError, Boolean);
    expect(() => f.service.jobs.trigger(job.id, 'run', 1, 'once', f.actor)).toThrow('inbox');
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    f.service.store.db.exec('DROP TRIGGER fail_inbox');
    await f.restart();
    f.service.store.transaction(() => {
      f.service.store.db
        .prepare("UPDATE sessions SET error='still unavailable' WHERE id=?")
        .run(f.session.id);
      f.service.store.event(f.session.id, 'fixture.unavailable', {});
    });
    f.service.inbox.reconcile();
    const entry = f.service.inbox.list().items.find((i) => i.kind === 'infrastructure')!;
    expect(entry).toBeDefined();
    if (entry) {
      f.service.store.db.exec(
        "CREATE TEMP TRIGGER fail_ack BEFORE UPDATE ON operator_inbox BEGIN SELECT RAISE(ABORT,'ack full');END;",
      );
      expect(() => f.service.inbox.ack(entry.id, 'ack', entry.revision, f.actor)).toThrow(
        'ack full',
      );
      expect(f.service.inbox.get(entry.id).ack_revision).toBe(0);
      f.service.store.db.exec('DROP TRIGGER fail_ack');
    }
  } finally {
    await f.close();
  }
});

test('CLI and ACP inspect the same persisted inbox and ACP acknowledgement needs the source session controller', async () => {
  const f = await taskFixture();
  const a = client(f.state);
  try {
    await f.service.taskDriver.close();
    const task = await f.plan();
    f.service.store.transaction(() => {
      f.service.store.db
        .prepare("UPDATE durable_tasks SET state='blocked',reason='Review required' WHERE id=?")
        .run(task.id);
      f.service.store.event(f.session.id, 'fixture.blocked', {});
    });
    f.service.inbox.reconcile();
    const entry = f.service.inbox.list().items[0]!;
    await a.initialize();
    const list = await a.request('_salaam/inbox/list');
    expect(list.items[0].id).toBe(entry.id);
    await expect(
      a.request('_salaam/inbox/ack', {
        id: entry.id,
        request_id: 'ack-acp',
        expected_revision: entry.revision,
      }),
    ).rejects.toThrow('Connect');
    const view = f.service.store.controlView(f.session.id);
    f.service.store.control(
      f.session.id,
      'release-to-acp',
      f.actor.client_id,
      'release',
      view.epoch,
      f.actor.token,
    );
    await a.request('session/load', { sessionId: f.session.id, cwd: f.source, mcpServers: [] });
    await a.request('_salaam/inbox/ack', {
      id: entry.id,
      request_id: 'ack-acp',
      expected_revision: entry.revision,
    });
    expect(f.service.inbox.get(entry.id).ack_revision).toBe(entry.revision);
  } finally {
    await a.close();
    await f.close();
  }
});
