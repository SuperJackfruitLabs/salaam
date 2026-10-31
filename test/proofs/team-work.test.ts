import { test, expect } from 'vitest';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { digest } from '../../src/protocol.js';
import type { TeamAssignment } from '../../src/team-work.js';
import { PtyClient } from '../terminal-helpers.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function setup() {
  const f = await taskFixture({
    extensionPath: join(ROOT, 'test/fixtures/specialist-extension.mjs'),
  });
  for (const id of ['salaam/explorer', 'salaam/reviewer']) {
    const p = f.service.agents.inspect(f.session.id, id);
    await f.service.agents.admit(f.session.id, 'admit-' + id, id, digest(p), [], f.actor);
  }
  const plan = checkedPlan(3);
  plan.steps[1]!.depends_on = [];
  plan.steps[2]!.depends_on = ['step-0', 'step-1'];
  const t = await f.plan(plan);
  const assignments: TeamAssignment[] = [];
  for (const [i, step] of t.steps.entries()) {
    const current = await f.task();
    assignments.push(
      await f.action('team/assign', {
        step_id: step.id,
        profile_id: i === 1 ? 'salaam/reviewer' : 'salaam/explorer',
        requests: 2,
        expected_revision: current.revision,
      }),
    );
  }
  return { f, assignments };
}
test('team claims fan out two predecessors and fence synthesis until review; saved retries do not dispatch twice', async () => {
  const {
    f,
    assignments: [a, b, c],
  } = await setup();
  try {
    const run = (row: TeamAssignment, request: string) =>
      f.action<TeamAssignment>(`team/${row.id}/run`, { request_id: request, generation: 0 });
    await expect(run(c!, 'too-early')).rejects.toThrow('predecessor');
    const before = await f.task();
    const first = await run(a!, 'first');
    const second = await run(b!, 'second');
    await until(
      () => f.service.children.list(f.session.id),
      (cs) => cs.length === 2 && cs.every((x) => x.state === 'completed'),
      20000,
    );
    const firstChild = f.service.children.inspect(f.session.id, first.child_id!);
    expect(firstChild.worker!.binding.assignment).toEqual({ id: a!.id, generation: 1 });
    expect(firstChild.worker!.binding.tools).toContain('salaam_team');
    expect((await f.task()).steps.slice(0, 2).map((s) => s.state)).toEqual([
      'awaiting_review',
      'awaiting_review',
    ]);
    await expect(run(c!, 'still-early')).rejects.toThrow('predecessor');
    expect(
      f.service.team.run(a!.id, 'first', before.revision, 0, null, null, {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(first);
    expect(f.service.children.list(f.session.id)).toHaveLength(2);
    const message = await f.action<{ id: string }>('team/send', {
      recipient: c!.id,
      text: 'Compare both saved reports. Do not claim task success.',
    });
    expect(f.service.children.list(f.session.id)).toHaveLength(2);
    await expect(f.action(`team/${c!.id}/ack`, { message_id: message.id })).rejects.toThrow(
      'Receive',
    );
    const delivered = await f.action<any[]>(`team/${c!.id}/receive`);
    expect(delivered[0]).toMatchObject({ id: message.id, acknowledged_at: null });
    await f.action(`team/${c!.id}/ack`, { message_id: message.id });
    await f.review(0);
    await f.review(1);
    const third = await run(c!, 'third');
    await f.settled(2);
    expect(third.generation).toBe(1);
    expect(second.child_id).not.toBe(first.child_id);
    const state = await f.task();
    expect(state.state).not.toBe('succeeded');
    expect(state.runtime.requests_spent).toBe(6);
    expect(
      f.service.store.db
        .prepare('SELECT count(*) AS n FROM usage_observations WHERE session_id=?')
        .get(f.session.id)!.n,
    ).toBe(0);
    await f.restart();
    expect(f.service.team.get(c!.id)).toEqual(third);
    expect(await f.action(`team/${c!.id}/receive`)).toEqual([]);
    expect(f.service.children.list(f.session.id)).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 30000);

test('daemon restart interrupts an active claim without replay and exact explicit continuation advances only its generation', async () => {
  const {
    f,
    assignments: [a],
  } = await setup();
  try {
    writeFileSync(join(f.source, 'hold-specialists'), 'hold');
    const started = await f.action<TeamAssignment>(`team/${a!.id}/run`, {
      request_id: 'initial',
      generation: 0,
    });
    const child = f.service.children.inspect(f.session.id, started.child_id!);
    await until(() => existsSync(join(f.source, 'evidence-' + child.child_session)), Boolean);
    await f.restart();
    const interrupted = await f.task();
    expect(interrupted.steps[0]!.state).toBe('interrupted');
    expect(f.service.team.get(a!.id).generation).toBe(1);
    expect(f.service.children.list(f.session.id)).toHaveLength(1);
    await expect(
      f.action(`team/${a!.id}/run`, {
        generation: 0,
        instruction: 'Continue',
        continues_attempt_id: child.child_attempt,
      }),
    ).rejects.toThrow('generation');
    await expect(
      f.action(`team/${a!.id}/run`, { generation: 1, instruction: 'Continue' }),
    ).rejects.toThrow('exact interrupted');
    writeFileSync(join(f.source, 'release-specialists'), 'release');
    const resumed = await f.action<TeamAssignment>(`team/${a!.id}/run`, {
      generation: 1,
      instruction: 'Inspect the same step again after the confirmed stop',
      continues_attempt_id: child.child_attempt,
    });
    await f.settled(0);
    expect(resumed.generation).toBe(2);
    expect(resumed.child_id).not.toBe(child.id);
    expect(f.service.store.attempt(child.child_attempt).resolved_by).toBe(
      f.service.children.inspect(f.session.id, resumed.child_id!).child_attempt,
    );
    expect(() => f.service.team.assert(child.worker!.binding)).toThrow('claim');
  } finally {
    await f.close();
  }
});

test('bounded task driver runs assigned steps without dispatching the parent or inventing fresh check evidence', async () => {
  const { f } = await setup();
  try {
    await f.action('auto', { max_steps: 3 });
    const final = await until(
      f.task,
      (t) => t.state === 'succeeded' || !!t.runtime.auto_error,
      20000,
    );
    expect(final.runtime.auto_error).toBeNull();
    expect(final.state).toBe('succeeded');
    expect(final.steps.every((s) => s.state === 'completed')).toBe(true);
    expect(f.service.children.list(f.session.id)).toHaveLength(3);
    expect(final.verification.checks).toBeDefined();
    expect(final.runtime.requests_spent).toBe(6);
    const grants = f.service.store.db
      .prepare('SELECT id FROM task_grants WHERE task_id=?')
      .all(final.id);
    expect(grants).toHaveLength(3);
    for (const grant of grants)
      expect(() => f.service.taskWork.advance(String(grant.id))).not.toThrow();
    expect(f.service.children.list(f.session.id)).toHaveLength(3);
  } finally {
    await f.close();
  }
});

test('failed executor evidence blocks the team even when every native model reports completion', async () => {
  const { f } = await setup();
  try {
    f.backend.exitOverride = 1;
    await f.action('auto', { max_steps: 3 });
    const stopped = await until(f.task, (t) => !!t.runtime.auto_error, 20000);
    expect(stopped.runtime.auto_error).toContain('Verification failed');
    expect(stopped.state).not.toBe('succeeded');
    expect(stopped.steps[2]!.state).toBe('pending');
    expect(f.service.children.list(f.session.id)).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('restart after a committed team intent interrupts the step even if no worker process was launched', async () => {
  const {
    f,
    assignments: [a],
  } = await setup();
  try {
    const launch = f.service.children.launchPrepared;
    f.service.children.launchPrepared = () => {};
    const claimed = await f.action<TeamAssignment>(`team/${a!.id}/run`, { generation: 0 });
    f.service.children.launchPrepared = launch;
    const child = f.service.children.inspect(f.session.id, claimed.child_id!);
    expect(child.worker!.dispatch_state).toBe('intent');
    expect(f.service.store.session(child.child_session).epoch).toBe(0);
    await f.restart();
    expect((await f.task()).steps[0]!.state).toBe('interrupted');
    expect(f.service.children.inspect(f.session.id, child.id).state).toBe('interrupted');
    expect(f.service.store.session(child.child_session).epoch).toBe(0);
    expect(f.service.team.get(a!.id)).toEqual(claimed);
    expect(f.service.children.list(f.session.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('plan changes require fresh assignment admission while preserving superseded assignment and message identities', async () => {
  const {
    f,
    assignments: [a],
  } = await setup();
  try {
    await f.action('team/send', { recipient: a!.id, text: 'Message for the original plan.' });
    const plan = checkedPlan(3);
    plan.objective = 'Revised repository investigation';
    plan.steps[1]!.depends_on = [];
    plan.steps[2]!.depends_on = ['step-0', 'step-1'];
    await f.action('revise', { plan });
    await expect(f.action(`team/${a!.id}/run`, { generation: 0 })).rejects.toThrow(
      'plan or generation',
    );
    const replacement = await f.action<TeamAssignment>('team/assign', {
      step_id: a!.step_id,
      profile_id: a!.profile_id,
      requests: 2,
    });
    expect(replacement.id).not.toBe(a!.id);
    expect(f.service.team.get(a!.id).superseded).toBe(1);
    expect((await f.action<any[]>(`team/${a!.id}/receive`))[0]!.text).toContain('original plan');
    expect(await f.action(`team/${replacement.id}/receive`)).toEqual([]);
    await f.action(`team/${replacement.id}/run`, { generation: 0 });
    await f.settled();
    expect(f.service.team.get(a!.id).generation).toBe(0);
    expect(f.service.children.list(f.session.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('passive inbox backpressure, changed request conflicts, and cancellation preserve the same claim without waking work', async () => {
  const {
    f,
    assignments: [a, b],
  } = await setup();
  try {
    const t = await f.task(),
      authorize = () => f.service.store.authorizeControl(f.session.id, f.actor);
    const saved = f.service.team.send(
      t.id,
      'operator',
      b!.id,
      'bounded passive message',
      'same-message',
      authorize,
    );
    expect(
      f.service.team.send(
        t.id,
        'operator',
        b!.id,
        'bounded passive message',
        'same-message',
        () => {
          throw new Error('expired');
        },
      ),
    ).toEqual(saved);
    expect(() =>
      f.service.team.send(t.id, 'operator', b!.id, 'changed', 'same-message', authorize),
    ).toThrow('different');
    for (let n = 1; n < 32; n++)
      f.service.team.send(t.id, 'operator', b!.id, 'message ' + n, 'message-' + n, authorize);
    expect(() =>
      f.service.team.send(t.id, 'operator', b!.id, 'overflow', 'overflow', authorize),
    ).toThrow('quota');
    expect(f.service.children.list(f.session.id)).toEqual([]);
    writeFileSync(join(f.source, 'hold-specialists'), 'hold');
    const claim = await f.action<TeamAssignment>(`team/${a!.id}/run`, { generation: 0 });
    const child = f.service.children.inspect(f.session.id, claim.child_id!);
    await until(() => existsSync(join(f.source, 'evidence-' + child.child_session)), Boolean);
    await f.action('cancel');
    await until(
      () => f.service.children.inspect(f.session.id, child.id),
      (c) => c.state === 'cancelled',
    );
    expect(f.service.store.cancelled(child.child_attempt)).toBe(true);
    expect(f.service.team.get(a!.id).generation).toBe(1);
    expect(f.service.team.get(b!.id).generation).toBe(0);
    await expect(f.action(`team/${b!.id}/run`, { generation: 0 })).rejects.toThrow('no longer');
  } finally {
    await f.close();
  }
});

test('installed entry points and a real terminal show the same durable team board and passive inbox', async () => {
  const {
    f,
    assignments: [a],
  } = await setup();
  let terminal: PtyClient | undefined;
  try {
    const task = await f.task();
    await f.action('team/send', { recipient: a!.id, text: 'Wait for an explicit claim.' });
    const cli = await promisify(execFile)(process.execPath, [
      join(ROOT, 'bin/salaam.mjs'),
      'team',
      'show',
      task.id,
      '--state',
      f.state,
    ]);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      task_id: task.id,
      assignments: expect.arrayContaining([expect.objectContaining({ id: a!.id, generation: 0 })]),
      messages: [{ delivered_at: null, acknowledged_at: null }],
    });
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--observe',
        '--state',
        f.state,
      ],
      { state: f.state, columns: 128, rows: 64 },
    );
    await terminal.contains('S A L A A M');
    await terminal.write('\t\t\t');
    await terminal.contains('TEAM BOARD');
    await terminal.contains('salaam/explorer');
    await terminal.contains('claim 0');
    await terminal.contains('stored');
    expect(f.service.children.list(f.session.id)).toEqual([]);
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);
