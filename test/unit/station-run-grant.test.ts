import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import { StationWork } from '../../src/station-work.js';
import { RunGrants } from '../../src/run-grants.js';
import { digest } from '../../src/protocol.js';

// "Approve for this run": a later covered write is answered by the run's grant, journaled with it.
function fixture() {
  const store = new Store(':memory:'),
    session = store.create('/tmp', 'create'),
    submission = store.accept(session.id, 'submit', session.revision, 'Test'),
    epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    assertMcpOperation: () => {},
    reply: () => {},
    failed: () => {},
  });
  const binding = {
    fixture: 'root',
    run: { source: 'superpipeline', id: 'run_abc12345', epoch: 1 },
  };
  const scope = { task_id: randomUUID(), plan_revision: 1, task_state: 'running' };
  const grants = new RunGrants(store);
  const rules: { id: string; scope: 'workspace-write'; set_by: string }[] = [];
  const station = Object.assign(Object.create(StationWork.prototype), {
    store,
    managed,
    grants,
    authority: { binding: () => binding, approvalRules: () => rules },
    grantScope: () => scope,
  }) as StationWork;
  let n = 0;
  const write = (path: string, content: string | null = 'answer') => {
    const args = {
      action: 'patch',
      path,
      content,
      expected_hash: content === null ? 'e'.repeat(64) : null,
      expected_tree: 'a'.repeat(64),
    };
    const { operation, approval } = store.transaction(() =>
      (managed as any).insertPrepared(
        session.id,
        epoch,
        submission.attempt_id,
        'call-' + ++n,
        'workspace',
        'station:' + path,
        JSON.stringify(args),
        'a'.repeat(64),
      ),
    );
    return { args, operation, approval };
  };
  const grant = (prefix = 'runs/run_abc12345/') =>
    store.transaction(() =>
      grants.createInTransaction({
        session_id: session.id,
        task_id: scope.task_id,
        plan_revision: 1,
        binding_digest: digest(binding),
        path_prefix: prefix,
        approval_id: randomUUID(),
        granted_by: 'prn_human',
      }),
    );
  return { store, managed, station, scope, write, grant, session, rules };
}

test('a covered write is answered by the run grant and records which grant allowed it', () => {
  const f = fixture();
  const g = f.grant();
  const w = f.write('runs/run_abc12345/notes.md');
  (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
  expect(f.managed.approval(w.approval.id)).toMatchObject({
    state: 'decided',
    decision: 'approve',
    decided_by: 'run-grant:' + g.id,
  });
  const event = f.store.db
    .prepare("SELECT payload FROM events WHERE kind='permission.auto-approved'")
    .get()!;
  expect(JSON.parse(String(event.payload))).toMatchObject({
    grant_id: g.id,
    granted_by: 'prn_human',
    operation_id: w.operation.id,
  });
});

test('a delete, a write outside the run directory, or no grant still asks', () => {
  const f = fixture();
  f.grant();
  for (const [path, content] of [
    ['runs/run_abc12345/answer.md', null],
    ['answer.md', 'x'],
    ['runs/run_abc12345/.env', 'x'],
  ] as const) {
    const w = f.write(path, content);
    (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
    expect(f.managed.approval(w.approval.id).state, path).toBe('pending');
  }
  const none = fixture();
  const w = none.write('runs/run_abc12345/answer.md');
  (none.station as any).answerFromGrant(w.operation.id, none.session.id, w.args);
  expect(none.managed.approval(w.approval.id).state).toBe('pending');
});

test('a grant for another task, plan revision or a settled task answers nothing', () => {
  for (const change of [
    { task_id: randomUUID() },
    { plan_revision: 2 },
    { task_state: 'cancelled' },
  ]) {
    const f = fixture();
    f.grant();
    Object.assign(f.scope, change);
    const w = f.write('runs/run_abc12345/answer.md');
    (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
    expect(f.managed.approval(w.approval.id).state, JSON.stringify(change)).toBe('pending');
  }
});

// Approval scopes B part 2: an agent's standing rule answers a workspace write anywhere in the
// workspace, except deletes and hidden paths, while the rule is pinned and not revoked.
test('a standing rule answers a workspace write and records which rule allowed it', () => {
  const f = fixture();
  const id = randomUUID();
  f.rules.push({ id, scope: 'workspace-write', set_by: 'prn_owner' });
  const w = f.write('src/app.js');
  (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
  expect(f.managed.approval(w.approval.id)).toMatchObject({
    state: 'decided',
    decision: 'approve',
    decided_by: 'rule:' + id,
  });
  const event = f.store.db
    .prepare("SELECT payload FROM events WHERE kind='permission.auto-approved'")
    .get()!;
  expect(JSON.parse(String(event.payload))).toMatchObject({
    rule: 'agent-rule',
    rule_id: id,
    set_by: 'prn_owner',
  });
});

test('a standing rule never answers a delete or a hidden path, and a revoked rule answers nothing', () => {
  const f = fixture();
  f.rules.push({ id: randomUUID(), scope: 'workspace-write', set_by: 'prn_owner' });
  for (const [path, content] of [
    ['src/app.js', null],
    ['.env', 'x'],
    ['src/.git/config', 'x'],
  ] as const) {
    const w = f.write(path, content);
    (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
    expect(f.managed.approval(w.approval.id).state, path).toBe('pending');
  }
  f.rules.length = 0;
  const w = f.write('src/app.js');
  (f.station as any).answerFromGrant(w.operation.id, f.session.id, w.args);
  expect(f.managed.approval(w.approval.id).state).toBe('pending');
});
