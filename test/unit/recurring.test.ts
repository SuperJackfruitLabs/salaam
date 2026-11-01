import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until } from '../helpers.js';
import { RecurringWork } from '../../src/tasks/recurring-work.js';
import { call } from '../../src/core/transport.js';
const define = async (
  f: Awaited<ReturnType<typeof taskFixture>>,
  def: unknown = null,
  uncapped = false,
) => {
  const t = await f.plan({
    ...checkedPlan(),
    ...(uncapped ? { limits: { token_units: null } } : {}),
  });
  return f.service.recurring.create(
    t.id,
    randomUUID(),
    t.revision,
    'Recurring checked fixture',
    1,
    false,
    def,
    f.actor,
  );
};
test.each([false, true])(
  'recurring templates preserve limits and deduplication across restart (token budget disabled: %s)',
  async (uncapped) => {
    const f = await taskFixture();
    try {
      f.service.recurring.close();
      await f.service.taskDriver.close();
      const job = await define(f, null, uncapped),
        r = f.service.recurring.trigger(job.id, 'trigger', 1, 'first', f.actor);
      expect(
        f.service.recurring.trigger(job.id, 'retry', 0, 'first', {
          client_id: 'expired',
          token: 'expired',
        }),
      ).toEqual(r);
      expect(() => f.service.recurring.trigger(job.id, 'overlap', 1, 'second', f.actor)).toThrow(
        'settlement',
      );
      writeFileSync(
        join(f.service.workspaces.get(f.session.id).root, 'app.js'),
        'changed reviewed source after definition',
      );
      await f.restart();
      await until(
        () => f.service.recurring.occurrences(job.id).occurrences[0],
        (r) => !!r?.job_run_id,
      );
      const first = f.service.recurring.occurrences(job.id).occurrences[0]!;
      await until(
        () => f.service.jobs.view(first.job_run_id!),
        (j) => j.state === 'succeeded',
        20000,
      );
      expect(
        f.service.workspaces.read(first.session_id, { action: 'read', path: 'app.js' }),
      ).toMatchObject({
        lines: expect.arrayContaining([{ line: 1, text: 'export const answer = 42;' }]),
      });
      expect(f.service.store.snapshot(first.session_id).attempts).toHaveLength(1);
      expect(f.service.taskWork.forSession(first.session_id)!.limits.token_units).toBe(
        uncapped ? null : 16777216,
      );
      const second = f.service.recurring.trigger(job.id, 'second', 1, 'second', f.actor);
      expect(second.session_id).not.toBe(first.session_id);
      await until(
        () => f.service.recurring.occurrences(job.id).occurrences[0],
        (r) => !!r?.job_run_id,
      );
      const run = f.service.recurring.occurrences(job.id).occurrences[0]!;
      await until(
        () => f.service.jobs.view(run.job_run_id!),
        (j) => j.state === 'succeeded',
        20000,
      );
      expect(f.service.jobs.get(run.job_run_id!).task_id).not.toBe(
        f.service.jobs.get(first.job_run_id!).task_id,
      );
      expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);
test('schedule cursor, bounded missed slots and overlap receipts survive restart and revisions never widen templates', async () => {
  const f = await taskFixture();
  try {
    f.service.recurring.close();
    await f.service.taskDriver.close();
    let now = 10000;
    const scheduler = new RecurringWork(f.service.jobs, () => now),
      task = await f.plan();
    const def = {
      kind: 'interval',
      anchor: 0,
      every_ms: 1000,
      missed: 'catch_up',
      max_catch_up: 2,
    };
    const job = scheduler.create(
      task.id,
      'create-recurring',
      task.revision,
      'Clock fixture',
      1,
      false,
      def,
      f.actor,
    );
    now = 10000000;
    scheduler.tick();
    expect(scheduler.occurrences(job.id).occurrences).toHaveLength(1);
    const next = scheduler.get(job.id).next_due;
    expect(next).toBe(10001000);
    scheduler.tick();
    expect(scheduler.occurrences(job.id).occurrences).toHaveLength(1);
    expect(
      f.service.store.events(f.session.id, 0).filter((e) => e.kind === 'schedule.skipped'),
    ).toHaveLength(2);
    const digest = job.template_digest;
    const paused = scheduler.update(job.id, 'pause', 1, def, 'paused', f.actor);
    expect(paused.template_digest).toBe(digest);
    expect(() => scheduler.update(job.id, 'stale', 1, def, 'active', f.actor)).toThrow('revision');
    await expect(
      call(f.service.socket, `/v1/schedules/${job.id}/run`, {
        ...f.actor,
        request_id: 'metadata',
        expected_revision: paused.revision,
        occurrence_key: 'untrusted',
        instruction: 'widen',
      }),
    ).rejects.toThrow('Unexpected');
    const cancelled = scheduler.update(
      job.id,
      'cancel',
      paused.revision,
      def,
      'cancelled',
      f.actor,
    );
    expect(cancelled.state).toBe('cancelled');
    await scheduler.recover();
    expect(
      f.service.jobs.get(scheduler.occurrences(job.id).occurrences[0]!.job_run_id!).state,
    ).toBe('cancelled');
    await f.restart();
    expect(f.service.recurring.get(job.id).state).toBe('cancelled');
  } finally {
    await f.close();
  }
});
test('reservation or admission storage failure cannot leave a model grant; interrupted provisioning resumes only the same session', async () => {
  const f = await taskFixture();
  try {
    f.service.recurring.close();
    await f.service.taskDriver.close();
    const job = await define(f);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER full_reservation BEFORE INSERT ON recurring_occurrences BEGIN SELECT RAISE(ABORT,'disk full');END;",
    );
    const count = f.service.store.sessions().length;
    expect(() => f.service.recurring.trigger(job.id, 'durable', 1, 'once', f.actor)).toThrow(
      'disk full',
    );
    expect(f.service.store.sessions()).toHaveLength(count);
    f.service.store.db.exec('DROP TRIGGER full_reservation');
    const r = f.service.recurring.trigger(job.id, 'durable', 1, 'once', f.actor);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER full_admission BEFORE UPDATE ON recurring_occurrences WHEN NEW.job_run_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'admission full');END;",
    );
    expect(() => f.service.recurring.provision(r.id)).toThrow('admission full');
    expect(f.service.taskWork.forSession(r.session_id)).toBeNull();
    expect(f.service.store.snapshot(r.session_id).attempts).toHaveLength(0);
    f.service.store.db.exec('DROP TRIGGER full_admission');
    await f.restart();
    const occurrence = await until(
      () => f.service.recurring.occurrences(job.id).occurrences[0],
      (r) => !!r?.job_run_id,
    );
    expect(occurrence!.id).toBe(r.id);
    expect(occurrence!.session_id).toBe(r.session_id);
    await until(
      () => f.service.jobs.get(occurrence!.job_run_id!),
      (j) => j.state === 'succeeded',
      20000,
    );
    expect(f.service.store.snapshot(r.session_id).attempts).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('changed execution scope blocks accepted reservation before any task or model admission', async () => {
  const f = await taskFixture();
  try {
    f.service.recurring.close();
    const job = await define(f),
      r = f.service.recurring.trigger(job.id, 'trigger', 1, 'once', f.actor);
    f.backend.profileDigest = 'changed';
    f.service.recurring.tick();
    expect(f.service.recurring.occurrences(job.id).occurrences[0]).toMatchObject({
      state: 'waiting_for_infrastructure',
    });
    expect(f.service.taskWork.forSession(r.session_id)).toBeNull();
    expect(f.service.store.snapshot(r.session_id).attempts).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a recurring trigger lost reply stays in the TUI outbox and a replacement controller recovers the same reservation', async () => {
  const f = await taskFixture();
  const { OperatorClient } = await import('../../src/tui/client.js');
  const { Outbox } = await import('../../src/tui/attach.js');
  let client: InstanceType<typeof OperatorClient> | undefined;
  try {
    const job = await define(f);
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    const trigger = f.service.recurring.trigger.bind(f.service.recurring);
    let drop = true;
    f.service.recurring.trigger = (...args) => {
      const r = trigger(...args);
      if (drop) {
        drop = false;
        throw Error('Lost recurring response');
      }
      return r;
    };
    await expect(
      client.scheduleAction('run', { occurrence_key: 'lost-reply' }, { id: job.id, revision: 1 }),
    ).rejects.toThrow();
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(1);
    await client.close();
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(0);
    const r = await until(
      () => f.service.recurring.occurrences(job.id).occurrences[0],
      (r) => !!r?.job_run_id,
    );
    await until(
      () => f.service.jobs.get(r!.job_run_id!),
      (j) => j.state === 'succeeded',
      15000,
    );
    expect(f.service.recurring.occurrences(job.id).occurrences).toHaveLength(1);
    expect(f.service.store.snapshot(r!.session_id).attempts).toHaveLength(1);
  } finally {
    await client?.close();
    await f.close();
  }
});
