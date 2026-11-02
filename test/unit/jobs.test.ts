import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { call } from '../../src/core/transport.js';
import { until } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { Outbox } from '../../src/tui/attach.js';
import { ROOT } from '../../src/core/config.js';

const define = async (f: Awaited<ReturnType<typeof taskFixture>>, steps = 1) => {
  const task = await f.plan(checkedPlan(steps));
  const job = f.service.jobs.create(
    task.id,
    randomUUID(),
    task.revision,
    'Checked one-shot job',
    steps,
    false,
    f.actor,
  );
  return { task, job };
};
test('a reviewed job stays idle until one logical trigger atomically admits its bounded task grant', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const { task, job } = await define(f);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    expect((await f.task()).runtime.auto_enabled).toBe(0);
    const first = f.service.jobs.trigger(job.id, 'run-job', job.revision, 'release-42', f.actor);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM job_occurrences').get()!.n).toBe(
      1,
    );
    expect((await f.task()).runtime).toMatchObject({
      auto_enabled: 1,
      remaining_steps: 1,
      auto_epoch: 1,
    });
    expect(
      f.service.jobs.trigger(job.id, 'run-job', job.revision, 'release-42', {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(first);
    expect(
      f.service.jobs.trigger(job.id, 'new-transport-id', 0, 'release-42', {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(first);
    expect(() =>
      f.service.jobs.trigger(job.id, 'changed-request', 1, 'release-43', f.actor),
    ).toThrow('one occurrence');
    expect(() => f.service.jobs.trigger(job.id, 'run-job', 1, 'changed', f.actor)).toThrow(
      'different input',
    );
    expect(f.service.jobs.occurrence(first.occurrence_id).binding_digest).toBe(job.binding_digest);
    await f.restart();
    await until(f.task, (t) => t.state === 'succeeded', 15000);
    await until(
      () => f.service.jobs.get(job.id),
      (j) => j.state === 'succeeded',
    );
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(1);
    expect(f.service.jobs.view(job.id)).toMatchObject({
      task_id: task.id,
      state: 'succeeded',
      occurrence: { id: first.occurrence_id },
    });
  } finally {
    await f.close();
  }
});
test('job acceptance storage failure rolls back its progression grant, runtime clock, request and events', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const { job } = await define(f);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER fail_job BEFORE INSERT ON job_occurrences BEGIN SELECT RAISE(ABORT,'job receipt full');END;",
    );
    expect(() => f.service.jobs.trigger(job.id, 'atomic-trigger', 1, 'once', f.actor)).toThrow(
      'receipt full',
    );
    expect((await f.task()).runtime).toMatchObject({
      auto_enabled: 0,
      remaining_steps: 0,
      auto_epoch: 0,
      started_at: null,
    });
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM job_occurrences').get()!.n).toBe(
      0,
    );
    expect(
      f.service.store.events(f.session.id, 0).filter((e) => e.kind === 'job.triggered'),
    ).toHaveLength(0);
    expect(
      f.service.store.db.prepare("SELECT 1 FROM requests WHERE id='atomic-trigger'").get(),
    ).toBeUndefined();
    f.service.store.db.exec('DROP TRIGGER fail_job');
    f.service.jobs.trigger(job.id, 'atomic-trigger', 1, 'once', f.actor);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM job_occurrences').get()!.n).toBe(
      1,
    );
  } finally {
    await f.close();
  }
});
test('job authority cannot survive a changed plan, workspace, executor or provider route before trigger', async () => {
  for (const change of ['plan', 'workspace', 'executor', 'provider']) {
    const f = await taskFixture();
    try {
      await f.service.taskDriver.close();
      const { job } = await define(f);
      if (change === 'plan')
        await f.action('revise', { plan: { ...checkedPlan(), objective: 'Corrected objective' } });
      if (change === 'workspace')
        writeFileSync(
          join(f.service.workspaces.get(f.session.id).root, 'app.js'),
          'human changed target\n',
        );
      if (change === 'executor') f.backend.profileDigest = 'another-profile';
      if (change === 'provider') f.service.supervisor.route.max_tokens++;
      expect(() =>
        f.service.jobs.trigger(job.id, randomUUID(), job.revision, 'once', f.actor),
      ).toThrow();
      expect((await f.task()).runtime.auto_enabled).toBe(0);
      expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
      expect(f.service.store.db.prepare('SELECT count(*) AS n FROM job_occurrences').get()!.n).toBe(
        0,
      );
    } finally {
      await f.close();
    }
  }
});
test('job trigger payloads cannot replace the reviewed instruction, task or workspace', async () => {
  const f = await taskFixture();
  try {
    const { job } = await define(f);
    await expect(
      call(f.service.socket, `/v1/jobs/${job.id}/run`, {
        ...f.actor,
        request_id: 'bad-metadata',
        expected_revision: job.revision,
        occurrence_key: 'once',
        instruction: 'Do something else',
        cwd: '/different-target',
      }),
    ).rejects.toThrow('Unexpected job field');
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    const health = await call<any>(f.service.socket, '/v1/health');
    expect(health.job_execution).toMatchObject({
      durable_jobs: true,
      one_shot_triggers: true,
      recurring_schedules: true,
    });
  } finally {
    await f.close();
  }
});
test('a lost TUI job-trigger response survives reconnect and controller replacement without duplicate work', async () => {
  const f = await taskFixture();
  let client: OperatorClient | undefined;
  try {
    const { job } = await define(f);
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    const trigger = f.service.jobs.trigger.bind(f.service.jobs);
    let drop = true;
    f.service.jobs.trigger = (...args) => {
      const accepted = trigger(...args);
      if (drop) {
        drop = false;
        throw Error('Lost job response');
      }
      return accepted;
    };
    await expect(client.jobAction('run', { occurrence_key: 'tui-once' })).rejects.toThrow();
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(1);
    await client.close();
    client = new OperatorClient(f.state);
    await client.open(f.session.id, { takeover: true });
    expect(new Outbox(f.state, f.session.id).records()).toHaveLength(0);
    await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(1);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM job_occurrences').get()!.n).toBe(
      1,
    );
    expect(client.snapshot?.job?.id).toBe(job.id);
  } finally {
    await client?.close();
    await f.close();
  }
});
test('cancelled jobs revoke active work and do not grant an operation-bound approval', async () => {
  const f = await taskFixture();
  try {
    const plan = checkedPlan();
    plan.steps[0]!.instruction = '[review] job-review';
    const task = await f.plan(plan);
    const job = f.service.jobs.create(
      task.id,
      'create-job',
      task.revision,
      'Wait for person',
      1,
      false,
      f.actor,
    );
    f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    const pending = await until(
      () => f.service.managed.pending(),
      (a) => a.length === 1,
    );
    await until(
      () => f.service.jobs.get(job.id),
      (j) => j.state === 'waiting_for_person',
    );
    expect(pending[0]!.decision).toBeNull();
    const current = f.service.jobs.get(job.id);
    await f.service.jobs.cancel(job.id, 'cancel-job', current.revision, f.actor);
    await until(
      () => f.service.store.snapshot(f.session.id),
      (s) => s.attempts.every((a) => !['accepted', 'dispatching', 'running'].includes(a.state)),
    );
    expect((await f.task()).state).toBe('cancelled');
    expect(f.service.jobs.get(job.id).state).toBe('cancelled');
    expect(f.service.managed.approval(pending[0]!.id).decision).not.toBe('approve');
    await f.restart();
    expect(f.service.jobs.get(job.id).state).toBe('cancelled');
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('a model completing its attempt cannot complete a job whose configured check fails', async () => {
  const f = await taskFixture();
  try {
    f.backend.exitOverride = 1;
    const { job } = await define(f);
    // Hold progression at the model/check boundary, independent of timer ordering.
    let paused: Promise<void> | undefined;
    const pauseAfterDispatch = (event: { kind: string }) => {
      if (event.kind !== 'attempt.running') return;
      f.service.store.changes.off('event', pauseAfterDispatch);
      paused = f.service.taskDriver.close();
    };
    f.service.store.changes.on('event', pauseAfterDispatch);
    f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    await until(
      () => f.service.store.snapshot(f.session.id).attempts,
      (attempts) => attempts[0]?.state === 'completed',
    );
    await paused;
    await until(
      () => f.service.jobs.view(job.id),
      (j) => j.state === 'blocked' && j.task_state === 'blocked',
    );
    expect(f.service.taskVerification.list(job.task_id)).toEqual([]);
    f.service.taskDriver.start();
    await until(
      () => f.service.taskVerification.list(job.task_id),
      (checks) => checks.some((check) => check.state === 'failed'),
    );
    const result = await until(
      () => f.service.jobs.view(job.id),
      (j) =>
        ['blocked', 'partially_completed'].includes(j.state) &&
        ['blocked', 'partially_completed'].includes(j.task_state) &&
        f.service.taskDriver.view(job.task_id).runtime.auto_enabled === 0,
      15000,
    );
    expect(result.state).not.toBe('succeeded');
    expect(result.task_state).not.toBe('succeeded');
    expect(f.service.store.snapshot(f.session.id).attempts[0]!.state).toBe('completed');
    expect(f.service.taskVerification.list(job.task_id)).toMatchObject([{ state: 'failed' }]);
  } finally {
    await f.close();
  }
});
test('job cancellation recording failure leaves both the task grant and occurrence live until a durable cancellation succeeds', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    // Isolate rollback from background projection revisions as well as task progression.
    f.service.jobs.close();
    const { job } = await define(f);
    f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    const before = f.service.jobs.get(job.id);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER fail_cancel BEFORE UPDATE ON jobs WHEN NEW.state='cancelled' BEGIN SELECT RAISE(ABORT,'cancel full');END;",
    );
    await expect(
      f.service.jobs.cancel(job.id, 'cancel-once', before.revision, f.actor),
    ).rejects.toThrow('cancel full');
    expect(f.service.jobs.get(job.id)).toEqual(before);
    expect((await f.task()).state).toBe('accepted');
    expect((await f.task()).runtime.auto_enabled).toBe(1);
    f.service.store.db.exec('DROP TRIGGER fail_cancel');
    await f.service.jobs.cancel(job.id, 'cancel-once', before.revision, f.actor);
    expect((await f.task()).state).toBe('cancelled');
    expect(f.service.jobs.view(job.id).occurrence?.state).toBe('cancelled');
  } finally {
    await f.close();
  }
});

test('a later task correction cannot silently retarget an admitted job to a new plan', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const { job } = await define(f);
    const accepted = f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    await f.action('revise', { plan: { ...checkedPlan(), objective: 'A new reviewed objective' } });
    f.service.jobs.reconcile();
    const result = f.service.jobs.view(job.id);
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('scope changed');
    expect(result.binding_digest).toBe(job.binding_digest);
    expect(result.occurrence?.id).toBe(accepted.occurrence_id);
    expect(
      f.service.jobs.trigger(job.id, 'transport-retry', 0, 'once', {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(accepted);
    expect((await f.task()).runtime.auto_enabled).toBe(0);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('required job projection failure invalidates readiness before another model grant', async () => {
  const f = await taskFixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  try {
    const { job } = await define(f);
    f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    f.service.store.db
      .prepare(
        "UPDATE job_occurrences SET state='projection-needs-refresh',reason='fault injection' WHERE job_id=?",
      )
      .run(job.id);
    f.service.store.db.exec(
      "CREATE TEMP TRIGGER fail_job_projection BEFORE UPDATE ON job_occurrences BEGIN SELECT RAISE(ABORT,'job projection full');END;",
    );
    await until(
      () => f.service.supervisor.inspect(f.session.id),
      (s) => s.state !== 'ready',
    );
    const charged = (await f.task()).runtime.requests_spent;
    writeFileSync(join(f.source, 'release-probe'), 'release');
    await until(
      () => f.service.store.snapshot(f.session.id),
      (s) => s.attempts.every((a) => !['accepted', 'dispatching', 'running'].includes(a.state)),
    );
    expect((await f.task()).runtime.requests_spent).toBe(charged);
    expect((await f.task()).state).not.toBe('succeeded');
    f.service.store.db.exec('DROP TRIGGER fail_job_projection');
    f.service.jobs.reconcile();
    expect(f.service.jobs.get(job.id).state).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('a connector change after job acceptance fences the already queued grant before any model request', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const { job } = await define(f);
    f.service.jobs.trigger(job.id, 'run-job', job.revision, 'once', f.actor);
    Object.assign(f.service.managed.options, { connector: { id: 'different-connector' } });
    f.service.taskDriver.start();
    await until(f.task, (t) => !t.runtime.auto_enabled);
    expect((await f.task()).runtime.requests_spent).toBe(0);
    expect(f.service.store.snapshot(f.session.id).attempts).toHaveLength(0);
    f.service.jobs.reconcile();
    expect(f.service.jobs.get(job.id).state).toBe('blocked');
  } finally {
    await f.close();
  }
});
