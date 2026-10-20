import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { DatabaseSync } from 'node:sqlite';
import { digest, type ChildTask } from '../../src/protocol.js';

test.each([false, true])(
  'parent and child reservations survive restart without refunds (token budget disabled: %s)',
  async (uncapped) => {
    const f = await taskFixture();
    try {
      f.service.dispatcher.pause();
      await f.service.taskDriver.close();
      await f.plan({
        ...checkedPlan(),
        limits: { requests: 3, ...(uncapped ? { token_units: null } : {}) },
      });
      const accepted = await f.run();
      const store = f.service.store;
      const admit = (session: string, attempt: string, key: string) =>
        store.usage.admit(session, attempt, key, 'salaam-proof', 'scripted', {
          input: 100,
          output: 1024,
        });
      admit(f.session.id, accepted.attempt_id, 'parent-one');
      const task = await f.task(),
        charge = uncapped ? 0 : task.limits.input_token_bound + task.limits.output_token_bound!;
      expect(task.runtime.token_units).toBe(charge);
      expect(() => admit(f.session.id, accepted.attempt_id, 'parent-one')).toThrow(
        'cannot be forwarded twice',
      );
      const child = store.create(f.source, 'child'),
        childAttempt = store.accept(child.id, 'child-instruction', child.revision, 'Read only');
      store.transaction(() => {
        store.db
          .prepare(
            "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES (?,?,?,?,?,?,?,?,?,'accepted')",
          )
          .run(
            randomUUID(),
            f.session.id,
            accepted.attempt_id,
            'child',
            'fixture',
            child.id,
            childAttempt.attempt_id,
            '["salaam_probe"]',
            2,
          );
        store.taskChildReserve!(f.session.id, childAttempt.attempt_id, 2);
        // This test admits model observations manually; give its synthetic child
        // the same durable identity record required of every real child.
        store.workerBoundary.freeze(
          store.db
            .prepare('SELECT * FROM child_tasks WHERE child_session=?')
            .get(child.id) as unknown as ChildTask,
          null,
          true,
        );
      });
      expect((await f.task()).runtime.reserved_requests).toBe(2);
      admit(child.id, childAttempt.attempt_id, 'child-one');
      expect((await f.task()).runtime).toMatchObject({
        requests_spent: 2,
        reserved_requests: 1,
        token_units: 2 * charge,
        reserved_tokens: charge,
      });
      await expect(
        Promise.resolve().then(() => admit(f.session.id, accepted.attempt_id, 'parent-overrun')),
      ).rejects.toThrow('request limit');
      const e = store.allocate(child.id, 'fixture');
      store.state(child.id, e, 'ready');
      store.claim(child.id, e);
      store.finish(childAttempt.attempt_id, 'interrupted', null, 'Unknown child request outcome');
      expect((await f.task()).runtime.reserved_requests).toBe(1);
      await f.restart();
      const restored = await f.task();
      expect(restored.runtime).toMatchObject({
        requests_spent: 2,
        reserved_requests: 1,
        token_units: 2 * charge,
        reserved_tokens: charge,
      });
    } finally {
      await f.close();
    }
  },
);

test('schema 8 task migration preserves attempt IDs and conservatively charges known and unknown old admissions', async () => {
  const f = await taskFixture();
  try {
    const initial = await f.plan();
    await f.run();
    const settled = await f.settled();
    f.service.store.db
      .prepare(
        "INSERT INTO usage_observations(source_key,session_id,provider,model,status) VALUES ('legacy-unknown',?,'salaam-proof','scripted','unknown')",
      )
      .run(f.session.id);
    await f.service.close();
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'));
    db.exec(
      'DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; DROP TABLE job_occurrences; DROP TABLE jobs; DROP TABLE task_compactions;DROP TABLE task_grants;DROP TABLE task_restores;DROP TABLE task_mutations;DROP TABLE task_checkpoints;DROP TABLE task_completions;DROP TABLE task_checks;DROP TABLE task_reservations;DROP TABLE task_runtime;ALTER TABLE task_steps DROP COLUMN checks;PRAGMA user_version=8;',
    );
    let legacyPlan: unknown;
    for (const row of db.prepare('SELECT task_id,revision,document FROM task_plans').all()) {
      const plan = JSON.parse(String(row.document));
      delete plan.acceptance;
      delete plan.deliverables;
      delete plan.limits;
      for (const step of plan.steps) delete step.checks;
      legacyPlan = plan;
      db.prepare('UPDATE task_plans SET document=? WHERE task_id=? AND revision=?').run(
        JSON.stringify(plan),
        String(row.task_id),
        Number(row.revision),
      );
    }
    const prior = db
      .prepare(
        "SELECT id,response FROM requests WHERE actor='local-operator' AND json_extract(response,'$.id')=?",
      )
      .get(initial.id)!;
    const legacyRequest = String(prior.id),
      response = JSON.parse(String(prior.response));
    delete response.acceptance;
    delete response.deliverables;
    delete response.limits;
    for (const step of response.steps) delete step.checks;
    db.prepare("UPDATE requests SET hash=?,response=? WHERE actor='local-operator' AND id=?").run(
      digest({ kind: 'work-task-create', session: f.session.id, expected: 0, plan: legacyPlan }),
      JSON.stringify(response),
      legacyRequest,
    );
    db.close();
    await f.restart();
    const recovered = await f.task();
    expect(recovered.id).toBe(initial.id);
    expect(
      f.service.taskWork.create(f.session.id, legacyRequest, 0, legacyPlan, {
        client_id: 'expired',
        token: 'expired',
      }).id,
    ).toBe(initial.id);
    expect(recovered.steps[0]!.attempt_id).toBe(settled.steps[0]!.attempt_id);
    expect(recovered.runtime.requests_spent).toBe(3);
    expect(recovered.runtime.token_units).toBe(
      3 * (recovered.limits.input_token_bound + recovered.limits.output_token_bound!),
    );
    expect(
      f.service.store.db
        .prepare("SELECT status FROM usage_observations WHERE source_key='legacy-unknown'")
        .get(),
    ).toMatchObject({ status: 'unknown' });
    expect(f.service.store.db.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 24,
    });
  } finally {
    await f.close();
  }
});

test('task concurrency prevents a command grant before any executor create', async () => {
  const f = await taskFixture();
  try {
    f.service.dispatcher.pause();
    await f.service.taskDriver.close();
    await f.plan({ ...checkedPlan(), limits: { concurrency: 1 } });
    await f.run();
    const w = f.service.workspaces.get(f.session.id);
    expect(() =>
      f.service.coding.start(
        f.session.id,
        null,
        { step_key: 'excess-command', command: 'fixture-pass', expected_revision: w.revision },
        () => {},
      ),
    ).toThrow('concurrency');
    expect(f.backend.runs.size).toBe(0);
    expect(f.service.coding.list(f.session.id)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('declared payload/output and total token bounds deny admission without a false zero-usage result', async () => {
  for (const limits of [{ input_token_bound: 10 }, { output_token_bound: 1 }, { token_units: 1 }]) {
    const f = await taskFixture();
    try {
      f.service.dispatcher.pause();
      await f.service.taskDriver.close();
      await f.plan({ ...checkedPlan(), limits });
      const attempt = await f.run();
      expect(() =>
        f.service.store.usage.admit(
          f.session.id,
          attempt.attempt_id,
          'oversized',
          'salaam-proof',
          'scripted',
          { input: 100, output: 1024 },
        ),
      ).toThrow(/bounds|token budget/);
      expect((await f.task()).runtime.requests_spent).toBe(0);
      expect(
        f.service.store.db
          .prepare("SELECT 1 FROM usage_observations WHERE source_key='oversized'")
          .get(),
      ).toBeUndefined();
      expect((await f.task()).runtime.blocked_reason).toBeTruthy();
    } finally {
      await f.close();
    }
  }
});

test('manual verification and command admission start the task deadline before any model request', async () => {
  for (const mode of ['verification', 'command']) {
    const f = await taskFixture();
    try {
      await f.plan();
      expect((await f.task()).runtime.started_at).toBeNull();
      const before = Date.now();
      if (mode === 'verification') await f.verify();
      else {
        const workspace = f.service.workspaces.get(f.session.id);
        f.service.coding.start(
          f.session.id,
          null,
          {
            step_key: 'manual-first-command',
            command: 'fixture-pass',
            expected_revision: workspace.revision,
          },
          () => {},
        );
      }
      const runtime = (await f.task()).runtime;
      expect(runtime.started_at).toBeGreaterThanOrEqual(before);
      expect(runtime.requests_spent).toBe(0);
      await f.restart();
      expect((await f.task()).runtime.started_at).toBe(runtime.started_at);
      await f.action('cancel');
      f.service.taskBudget.block(f.session.id, 'Late budget error after cancellation');
      expect((await f.task()).state).toBe('cancelled');
    } finally {
      await f.close();
    }
  }
});

test.each([false, true])(
  'explicit opt-out preserves charges; uncapped work cannot be recast as budgeted (disabled: %s)',
  async (uncapped) => {
    const f = await taskFixture();
    try {
      const plan = { ...checkedPlan(), limits: { token_units: uncapped ? null : 16777216 } };
      await f.plan(plan);
      await f.run();
      await f.settled();
      const before = await f.task();
      if (!uncapped) {
        await f.action('revise', { plan: { ...plan, limits: { token_units: null } } });
        expect((await f.task()).runtime.requests_spent).toBe(before.runtime.requests_spent);
        expect((await f.task()).runtime.token_units).toBe(before.runtime.token_units);
        expect((await f.task()).runtime.started_at).toBe(before.runtime.started_at);
      }
      await expect(
        f.action('revise', { plan: { ...plan, limits: { token_units: 16777216 } } }),
      ).rejects.toThrow('Cannot enable token budgeting');
      await f.restart();
      expect((await f.task()).limits.token_units).toBeNull();
      expect((await f.task()).runtime.requests_spent).toBe(before.runtime.requests_spent);
    } finally {
      await f.close();
    }
  },
);
