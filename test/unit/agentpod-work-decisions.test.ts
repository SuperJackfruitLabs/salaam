import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from '../../src/store.js';
import { ManagedWork } from '../../src/managed.js';
import type { AgentPodWork } from '../../src/agentpod-work.js';
import { AgentPodWorkDecisions } from '../../src/agentpod-work-decisions.js';
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
