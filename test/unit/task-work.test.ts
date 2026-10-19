import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';
import { TaskContext } from '../../src/task-context.js';
import { TaskWork } from '../../src/task-work.js';
import { ManagedWork } from '../../src/managed.js';

const plan = {
  objective: 'Repair addition',
  constraints: ['Preserve human edits'],
  steps: [
    { key: 'fix', title: 'Fix', instruction: 'Fix addition', depends_on: [] },
    { key: 'check', title: 'Check', instruction: 'Run tests', depends_on: ['fix'] },
  ],
};
function fixture() {
  const dir = mkdtempSync('/tmp/sal-work-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const context = new TaskContext(store, new Artifacts(join(dir, 'artifacts'), store));
  const tasks = new TaskWork(store, context);
  const session = store.create(dir, 'session');
  const lease = store.control(session.id, 'control', 'operator', 'acquire', 0);
  const controller = { client_id: 'operator', token: lease.token };
  const create = () => tasks.create(session.id, 'create', 0, plan, controller);
  return {
    dir,
    store,
    tasks,
    context,
    session,
    controller,
    create,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('task admissions are idempotent before revisions/leases, dependency-bound and reviewed explicitly', () => {
  const f = fixture();
  try {
    const revision = 0;
    let task = f.create();
    expect(
      f.tasks.create(f.session.id, 'create', revision, plan, {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(task);
    const [fix, check] = task.steps;
    expect(() =>
      f.tasks.run(task.id, check!.id, 'early', task.revision, null, null, f.controller),
    ).toThrow('required steps');
    expect(() =>
      f.store.accept(
        f.session.id,
        'unbound',
        f.store.session(f.session.id).revision,
        'Bypass',
        f.controller,
      ),
    ).toThrow('explicit task step');
    const accepted = f.tasks.run(task.id, fix!.id, 'run', task.revision, null, null, f.controller);
    expect(
      f.tasks.run(task.id, fix!.id, 'run', task.revision, null, null, {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(accepted);
    expect(() =>
      f.tasks.run(task.id, fix!.id, 'run', task.revision, 'Changed', null, f.controller),
    ).toThrow('different input');
    const epoch = f.store.allocate(f.session.id, 'boot');
    f.store.state(f.session.id, epoch, 'ready');
    f.store.claim(f.session.id, epoch);
    f.store.running(accepted.attempt_id);
    f.store.finish(accepted.attempt_id, 'completed', 'Model claims everything is finished', null);
    task = f.tasks.get(task.id);
    expect(task).toMatchObject({
      state: 'blocked',
      steps: [{ id: fix!.id, state: 'awaiting_review' }, { state: 'pending' }],
    });
    expect(f.store.claim(f.session.id, epoch)).toBeNull();
    task = f.tasks.complete(
      task.id,
      fix!.id,
      'review',
      task.revision,
      'Operator inspected the change; verification pending',
      f.controller,
    );
    const next = f.tasks.run(task.id, check!.id, 'check', task.revision, null, null, f.controller);
    f.store.claim(f.session.id, epoch);
    f.store.finish(next.attempt_id, 'completed', 'Done', null);
    task = f.tasks.get(task.id);
    task = f.tasks.complete(
      task.id,
      check!.id,
      'review-check',
      task.revision,
      'Reviewed offline result',
      f.controller,
    );
    expect(task.state).toBe('verifying');
    expect(task.reason).toContain('verification required');
    expect(f.context.frame(f.session.id, 'binding')).toContain(task.id);
    expect(() =>
      f.tasks.run(task.id, fix!.id, 'repeat-completed', task.revision, null, null, f.controller),
    ).toThrow('current state');
  } finally {
    f.close();
  }
});

test('plan corrections retain history and identities; attempted steps and other tasks cannot be overwritten', () => {
  const f = fixture();
  try {
    let task = f.create();
    const corrected = {
      ...plan,
      objective: 'Repair addition without changing exports',
      steps: [plan.steps[0]!, { ...plan.steps[1]!, instruction: 'Run the full offline suite' }],
    };
    const initial = task;
    task = f.tasks.revise(task.id, 'revise', task.revision, corrected, f.controller);
    expect(task.steps.map((s) => s.id)).toEqual(initial.steps.map((s) => s.id));
    expect(task.plan_revision).toBe(2);
    expect(f.tasks.history(task.id)).toMatchObject({
      plans: [
        { revision: 1, plan },
        { revision: 2, plan: corrected },
      ],
    });
    expect(() => f.tasks.revise(task.id, 'stale', initial.revision, plan, f.controller)).toThrow(
      'revision changed',
    );
    expect(() =>
      f.tasks.run(task.id, 'foreign', 'foreign', task.revision, null, null, f.controller),
    ).toThrow('belong');
    f.tasks.run(task.id, task.steps[0]!.id, 'run', task.revision, null, null, f.controller);
    const epoch = f.store.allocate(f.session.id, 'boot');
    f.store.state(f.session.id, epoch, 'ready');
    const attempt = f.store.claim(f.session.id, epoch)!.attempt;
    f.store.finish(attempt.id, 'failed', null, 'Test failure');
    task = f.tasks.get(task.id);
    expect(() =>
      f.tasks.complete(
        task.id,
        task.steps[0]!.id,
        'false-review',
        task.revision,
        'Looks done',
        f.controller,
      ),
    ).toThrow('settled step');
    expect(() =>
      f.tasks.revise(
        task.id,
        'overwrite',
        task.revision,
        { ...plan, steps: [{ ...plan.steps[0]!, instruction: 'Rewrite history' }, plan.steps[1]] },
        f.controller,
      ),
    ).toThrow('immutable');
    expect(f.tasks.get(task.id).plan_revision).toBe(2);
  } finally {
    f.close();
  }
});

test('failed admission/finish commits roll back task, attempts, requests and events together', () => {
  const f = fixture();
  try {
    const task = f.create(),
      before = f.store.session(f.session.id).seq;
    let notifications = 0;
    f.store.changes.on('event', () => notifications++);
    f.store.db.exec(
      "CREATE TEMP TRIGGER reject_task_event BEFORE INSERT ON events WHEN NEW.kind='work_task.step_accepted' BEGIN SELECT RAISE(ABORT,'injected task recording failure'); END;",
    );
    expect(() =>
      f.tasks.run(task.id, task.steps[0]!.id, 'run', task.revision, null, null, f.controller),
    ).toThrow('recording failure');
    expect(f.tasks.get(task.id)).toEqual(task);
    expect(f.store.db.prepare('SELECT count(*) n FROM attempts').get()).toMatchObject({ n: 0 });
    expect(
      f.store.db.prepare("SELECT count(*) n FROM requests WHERE id='run'").get(),
    ).toMatchObject({ n: 0 });
    expect(f.store.session(f.session.id).seq).toBe(before);
    expect(notifications).toBe(0);
    f.store.db.exec('DROP TRIGGER reject_task_event');
    const accepted = f.tasks.run(
      task.id,
      task.steps[0]!.id,
      'run',
      task.revision,
      null,
      null,
      f.controller,
    );
    const epoch = f.store.allocate(f.session.id, 'boot');
    f.store.state(f.session.id, epoch, 'ready');
    f.store.claim(f.session.id, epoch);
    const running = f.tasks.get(task.id);
    notifications = 0;
    f.store.db.exec(
      "CREATE TEMP TRIGGER reject_finish BEFORE INSERT ON events WHEN NEW.kind='work_task.step_state' BEGIN SELECT RAISE(ABORT,'injected finish failure'); END;",
    );
    expect(() => f.store.finish(accepted.attempt_id, 'completed', 'Done', null)).toThrow(
      'finish failure',
    );
    expect(f.store.attempt(accepted.attempt_id).state).toBe('dispatching');
    expect(f.tasks.get(task.id)).toEqual(running);
    expect(notifications).toBe(0);
  } finally {
    f.close();
  }
});

test('v7 migration and repeated v8 opens preserve the ledger; newer schemas fail closed', () => {
  const dir = mkdtempSync('/tmp/sal-work-schema-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  try {
    store.create(dir, 'old-session');
    store.db.exec(
      'DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; DROP TABLE operator_inbox; DROP TABLE recurring_occurrences; DROP TABLE schedule_revisions; DROP TABLE recurring_jobs; DROP TABLE job_occurrences; DROP TABLE jobs; DROP TABLE task_compactions; DROP TABLE task_grants; DROP TABLE task_restores; DROP TABLE task_mutations; DROP TABLE task_checkpoints; DROP TABLE task_completions; DROP TABLE task_checks; DROP TABLE task_reservations; DROP TABLE task_runtime; DROP TABLE task_step_attempts; DROP TABLE task_steps; DROP TABLE task_plans; DROP TABLE durable_tasks; PRAGMA user_version=7;',
    );
    store.close();
    store = new Store(path);
    expect(store.sessions()).toHaveLength(1);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 20 });
    store.close();
    store = new Store(path);
    expect(store.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 20 });
    store.db.exec('PRAGMA user_version=21');
    store.close();
    expect(() => new Store(path)).toThrow('newer');
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid plans and context-capacity failures leave no task or published event', () => {
  const f = fixture();
  try {
    const before = f.store.session(f.session.id).seq;
    for (const invalid of [
      { ...plan, steps: [plan.steps[0], plan.steps[0]] },
      { ...plan, steps: [{ ...plan.steps[0], depends_on: ['check'] }, plan.steps[1]] },
      { ...plan, constraints: Array(16).fill('x'.repeat(2048)) },
    ])
      expect(() => f.tasks.create(f.session.id, 'invalid', 0, invalid, f.controller)).toThrow();
    expect(f.tasks.forSession(f.session.id)).toBeNull();
    expect(f.store.session(f.session.id).seq).toBe(before);
    expect(() =>
      f.tasks.create(f.session.id, 'unauthorized', 0, plan, { client_id: 'wrong', token: 'wrong' }),
    ).toThrow('controller lease');
    expect(() => f.tasks.create(f.session.id, 'wrong-revision', 1, plan, f.controller)).toThrow(
      'revision zero',
    );
    expect(f.create().steps).toHaveLength(2);
  } finally {
    f.close();
  }
});

test('queued cancellation projects atomically to the task and a retry requires a new explicit request', async () => {
  const f = fixture(),
    managed = new ManagedWork(f.store, { assertActive() {}, reply() {}, failed() {} });
  try {
    let task = f.create();
    const accepted = f.tasks.run(
      task.id,
      task.steps[0]!.id,
      'run',
      task.revision,
      null,
      null,
      f.controller,
    );
    managed.cancel(
      accepted.attempt_id,
      'cancel',
      f.store.session(f.session.id).revision,
      f.controller,
    );
    task = f.tasks.get(task.id);
    expect(task).toMatchObject({
      state: 'blocked',
      steps: [{ state: 'cancelled', attempt_id: accepted.attempt_id }, { state: 'pending' }],
    });
    const fresh = f.tasks.run(
      task.id,
      task.steps[0]!.id,
      'retry',
      task.revision,
      'Try again after inspection',
      null,
      f.controller,
    );
    expect(fresh.attempt_id).not.toBe(accepted.attempt_id);
  } finally {
    await managed.close();
    f.close();
  }
});
