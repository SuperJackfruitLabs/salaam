import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import type { AgentPodWork } from '../../src/agentpod-work.js';
import { AgentPodWorkDecisions, approvalDetail } from '../../src/agentpod-work-decisions.js';
import { RunGrants } from '../../src/run-grants.js';
import { workDecision, workDecisionAnswer } from '../../src/agentpod-work-decision-protocol.js';
import { digest } from '../../src/protocol.js';
const corpus = JSON.parse(
  readFileSync(new URL('../fixtures/agentpod-work-decision-v1.json', import.meta.url), 'utf8'),
);
test('canonical AgentPod decision fixture and closed schema agree', () => {
  expect(workDecision(corpus.decision)).toEqual(corpus.decision);
  expect(digest(corpus.decision)).toBe(corpus.decision_digest);
  for (const value of [
    { ...corpus.decision, version: 2 },
    { ...corpus.decision, extra: true },
    { ...corpus.decision, plan_revision: 0 },
    { ...corpus.decision, options: [...corpus.decision.options].reverse() },
  ])
    expect(() => workDecision(value)).toThrow();
  const answer = {
    version: 1,
    request_id: randomUUID(),
    decision: corpus.decision,
    decision_digest: corpus.decision_digest,
    elicitation_id: 'elc_123456',
    option_id: 'approve',
    answered_by: 'principal',
    answered_at: new Date().toISOString(),
  };
  expect(workDecisionAnswer(answer)).toEqual(answer);
  expect(() => workDecisionAnswer({ ...answer, extra: true })).toThrow();
});
test('private decision exact replay is atomic with existing permission, rejects drift and never executes twice', async () => {
  const store = new Store(':memory:'),
    session = store.create('/tmp', 'create'),
    submission = store.accept(session.id, 'submit', session.revision, 'Test'),
    epoch = store.allocate(session.id, 'boot');
  store.state(session.id, epoch, 'ready');
  store.claim(session.id, epoch);
  store.running(submission.attempt_id);
  let active = true,
    revision = 1;
  const managed = new ManagedWork(store, {
    assertActive: () => {
      if (!active) throw Error('revoked');
    },
    assertMcpOperation: () => {},
    reply: () => {},
    failed: () => {},
  });
  const binding = { fixture: 'private authority' },
    task = { id: randomUUID(), plan_revision: revision };
  store.db.exec(
    'CREATE TABLE agentpod_work(session_id TEXT,task_id TEXT,request_id TEXT,admission_json TEXT)',
  );
  store.db
    .prepare('INSERT INTO agentpod_work VALUES (?,?,?,?)')
    .run(session.id, task.id, randomUUID(), JSON.stringify({ binding }));
  const work = {
    store,
    authority: {
      inspect: (v: unknown) => {
        if (JSON.stringify(v) !== JSON.stringify(binding)) throw Error('foreign root');
        return { session_id: session.id, binding };
      },
    },
    tasks: { get: () => ({ ...task, plan_revision: revision }) },
  } as unknown as AgentPodWork;
  const controller = new AgentPodWorkDecisions(work, managed);
  try {
    const first = await managed.prepareMcp(
      session.id,
      epoch,
      submission.attempt_id,
      'call',
      'library/fixture',
      '{}',
      'a'.repeat(64),
    );
    const offer = controller.list(binding).decisions[0]!;
    // Readable approvals: the offer says what is being approved, not only its digest.
    expect(offer.detail).toMatchObject({
      version: 1,
      digest: first.operation.operation_digest,
      files: [],
    });
    expect(offer.detail!.summary).toContain('library/fixture');
    expect(offer.question).not.toMatch(/^Approve this exact operation\? mcp/);
    expect(controller.list(binding).decisions[0]).toEqual(offer);
    const answer = {
      version: 1,
      request_id: randomUUID(),
      decision: offer,
      decision_digest: digest(offer),
      elicitation_id: 'elc_123456',
      option_id: 'approve',
      answered_by: 'principal',
      answered_at: new Date().toISOString(),
    };
    revision = 2;
    expect(() => controller.answer(binding, answer)).toThrow('plan');
    revision = 1;
    expect(() =>
      controller.answer(binding, {
        ...answer,
        decision: { ...offer, operation_digest: 'b'.repeat(64) },
      }),
    ).toThrow('saved');
    const receipt = controller.answer(binding, answer);
    expect(receipt.decision).toBe('approve');
    expect(managed.operation(first.operation.id).state).toBe('prepared');
    active = false;
    expect(controller.answer(binding, answer)).toEqual(receipt);
    expect(() => controller.answer(binding, { ...answer, request_id: randomUUID() })).toThrow();
    expect(() => controller.answer({ other: true }, answer)).toThrow('foreign');
    active = true;
    expect(managed.takePermission(first.operation.id)).toBe(true);
    expect(managed.takePermission(first.operation.id)).toBe(false);
    expect(
      store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='approval.decided'").get()!.n,
    ).toBe(1);
  } finally {
    await managed.close();
    store.close();
  }
});

// The operation's own canonical arguments are the only source: path, change, size, preview, reason.
const digest64 = 'd'.repeat(64);
const op = (value: Record<string, unknown>, kind = 'workspace') =>
  ({
    kind,
    action_key: 'k',
    target: 'station:' + String(value.path),
    value: JSON.stringify(value),
    operation_digest: digest64,
  }) as never;
test('a workspace write reads as a plain-words approval: create, edit and delete', () => {
  const content = '# RFC 9110: 502 Bad Gateway\n' + 'x'.repeat(5000);
  const created = approvalDetail(
    op({
      action: 'patch',
      path: 'runs/r/answer.md',
      expected_hash: null,
      content,
      expected_tree: digest64,
      reason: 'Write the quoted sentence.',
    }),
  );
  expect(created).toEqual({
    version: 1,
    summary: 'Create runs/r/answer.md in the workspace',
    reason: 'Write the quoted sentence.',
    files: [
      {
        path: 'runs/r/answer.md',
        change: 'create',
        bytes: Buffer.byteLength(content),
        preview: content.slice(0, 1200),
      },
    ],
    digest: digest64,
  });
  const edited = approvalDetail(
    op({
      action: 'patch',
      path: 'a.md',
      expected_hash: digest64,
      content: 'new',
      expected_tree: digest64,
    }),
  );
  expect(edited.summary).toBe('Edit a.md in the workspace');
  expect(edited.reason).toBeNull();
  expect(edited.files[0]).toMatchObject({ change: 'edit', bytes: 3, preview: 'new' });
  const deleted = approvalDetail(
    op({
      action: 'patch',
      path: 'old.md',
      expected_hash: digest64,
      content: null,
      expected_tree: digest64,
    }),
  );
  expect(deleted.summary).toBe('Delete old.md in the workspace');
  expect(deleted.files[0]).toMatchObject({ change: 'delete', bytes: null, preview: null });
});
test('a reason is one line of at most 300 characters, and a review reads as one', () => {
  const long = approvalDetail(
    op({
      action: 'patch',
      path: 'a.md',
      expected_hash: null,
      content: 'x',
      expected_tree: digest64,
      reason: 'line one\nline two ' + 'y'.repeat(400),
    }),
  );
  expect(long.reason).toBe(('line one line two ' + 'y'.repeat(400)).slice(0, 300));
  expect(approvalDetail(op({}, 'review')).summary).toBe('Accept this step for review');
});
test('the decision schema accepts a detail and refuses a malformed one', () => {
  const detail = approvalDetail(
    op({
      action: 'patch',
      path: 'a.md',
      expected_hash: null,
      content: 'x',
      expected_tree: digest64,
    }),
  );
  expect(workDecision({ ...corpus.decision, detail }).detail).toEqual(detail);
  for (const bad of [
    { ...detail, version: 2 },
    { ...detail, digest: 'x' },
    { ...detail, extra: true },
    { ...detail, files: [{ ...detail.files[0], change: 'rename' }] },
    { ...detail, summary: '' },
  ])
    expect(() => workDecision({ ...corpus.decision, detail: bad })).toThrow();
});

// "Approve for this run" (approval scopes B): offered only for a write inside the run's directory.
function grantFixture() {
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
      fixture: 'private authority',
      run: { source: 'superpipeline', id: 'run_abc12345', epoch: 1 },
    },
    task = { id: randomUUID(), plan_revision: 1, state: 'running' };
  store.db.exec(
    'CREATE TABLE agentpod_work(session_id TEXT,task_id TEXT,request_id TEXT,admission_json TEXT)',
  );
  store.db
    .prepare('INSERT INTO agentpod_work VALUES (?,?,?,?)')
    .run(session.id, task.id, randomUUID(), JSON.stringify({ binding }));
  const work = {
    store,
    authority: { inspect: () => ({ session_id: session.id, binding }) },
    tasks: { get: () => task },
  } as unknown as AgentPodWork;
  const grants = new RunGrants(store);
  const controller = new AgentPodWorkDecisions(work, managed, grants);
  let n = 0;
  const write = (path: string, content: string | null = 'answer') =>
    store.transaction(() =>
      (managed as any).insertPrepared(
        session.id,
        epoch,
        submission.attempt_id,
        'call-' + ++n,
        'workspace',
        'station:' + path,
        JSON.stringify({
          action: 'patch',
          path,
          content,
          expected_hash: content === null ? 'e'.repeat(64) : null,
          expected_tree: 'a'.repeat(64),
        }),
        'a'.repeat(64),
      ),
    );
  const answer = (offer: any, option: string) => ({
    version: 1,
    request_id: randomUUID(),
    decision: offer,
    decision_digest: digest(offer),
    elicitation_id: 'elc_123456',
    option_id: option,
    answered_by: 'prn_human',
    answered_at: new Date().toISOString(),
  });
  return { store, managed, controller, grants, binding, session, task, write, answer };
}
const offerFor = (f: ReturnType<typeof grantFixture>, operation: string) =>
  f.controller.list(f.binding).decisions.find((d: any) => d.operation_id === operation)!;

test('a write inside the run directory offers "Approve for this run" between approve and deny', () => {
  const f = grantFixture();
  const { operation } = f.write('runs/run_abc12345/answer.md');
  expect(offerFor(f, operation.id).options).toEqual([
    { id: 'approve', title: 'Approve once' },
    { id: 'approve-run', title: 'Approve for this run' },
    { id: 'deny', title: 'Deny' },
  ]);
  expect(workDecision(offerFor(f, operation.id))).toEqual(offerFor(f, operation.id));
});

test('a delete, a write outside the run directory or a hidden file offers only approve or deny', () => {
  const f = grantFixture();
  for (const [path, content] of [
    ['runs/run_abc12345/answer.md', null],
    ['answer.md', 'x'],
    ['runs/run_abc12345/.env', 'x'],
  ] as const) {
    const { operation } = f.write(path, content);
    expect(offerFor(f, operation.id).options.map((o: any) => o.id)).toEqual(['approve', 'deny']);
  }
});

test('answering "Approve for this run" approves this write and records the run grant', () => {
  const f = grantFixture();
  const { operation, approval } = f.write('runs/run_abc12345/answer.md');
  const receipt = f.controller.answer(f.binding, answer2(f, operation.id, 'approve-run'));
  expect(receipt).toMatchObject({ decision: 'approve-run', approval_id: approval.id });
  expect(f.managed.approval(approval.id)).toMatchObject({ state: 'decided', decision: 'approve' });
  const grant = f.grants.active({
    session_id: f.session.id,
    task_id: f.task.id,
    plan_revision: 1,
    binding_digest: digest(f.binding),
    task_state: 'running',
  });
  expect(grant).toMatchObject({
    path_prefix: 'runs/run_abc12345/',
    approval_id: approval.id,
    granted_by: 'prn_human',
  });
  expect((receipt as any).grant_id).toBe(grant!.id);
});

test('"Approve for this run" is refused where it was not offered', () => {
  const f = grantFixture();
  const { operation } = f.write('answer.md');
  expect(() => f.controller.answer(f.binding, answer2(f, operation.id, 'approve-run'))).toThrow();
  expect(f.store.db.prepare('SELECT count(*) AS n FROM run_grants').get()!.n).toBe(0);
});
function answer2(f: ReturnType<typeof grantFixture>, operation: string, option: string) {
  return f.answer(offerFor(f, operation), option);
}

test('deny stays deny, and records no grant', () => {
  const f = grantFixture();
  const { operation, approval } = f.write('runs/run_abc12345/answer.md');
  const receipt = f.controller.answer(f.binding, answer2(f, operation.id, 'deny'));
  expect(receipt).toMatchObject({ decision: 'deny' });
  expect(f.managed.approval(approval.id)).toMatchObject({ state: 'decided', decision: 'deny' });
  expect(f.store.db.prepare('SELECT count(*) AS n FROM run_grants').get()!.n).toBe(0);
});

test('an offer saved without "Approve for this run" cannot be answered with it, even for a covered write', () => {
  const f = grantFixture();
  const { operation, approval } = f.write('runs/run_abc12345/answer.md');
  const offer = offerFor(f, operation.id) as any;
  // The offer as it was saved before this option existed: approve or deny only.
  const older = { ...offer, options: [offer.options[0], offer.options[2]] };
  f.store.db
    .prepare("UPDATE requests SET response=? WHERE actor='agentpod-work-decision-offer' AND id=?")
    .run(JSON.stringify(older), approval.id);
  expect(() => f.controller.answer(f.binding, f.answer(older, 'approve-run'))).toThrow(
    'cannot cover the run',
  );
  expect(f.managed.approval(approval.id).state).toBe('pending');
});
