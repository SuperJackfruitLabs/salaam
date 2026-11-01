import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { acquireControl } from '../../src/tui/attach.js';
import { until } from '../helpers.js';
import { checkedPlan } from '../task-helpers.js';
import type { Controller, Session } from '../../src/core/protocol.js';
import type { JobAcceptance } from '../../src/tasks/job-work.js';
import type { Job } from '../../src/core/records.js';
async function fixture(mode: string) {
  const dir = mkdtempSync('/tmp/sal-job-proof-'),
    source = join(dir, 'source'),
    state = join(dir, 'state'),
    socket = join(state, 'operator.sock');
  mkdirSync(source);
  writeFileSync(join(source, 'app.js'), 'fixture deliverable\n');
  let child: ChildProcess,
    stderr = '';
  const boot = async (mode: string) => {
    child = spawn(process.execPath, [join(ROOT, 'test/fixtures/job-service.mjs'), dir, mode], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr!.on('data', (v) => (stderr = (stderr + v).slice(-16000)));
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw Error('Job service failed: ' + stderr);
      }),
    ]);
  };
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  };
  await boot(mode);
  const session = await call<Session>(socket, '/v1/sessions', {
    request_id: 'session',
    cwd: source,
    coding: true,
  });
  await until(
    () => call<Session>(socket, `/v1/sessions/${session.id}`),
    (s) => s.state === 'ready',
  );
  let actor: Controller;
  const acquire = async () => {
    const client_id = 'proof-' + Date.now(),
      lease = await acquireControl(socket, session.id, client_id, true);
    actor = { client_id, token: lease.token };
  };
  await acquire();
  const task = await call<any>(socket, '/v1/tasks', {
    ...actor!,
    request_id: 'task',
    session_id: session.id,
    expected_revision: 0,
    plan: checkedPlan(),
  });
  const job = await call<Job>(socket, '/v1/jobs', {
    ...actor!,
    request_id: 'job',
    task_id: task.id,
    expected_revision: task.revision,
    name: 'Durable one-shot proof',
    max_steps: 1,
    compact: false,
  });
  return {
    dir,
    source,
    state,
    socket,
    session,
    task,
    job,
    get actor() {
      return actor;
    },
    trigger: () =>
      call<JobAcceptance>(socket, `/v1/jobs/${job.id}/run`, {
        ...actor,
        request_id: 'trigger',
        expected_revision: job.revision,
        occurrence_key: 'one-release',
      }),
    get: () => call<any>(socket, `/v1/jobs/${job.id}`),
    async restart() {
      await kill();
      await boot('replacement');
      await acquire();
    },
    async close() {
      await kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('SIGKILL before occurrence commit rolls back the task grant and leaves no work to replay', async () => {
  const f = await fixture('before-commit');
  try {
    const lost = f.trigger().catch(() => null);
    await until(() => existsSync(join(f.dir, 'before-job-commit')), Boolean);
    await f.restart();
    await lost;
    let view = await f.get();
    expect(view.state).toBe('ready');
    expect(view.occurrence).toBeNull();
    const snapshot = await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`);
    expect(snapshot.attempts).toHaveLength(0);
    expect(snapshot.work_task.runtime).toMatchObject({
      auto_enabled: 0,
      auto_epoch: 0,
      started_at: null,
    });
    const accepted = await f.trigger();
    view = await until(f.get, (j) => j.state === 'succeeded', 15000);
    expect(view.occurrence.id).toBe(accepted.occurrence_id);
    expect(
      (await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`)).attempts,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('SIGKILL after occurrence commit and a lost response recovers one task, grant and occurrence with no duplicate instruction', async () => {
  const f = await fixture('after-commit');
  try {
    const lost = f.trigger().catch(() => null);
    await until(() => existsSync(join(f.dir, 'after-job-commit')), Boolean);
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'), { readOnly: true });
    const row = db.prepare('SELECT id FROM job_occurrences').get()!;
    expect(db.prepare('SELECT count(*) AS n FROM attempts').get()!.n).toBe(0);
    db.close();
    await f.restart();
    await lost;
    const accepted = await f.trigger();
    expect(accepted.occurrence_id).toBe(row.id);
    const view = await until(f.get, (j) => j.state === 'succeeded', 15000);
    expect(view.task_id).toBe(f.task.id);
    expect(view.occurrence.id).toBe(row.id);
    const snap = await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`);
    expect(snap.attempts).toHaveLength(1);
    expect(snap.work_task.runtime.auto_epoch).toBe(1);
    expect(snap.work_task.steps[0].attempt_id).toBe(snap.attempts[0].id);
    const launches = readFileSync(join(f.dir, 'executor-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.phase === 'launch');
    expect(launches).toHaveLength(2);
    expect(new Set(launches.map((e) => e.run)).size).toBe(2);
    const cli = JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [join(ROOT, 'bin/salaam.mjs'), 'jobs', 'inspect', f.job.id, '--state', f.state],
          { cwd: f.source },
        )
      ).stdout,
    );
    expect(cli.occurrence.id).toBe(row.id);
    expect(cli.task_state).toBe('succeeded');
  } finally {
    await f.close();
  }
});
test('daemon death during a job keeps the dispatched attempt interrupted and never turns a trigger retry into new work', async () => {
  const f = await fixture('active');
  try {
    const accepted = await f.trigger();
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    const before = await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`);
    await f.restart();
    const retried = await f.trigger();
    expect(retried).toEqual(accepted);
    const view = await until(
      f.get,
      (j) => j.task_state === 'blocked' || j.task_state === 'partially_completed',
    );
    expect(view.occurrence.id).toBe(accepted.occurrence_id);
    const after = await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`);
    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].id).toBe(before.attempts[0].id);
    expect(after.attempts[0].state).toBe('interrupted');
    expect(after.work_task.runtime.auto_enabled).toBe(0);
  } finally {
    await f.close();
  }
});

test('a job cancellation committed before process abort survives daemon death without restoring its grant', async () => {
  const f = await fixture('cancel-committed');
  try {
    const accepted = await f.trigger();
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    // The tool is held, but the job's periodic projection may still be catching up.
    // Cancel the settled running revision so this proof reaches the crash boundary.
    const before = await until(
      f.get,
      (job) => job.state === 'running' && job.reason === job.task_reason,
    );
    const request = { ...f.actor, request_id: 'cancel-once', expected_revision: before.revision };
    const lost = call(f.socket, `/v1/jobs/${f.job.id}/cancel`, request).catch(() => null);
    await until(() => existsSync(join(f.dir, 'after-cancel-commit')), Boolean);
    await f.restart();
    await lost;
    const recovered = await f.get();
    expect(recovered.state).toBe('cancelled');
    expect(recovered.occurrence.id).toBe(accepted.occurrence_id);
    await call(f.socket, `/v1/jobs/${f.job.id}/cancel`, { ...request, ...f.actor });
    const snapshot = await call<any>(f.socket, `/v1/sessions/${f.session.id}/snapshot`);
    expect(snapshot.work_task.state).toBe('cancelled');
    expect(snapshot.work_task.runtime.auto_enabled).toBe(0);
    expect(snapshot.attempts).toHaveLength(1);
    expect(['accepted', 'dispatching', 'running']).not.toContain(snapshot.attempts[0].state);
  } finally {
    await f.close();
  }
});

for (const mode of ['recurring-reserved', 'recurring-cloned', 'recurring-admitted'])
  test(
    'SIGKILL at ' +
      mode +
      ' recovers the same occurrence without duplicate tasks or model requests',
    async () => {
      const f = await fixture(mode);
      try {
        const job = await call<any>(f.socket, '/v1/schedules', {
          ...f.actor,
          request_id: 'recurring-definition',
          expected_revision: f.task.revision,
          task_id: f.task.id,
          name: 'Recurring crash proof',
          max_steps: 1,
          compact: false,
          schedule: null,
        });
        const trigger = () =>
          call<any>(f.socket, `/v1/schedules/${job.id}/run`, {
            ...f.actor,
            request_id: 'recurring-run',
            expected_revision: 1,
            occurrence_key: 'once',
          });
        const lost = trigger().catch(() => null);
        await until(() => existsSync(join(f.dir, mode)), Boolean);
        const db = new DatabaseSync(join(f.state, 'journal.sqlite'), { readOnly: true }),
          row = db.prepare('SELECT * FROM recurring_occurrences').get()!;
        expect(db.prepare('SELECT count(*) AS n FROM attempts').get()!.n).toBe(0);
        db.close();
        await f.restart();
        await lost;
        const accepted = await trigger();
        expect(accepted.id).toBe(row.id);
        expect(accepted.session_id).toBe(row.session_id);
        const view = await until(
          () => call<any>(f.socket, `/v1/schedules/${job.id}`),
          (v) => !!v.occurrences[0]?.job_run_id,
          15000,
        );
        const run = await until(
          () => call<any>(f.socket, `/v1/jobs/${view.occurrences[0].job_run_id}`),
          (v) => v.state === 'succeeded',
          15000,
        );
        const snapshot = await call<any>(f.socket, `/v1/sessions/${accepted.session_id}/snapshot`);
        expect(snapshot.attempts).toHaveLength(1);
        expect(snapshot.work_task.id).toBe(run.task_id);
        expect(view.occurrences).toHaveLength(1);
      } finally {
        await f.close();
      }
    },
  );
