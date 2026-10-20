import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';

test('schema 9 upgrade preserves task/attempt identities, usage charges and legacy cached requests before creating any job', async () => {
  const f = await taskFixture();
  try {
    const task = await f.plan();
    await f.run();
    await f.settled();
    const before = await f.task();
    const request = f.service.store.db
      .prepare("SELECT actor,id,hash,response FROM requests WHERE json_extract(response,'$.id')=?")
      .get(task.id)!;
    await f.service.close();
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'));
    db.exec(
      'DROP TABLE station_units; DROP TABLE station_calls; DROP TABLE toolkit_resolution_controls; DROP TABLE toolkit_resolutions; DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; DROP TABLE job_occurrences;DROP TABLE jobs;PRAGMA user_version=9;',
    );
    db.close();
    await f.restart();
    const after = await f.task();
    expect(after.id).toBe(task.id);
    expect(after.steps[0]!.attempt_id).toBe(before.steps[0]!.attempt_id);
    expect(after.runtime.requests_spent).toBe(before.runtime.requests_spent);
    expect(after.runtime.token_units).toBe(before.runtime.token_units);
    expect(f.service.store.db.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 26,
    });
    expect(f.service.jobs.list().jobs).toHaveLength(0);
    expect(
      f.service.store.db
        .prepare('SELECT actor,id,hash,response FROM requests WHERE actor=? AND id=?')
        .get(String(request.actor), String(request.id)),
    ).toEqual(request);
    expect(
      f.service.taskWork.create(f.session.id, String(request.id), 0, checkedPlan(), {
        client_id: 'expired',
        token: 'expired',
      }).id,
    ).toBe(task.id);
  } finally {
    await f.close();
  }
});

test('schema 10 migration preserves an accepted one-shot occurrence, grant and cached trigger bytes', async () => {
  const f = await taskFixture();
  try {
    await f.service.taskDriver.close();
    const task = await f.plan(),
      job = f.service.jobs.create(
        task.id,
        'job',
        task.revision,
        'Existing schema-10 job',
        1,
        false,
        f.actor,
      ),
      accepted = f.service.jobs.trigger(job.id, 'run-job', 1, 'once', f.actor);
    const before = f.service.store.db.prepare("SELECT * FROM requests WHERE id='run-job'").get();
    await f.service.close();
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'));
    db.exec(
      'DROP TABLE station_units; DROP TABLE station_calls; DROP TABLE toolkit_resolution_controls; DROP TABLE toolkit_resolutions; DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; PRAGMA user_version=10;',
    );
    db.close();
    await f.restart();
    expect(
      f.service.jobs.trigger(job.id, 'run-job', 1, 'once', {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(accepted);
    expect(f.service.store.db.prepare("SELECT * FROM requests WHERE id='run-job'").get()).toEqual(
      before,
    );
    expect(f.service.jobs.view(job.id).occurrence?.id).toBe(accepted.occurrence_id);
  } finally {
    await f.close();
  }
});
