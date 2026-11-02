import { expect, test } from 'vitest';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until } from '../helpers.js';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { OperatorClient } from '../../src/tui/client.js';
import { Outbox } from '../../src/tui/attach.js';

test('runtime expiry aborts an active step and leaves a durable limit reason without starting another step', async () => {
  const f = await taskFixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  try {
    await f.plan({ ...checkedPlan(2), limits: { runtime_ms: 2500 } });
    await f.action('auto', { max_steps: 2 });
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    const t = await until(f.task, (t) => !!t.runtime.blocked_reason, 10000);
    expect(t.runtime.blocked_reason).toContain('runtime');
    expect(t.steps[1]!.attempt_id).toBeNull();
    await until(
      () => f.service.store.snapshot(f.session.id),
      (s) => s.attempts.every((a) => !['dispatching', 'running'].includes(a.state)),
    );
    await f.restart();
    expect((await f.task()).runtime.blocked_reason).toContain('runtime');
    expect((await f.task()).state).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('real read-only child turns share the task request ledger and release only unused completed reservations', async () => {
  const f = await taskFixture();
  try {
    const plan = { ...checkedPlan(), limits: { requests: 4 } };
    plan.steps[0]!.instruction = '[children] inspect';
    await f.plan(plan);
    await f.action('auto', { max_steps: 1 });
    const result = await until(
      f.task,
      (t) => t.state === 'succeeded' || !t.runtime.auto_enabled,
      15000,
    );
    expect(result.state, JSON.stringify(result.runtime)).toBe('succeeded');
    expect(result.runtime.requests_spent).toBe(4);
    expect(result.runtime.reserved_requests).toBe(0);
    expect(f.service.children.list(f.session.id)).toMatchObject([{ state: 'completed' }]);
  } finally {
    await f.close();
  }
});

test('verification runs consume their declared task budget before a command can be admitted', async () => {
  const f = await taskFixture();
  try {
    await f.plan({ ...checkedPlan(), limits: { verification_runs: 1 } });
    await f.action('auto', { max_steps: 1 });
    const result = await until(f.task, (t) => !!t.runtime.blocked_reason, 10000);
    expect(result.runtime.blocked_reason).toContain('verification run limit');
    expect(result.runtime.verification_runs).toBe(1);
    expect(f.backend.runs.size).toBe(1);
    expect(result.state).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('completion recording failure rolls back success and its event; the same logical request can later commit once', async () => {
  const f = await taskFixture();
  try {
    await f.plan();
    await f.run();
    await f.settled();
    await f.review();
    await f.verify();
    const t = await f.task(),
      body = { ...f.actor, request_id: 'finish-once', expected_revision: t.revision };
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER fail_task_completion BEFORE INSERT ON task_completions BEGIN SELECT RAISE(ABORT,'injected task receipt failure');END;",
    );
    await expect(call(f.service.socket, `/v1/tasks/${t.id}/finish`, body)).rejects.toThrow(
      'Service operation failed',
    );
    expect((await f.task()).state).not.toBe('succeeded');
    expect(
      f.service.store.events(f.session.id, 0).filter((e) => e.kind === 'work_task.succeeded'),
    ).toHaveLength(0);
    f.service.store.db.exec('DROP TRIGGER fail_task_completion');
    expect((await call<any>(f.service.socket, `/v1/tasks/${t.id}/finish`, body)).state).toBe(
      'succeeded',
    );
    await call(f.service.socket, `/v1/tasks/${t.id}/finish`, body);
    expect(
      f.service.store.events(f.session.id, 0).filter((e) => e.kind === 'work_task.succeeded'),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('bounded progression never supplies a human approval and shows the waiting state until an operator decides', async () => {
  const f = await taskFixture();
  try {
    const plan = checkedPlan();
    plan.steps[0]!.instruction = '[review] task-review';
    await f.plan(plan);
    await f.action('auto', { max_steps: 1 });
    const pending = await until(
      () => f.service.managed.pending(),
      (a) => a.length === 1,
    );
    expect((await f.task()).state).toBe('waiting_for_person');
    expect(pending[0]!.decision).toBeNull();
    const approval = pending[0]!;
    await call(f.service.socket, `/v1/approvals/${approval.id}/decision`, {
      request_id: randomUUID(),
      expected_revision: approval.revision,
      operation_digest: approval.operation_digest,
      decision: 'approve',
    });
    const complete = await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(complete.runtime.auto_enabled).toBe(0);
  } finally {
    await f.close();
  }
});

test('a lost TUI progression response survives a fresh controller/outbox without duplicating attempts or checks', async () => {
  const f = await taskFixture();
  let client: OperatorClient | undefined;
  try {
    await f.plan();
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    const configure = f.service.taskDriver.configure.bind(f.service.taskDriver);
    let drop = true;
    f.service.taskDriver.configure = (...args) => {
      const result = configure(...args);
      if (drop) {
        drop = false;
        throw Error('Lost progression response');
      }
      return result;
    };
    await expect(client.taskAction('auto', { max_steps: 1, compact: false })).rejects.toThrow();
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(1);
    await client.close();
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(0);
    await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(1);
    expect(f.backend.runs.size).toBe(2);
  } finally {
    await client?.close();
    await f.close();
  }
});

test('pausing revokes a prepared grant; a new bounded epoch resumes without resetting budget or repeating a step', async () => {
  const f = await taskFixture();
  try {
    await f.plan(checkedPlan(2));
    let held = true;
    const advance = f.service.taskWork.advance.bind(f.service.taskWork);
    f.service.taskWork.advance = (id) => (held ? undefined : advance(id));
    await f.action('auto', { max_steps: 2 });
    const grant = await until(
      () =>
        f.service.store.db.prepare("SELECT id FROM task_grants WHERE state='prepared'").get() as
          { id: string } | undefined,
      Boolean,
    );
    await f.action('auto', { max_steps: 0 });
    held = false;
    await f.action('auto', { max_steps: 2 });
    await expect(Promise.resolve().then(() => advance(grant!.id))).rejects.toThrow('epoch changed');
    const completed = await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(completed.runtime.requests_spent).toBe(4);
    expect(completed.runtime.auto_epoch).toBe(3);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(2);
    expect(
      f.service.store.db.prepare("SELECT count(*) n FROM task_grants WHERE state='accepted'").get(),
    ).toMatchObject({ n: 2 });
  } finally {
    await f.close();
  }
});
