import { test, expect } from 'vitest';
import { Store } from '../../src/store.js';
import { RunGrants, runGrantCovers, runGrantPrefix } from '../../src/run-grants.js';

const prefix = runGrantPrefix('run_abc12345')!;
const patch = (path: string, content: string | null = 'x') => ({
  action: 'patch',
  path,
  content,
  expected_hash: null,
  expected_tree: 'a'.repeat(64),
});

test('a run grant covers writes under the run directory and nothing else', () => {
  expect(prefix).toBe('runs/run_abc12345/');
  expect(runGrantCovers(prefix, patch('runs/run_abc12345/answer.md'))).toBe(true);
  expect(runGrantCovers(prefix, patch('runs/run_abc12345/notes/a.md'))).toBe(true);
  for (const [why, args] of Object.entries({
    delete: patch('runs/run_abc12345/answer.md', null),
    'another run': patch('runs/run_other999/answer.md'),
    'outside runs': patch('answer.md'),
    'the directory itself': patch('runs/run_abc12345/'),
    'a dot segment': patch('runs/run_abc12345/../x.md'),
    'a hidden file': patch('runs/run_abc12345/.env'),
    'a hidden directory': patch('runs/run_abc12345/.git/config'),
    'an empty segment': patch('runs/run_abc12345//x.md'),
    'a check': { action: 'check', command: 'true', expected_tree: 'a'.repeat(64) },
  }))
    expect(runGrantCovers(prefix, args), why).toBe(false);
  expect(runGrantPrefix('../x')).toBeNull();
});

test('a grant is live only for its own session, task, plan revision and binding, until the task settles', () => {
  const store = new Store(':memory:');
  const grants = new RunGrants(store);
  const scope = {
    session_id: store.create('/tmp', 'grant').id,
    task_id: 't1',
    plan_revision: 1,
    binding_digest: 'b'.repeat(64),
  };
  const grant = store.transaction(() =>
    grants.createInTransaction({
      ...scope,
      path_prefix: prefix,
      approval_id: 'ap1',
      granted_by: 'prn_human',
    }),
  );
  // Idempotent per approval.
  expect(
    store.transaction(() =>
      grants.createInTransaction({
        ...scope,
        path_prefix: prefix,
        approval_id: 'ap1',
        granted_by: 'prn_human',
      }),
    ).id,
  ).toBe(grant.id);
  expect(() =>
    grants.createInTransaction({
      ...scope,
      path_prefix: prefix,
      approval_id: 'ap2',
      granted_by: 'x',
    }),
  ).toThrow('created with its decision');
  expect(grants.active({ ...scope, task_state: 'running' })?.id).toBe(grant.id);
  for (const [why, other] of Object.entries({
    session: { session_id: 's2' },
    task: { task_id: 't2' },
    plan: { plan_revision: 2 },
    binding: { binding_digest: 'c'.repeat(64) },
  }))
    expect(grants.active({ ...scope, ...other, task_state: 'running' }), why).toBeNull();
  for (const settled of ['cancelled', 'succeeded', 'succeeded_with_exception'])
    expect(grants.active({ ...scope, task_state: settled })).toBeNull();
  store.db.prepare('UPDATE run_grants SET revoked_at=? WHERE id=?').run('now', grant.id);
  expect(grants.active({ ...scope, task_state: 'running' })).toBeNull();
});
