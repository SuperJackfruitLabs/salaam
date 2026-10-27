import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';
import { TaskContext } from '../../src/task-context.js';
import { TaskWork } from '../../src/task-work.js';
import { StationCheckpoints } from '../../src/station-checkpoints.js';
import { canonical } from '../../src/protocol.js';

// Item 11: checkpoints of a station task come from its own recorded writes.
function fixture() {
  const dir = mkdtempSync('/tmp/sal-ckp-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const tasks = new TaskWork(
    store,
    new TaskContext(store, new Artifacts(join(dir, 'artifacts'), store)),
  );
  const session = store.create(dir, 'create').id;
  const task = store.transaction(() =>
    tasks.createInTransaction(
      session,
      'task',
      0,
      {
        objective: 'o',
        constraints: [],
        steps: [
          { key: 'draft', title: 'Draft', instruction: 'd', depends_on: [] },
          { key: 'polish', title: 'Polish', instruction: 'p', depends_on: ['draft'] },
        ],
        acceptance: [{ key: 't', command: 'true', cwd: '.' }],
        deliverables: ['a.md'],
      },
      () => {},
    ),
  );
  const steps = tasks.get(task.id).steps;
  let n = 0,
    tree = 't0';
  store.db.exec('PRAGMA foreign_keys=OFF');
  const write = (
    step: number,
    path: string,
    content: string | null,
    expected_hash: string | null,
  ) => {
    const attempt = 'attempt-' + step;
    store.db
      .prepare('INSERT OR IGNORE INTO task_step_attempts VALUES (?,?,?,?)')
      .run(attempt, steps[step]!.id, 1, 'x');
    const before = tree;
    tree = 't' + ++n;
    store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,result_json) VALUES (?,?,1,?,?,'patch','i','r','c',?,NULL,'returned',?)",
      )
      .run(
        'call-' + n,
        session,
        attempt,
        'tool-' + n,
        canonical({ action: 'patch', path, content, expected_hash, expected_tree: before }),
        canonical({
          ok: true,
          path,
          before_tree_digest: before,
          tree_digest: tree,
          sha256: content === null ? null : 'h-' + content,
        }),
      );
  };
  const complete = (step: number) =>
    store.db.prepare("UPDATE task_steps SET state='completed' WHERE id=?").run(steps[step]!.id);
  return { store, tasks, task, write, complete, checkpoints: new StationCheckpoints(store) };
}

test('each completed step ends at a checkpoint with its tree and the files it changed', () => {
  const f = fixture();
  f.write(0, 'runs/r/a.md', 'v1', null); // created
  f.write(0, 'README.md', 'edited', 'h0'); // pre-existing
  f.complete(0);
  f.write(1, 'runs/r/a.md', 'v2', 'h1');
  f.write(1, 'runs/r/b.md', 'new', null);
  f.complete(1);
  const list = f.checkpoints.list(f.tasks.get(f.task.id));
  expect(list.map((c) => [c.step_key, c.tree_digest, c.files_changed])).toEqual([
    ['draft', 't2', ['README.md', 'runs/r/a.md']],
    ['polish', 't4', ['runs/r/a.md', 'runs/r/b.md']],
  ]);
  expect(new Set(list.map((c) => c.id)).size).toBe(2);
});

test('the diff to a checkpoint reverts, deletes, brings back, and refuses what it never saw', () => {
  const f = fixture();
  f.write(0, 'runs/r/a.md', 'v1', null);
  f.write(0, 'runs/r/gone.md', 'keep me', null);
  f.complete(0);
  f.write(1, 'runs/r/a.md', 'v2', 'h1');
  f.write(1, 'runs/r/b.md', 'new', null);
  f.write(1, 'runs/r/gone.md', null, 'h2');
  f.write(1, 'README.md', 'edited later', 'h0');
  f.complete(1);
  const task = f.tasks.get(f.task.id);
  const [draft] = f.checkpoints.list(task);
  const diff = f.checkpoints.diff(task, draft!.id);
  expect(diff.current_tree).toBe('t6');
  expect(Object.fromEntries(diff.files.map((x) => [x.path, x.change]))).toEqual({
    'README.md': 'not_restorable',
    'runs/r/a.md': 'revert',
    'runs/r/b.md': 'delete',
    'runs/r/gone.md': 'bring_back',
  });
  expect(diff.files.find((x) => x.path === 'runs/r/a.md')!.at_checkpoint).toEqual({
    state: 'content',
    content: 'v1',
  });
  expect(() => f.checkpoints.diff(task, 'nope')).toThrow('No such checkpoint');
});

test('an unfinished step has no checkpoint, and a failed or unreturned write is ignored', () => {
  const f = fixture();
  f.write(0, 'runs/r/a.md', 'v1', null);
  f.store.db.prepare("UPDATE station_calls SET state='failed' WHERE id='call-1'").run();
  f.complete(0);
  f.write(1, 'runs/r/a.md', 'v2', null);
  const list = f.checkpoints.list(f.tasks.get(f.task.id));
  expect(list).toHaveLength(1);
  expect(list[0]!.files_changed).toEqual([]);
});

// Item 11b: the restore plan is exact. Its digest binds the checkpoint, the current tree and every
// file change; the writes carry each file's current hash, so the helper refuses a drifted file.
test('a restore plan lists exact writes, and its digest moves with any change', () => {
  const f = fixture();
  f.write(0, 'runs/r/a.md', 'v1', null);
  f.write(0, 'runs/r/gone.md', 'keep me', null);
  f.complete(0);
  f.write(1, 'runs/r/a.md', 'v2', 'h-v1');
  f.write(1, 'runs/r/b.md', 'new', null);
  f.write(1, 'runs/r/gone.md', null, 'h-keep me');
  f.write(1, 'README.md', 'edited later', 'h0');
  f.complete(1);
  const task = f.tasks.get(f.task.id);
  const [draft] = f.checkpoints.list(task);
  const diff = f.checkpoints.diff(task, draft!.id);
  const plan = f.checkpoints.restorePlan(task, draft!.id);
  expect(plan.restore_digest).toBe(diff.restore_digest);
  expect(plan.current_tree).toBe('t6');
  expect(plan.writes).toEqual([
    { path: 'runs/r/a.md', content: 'v1', expected_hash: 'h-v2' },
    { path: 'runs/r/b.md', content: null, expected_hash: 'h-new' },
    { path: 'runs/r/gone.md', content: 'keep me', expected_hash: null },
  ]);
  // README.md existed before the run: it is left as it is, never written.
  expect(plan.writes.some((w) => w.path === 'README.md')).toBe(false);
  // A later write changes the current tree, so the earlier approval no longer matches.
  f.write(1, 'runs/r/c.md', 'more', null);
  expect(f.checkpoints.restorePlan(f.tasks.get(f.task.id), draft!.id).restore_digest).not.toBe(
    plan.restore_digest,
  );
});

test('the restore digest moves when only the current tree moves', () => {
  const f = fixture();
  f.write(0, 'runs/r/a.md', 'v1', null);
  f.complete(0);
  f.write(1, 'runs/r/a.md', 'v2', 'h-v1');
  f.complete(1);
  const [draft] = f.checkpoints.list(f.tasks.get(f.task.id));
  const before = f.checkpoints.restorePlan(f.tasks.get(f.task.id), draft!.id);
  // The same bytes written again: the file plan is identical, only the tree has moved on.
  f.write(1, 'runs/r/a.md', 'v2', 'h-v2');
  const after = f.checkpoints.restorePlan(f.tasks.get(f.task.id), draft!.id);
  expect(after.writes).toEqual(before.writes);
  expect(after.current_tree).not.toBe(before.current_tree);
  expect(after.restore_digest).not.toBe(before.restore_digest);
});
