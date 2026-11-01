import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/store.js';
import { Artifacts } from '../../src/store/artifacts.js';
import { TaskContext } from '../../src/tasks/context.js';
import { TaskWork } from '../../src/tasks/work.js';
import { TaskCritic, CRITIC_BUDGET } from '../../src/tasks/critic.js';

// Item 8: the completion critic's verdict, bound to the exact verified evidence.
function fixture(rubric: string | null = 'Every claim cites RFC 9110.') {
  const dir = mkdtempSync('/tmp/sal-task-critic-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const artifacts = new Artifacts(join(dir, 'artifacts'), store);
  const tasks = new TaskWork(store, new TaskContext(store, artifacts));
  const session = store.create(dir, 'create').id;
  const created = store.transaction(() =>
    tasks.createInTransaction(
      session,
      'task',
      0,
      {
        objective: 'Answer the question',
        constraints: [],
        steps: [{ key: 's', title: 'S', instruction: 'Do it', depends_on: [] }],
        acceptance: [{ key: 't', command: 'true', cwd: '.' }],
        deliverables: ['runs/r/answer.md'],
        ...(rubric ? { completion_gate: { critic: { rubric }, hooks: [] } } : {}),
      },
      () => {},
    ),
  );
  const task = tasks.get(created.id);
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.db
    .prepare("INSERT INTO task_step_attempts VALUES ('att-last',?,?,'x')")
    .run(task.steps[0]!.id, 1);
  const spawned: { prompt: string; budget: number; snapshot: unknown; parent: string }[] = [];
  const children = new Map<string, string>();
  const critic = new TaskCritic(store, artifacts, {
    admit: async () => ({ id: 'grant' }) as never,
    spawn: (_t, parent, step, prompt, budget, _g, snapshot) => {
      spawned.push({ prompt, budget, snapshot, parent });
      const id = 'child-' + step;
      store.db
        .prepare(
          "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES (?,?,?,?,'d',?,?,'[]',?,'accepted')",
        )
        .run(id, session, parent, step, 'cs-' + id, 'ca-' + id, budget);
      children.set(id, 'worker-' + id);
      return { id } as never;
    },
    workerId: (id) => children.get(id)!,
  });
  const settle = (id: string, findings: { severity: string }[] | null) => {
    store.db.prepare("UPDATE child_tasks SET state='returned' WHERE id=?").run(id);
    if (findings)
      store.transaction(() => {
        const a = artifacts.prepare(
          session,
          JSON.stringify({
            findings: findings.map((x) => ({
              path: 'runs/r/answer.md',
              line: 1,
              message: 'm',
              ...x,
            })),
          }),
        );
        a.commit();
        store.db
          .prepare("INSERT INTO specialist_reports VALUES (?,'d',?)")
          .run('worker-' + id, a.id);
      });
  };
  return { store, task, critic, spawned, settle };
}
const answer = [{ path: 'runs/r/answer.md', content: '# 502 Bad Gateway\n' }];

test('the reviewer is started once for this evidence, over exactly the verified bytes', async () => {
  const f = fixture();
  expect(await f.critic.gate(f.task, 'e1', answer)).toEqual({ state: 'pending' });
  expect(await f.critic.gate(f.task, 'e1', answer)).toEqual({ state: 'pending' });
  expect(f.spawned).toHaveLength(1);
  expect(f.spawned[0]).toMatchObject({ budget: CRITIC_BUDGET, parent: 'att-last' });
  expect(f.spawned[0]!.prompt).toContain('Every claim cites RFC 9110.');
  expect(f.spawned[0]!.snapshot).toEqual({
    'runs/r/answer.md': {
      content: Buffer.from('# 502 Bad Gateway\n').toString('base64'),
      executable: false,
    },
  });
});

test('suggestions pass; a critical or high finding needs changes; no report at all fails', async () => {
  for (const [findings, verdict] of [
    [[], 'pass'],
    [[{ severity: 'medium' }, { severity: 'low' }], 'pass'],
    [[{ severity: 'high' }], 'changes_needed'],
    [[{ severity: 'critical' }], 'changes_needed'],
    [null, 'failed'],
  ] as const) {
    const f = fixture();
    await f.critic.gate(f.task, 'e1', answer);
    f.settle('child-critic-1-1', findings as never);
    expect((await f.critic.gate(f.task, 'e1', answer)).state, JSON.stringify(findings)).toBe(
      verdict,
    );
    expect(f.critic.passed(f.task, 'e1')).toBe(verdict === 'pass');
  }
});

test('a verdict holds only for its own evidence; new evidence is a new review round', async () => {
  const f = fixture();
  await f.critic.gate(f.task, 'e1', answer);
  f.settle('child-critic-1-1', [{ severity: 'high' }]);
  expect((await f.critic.gate(f.task, 'e1', answer)).state).toBe('changes_needed');
  expect(f.critic.reopens(f.task)).toBe(1);
  expect(f.critic.passed(f.task, 'e2')).toBe(false);
  expect(await f.critic.gate(f.task, 'e2', answer)).toEqual({ state: 'pending' });
  expect(f.spawned.map((s) => s.prompt.length > 0)).toEqual([true, true]);
  f.settle('child-critic-1-2', []);
  expect((await f.critic.gate(f.task, 'e2', answer)).state).toBe('pass');
  expect(f.critic.passed(f.task, 'e2')).toBe(true);
  expect(f.critic.passed(f.task, 'e1')).toBe(false);
});

test('without a declared critic the gate passes and nothing is started', async () => {
  const f = fixture(null);
  expect(await f.critic.gate(f.task, 'e1', answer)).toEqual({ state: 'pass' });
  expect(f.spawned).toHaveLength(0);
});

test('a reopen re-runs only the completed last step, with the findings, under its own request', () => {
  const f = fixture();
  const store = f.store;
  const step = f.task.steps[0]!;
  const work = new TaskWork(
    store,
    new TaskContext(store, new Artifacts(join(mkdtempSync('/tmp/sal-tc-'), 'a'), store)),
  );
  store.db
    .prepare(
      "UPDATE task_runtime SET auto_enabled=1,auto_plan_revision=?,remaining_steps=2,auto_epoch=1,auto_binding='b' WHERE task_id=?",
    )
    .run(f.task.plan_revision, f.task.id);
  store.db
    .prepare("INSERT INTO task_grants VALUES ('g1',?,?,?,?,'accepted','b',1)")
    .run(f.task.id, step.id, f.task.plan_revision, f.task.revision);
  expect(() => work.reopenForCritic(f.task.id, step.id, 1, 1, '- x')).toThrow(
    'completed last step',
  );
  store.db.prepare("UPDATE task_steps SET state='completed' WHERE id=?").run(step.id);
  const run = work.reopenForCritic(
    f.task.id,
    step.id,
    1,
    1,
    '- runs/r/answer.md:1 (high) cite the RFC',
  ) as { attempt_id: string };
  expect(work.get(f.task.id).steps[0]!.state).toBe('queued');
  const text = store.db
    .prepare('SELECT instruction FROM task_step_attempts WHERE attempt_id=?')
    .get(run.attempt_id)!.instruction;
  expect(String(text)).toContain('cite the RFC');
  expect(
    store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='work_task.step_reopened'").get()!
      .n,
  ).toBe(1);
});
