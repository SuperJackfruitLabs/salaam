import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until, control } from '../helpers.js';
import { call } from '../../src/core/transport.js';
import { PtyClient } from '../terminal-helpers.js';
import { ROOT } from '../../src/core/config.js';
import { FixtureExternalBackend } from '../fixtures/external-backend.js';
import { digest } from '../../src/core/protocol.js';

async function setup(invocations?: number) {
  const backend = new FixtureExternalBackend(),
    f = await taskFixture({ externalBackend: backend });
  const profile = f.service.agents.inspect(f.session.id, 'salaam/builder');
  await f.service.agents.admit(
    f.session.id,
    'admit-builder',
    'salaam/builder',
    digest(profile),
    [],
    f.actor,
  );
  const plan = checkedPlan();
  const task = await f.plan(
    invocations === undefined ? plan : { ...plan, limits: { invocations, token_units: null } },
  );
  const assign = () =>
    f.action('team/assign', {
      step_id: task.steps[0]!.id,
      profile_id: 'salaam/builder',
      invocations: 1,
      runtime: 'fixture-acp',
    });
  return { f, backend, assign };
}
function decide(f: Awaited<ReturnType<typeof taskFixture>>, decision: 'approve' | 'deny') {
  const handler = () => {
    setImmediate(() => {
      for (const p of f.service.managed.pending()) {
        try {
          f.service.managed.decide(
            p.id,
            'operator:' + p.id,
            p.revision,
            p.operation_digest,
            decision,
          );
        } catch {}
      }
    });
  };
  f.service.store.changes.on('event', handler);
  return () => f.service.store.changes.off('event', handler);
}
test('default model/token budgets reject opaque assignments without changing the task graph or dispatching', async () => {
  const { f, backend, assign } = await setup();
  try {
    await expect(assign()).rejects.toThrow('explicit limits.invocations');
    expect(backend.calls).toEqual([]);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM team_assignments').get()!.n).toBe(
      0,
    );
  } finally {
    await f.close();
  }
});
test('external task claim uses shared approvals, one invocation and a stopped private draft; saved run replay never dispatches twice', async () => {
  const { f, backend, assign } = await setup(2);
  let off = () => {};
  try {
    const a = await assign();
    off = decide(f, 'approve');
    const before = await f.task();
    const first = await f.action(`team/${a.id}/run`, { request_id: 'one-run', generation: 0 });
    await f.settled();
    const child = f.service.children.inspect(f.session.id, first.child_id);
    expect(child.worker!.binding.runtime).toBe('harness');
    expect(child.worker!.binding.bounds).toEqual({ scope: 'invocations', invocations: 1 });
    expect(backend.calls).toHaveLength(1);
    expect(backend.commands).toBe(1);
    expect(f.service.external.stopped(child.id)).toBe(true);
    expect((await f.task()).runtime).toMatchObject({
      requests_spent: 0,
      invocations_spent: 1,
      external_model_usage: 'unknown',
    });
    expect(
      f.service.store.db
        .prepare("SELECT count(*) AS n FROM operations WHERE kind='harness' AND state='succeeded'")
        .get()!.n,
    ).toBe(2);
    expect(f.service.workerWorkspaces.proposal(f.session.id, child.id)).toMatchObject({
      verified_success: false,
    });
    expect(readFileSync(join(f.source, 'human.txt'), 'utf8')).toBe('pre-existing dirty work\n');
    expect(
      f.service.team.run(a.id, 'one-run', before.revision, 0, null, null, {
        client_id: 'expired',
        token: 'expired',
      }),
    ).toEqual(first);
    expect(backend.calls).toHaveLength(1);
    await expect(f.service.supervisor.start(child.child_session)).rejects.toThrow(
      'Pi cannot claim',
    );
  } finally {
    off();
    await f.close();
  }
});
test('denied permissions execute no tools and do not grant a later repeated decision', async () => {
  const { f, backend, assign } = await setup(1);
  const off = decide(f, 'deny');
  try {
    const a = await assign();
    await f.action(`team/${a.id}/run`, { generation: 0 });
    await f.settled();
    expect(backend.commands).toBe(0);
    const op = f.service.store.db.prepare("SELECT id FROM operations WHERE kind='harness'").get()!;
    expect(f.service.managed.takePermission(String(op.id))).toBe(false);
    expect(f.service.managed.operation(String(op.id)).state).toBe('cancelled_before_dispatch');
  } finally {
    off();
    await f.close();
  }
});
test('daemon restart invalidates pending approval and preserves uncertain dispatch without replay; continuation consumes a fresh explicit invocation', async () => {
  const { f, backend, assign } = await setup(2);
  let off = () => {};
  try {
    const a = await assign();
    const first = await f.action(`team/${a.id}/run`, { request_id: 'first', generation: 0 });
    await until(
      () => f.service.managed.pending(),
      (ps) => ps.length === 1,
    );
    const pending = f.service.managed.pending()[0]!;
    const child = f.service.children.inspect(f.session.id, first.child_id);
    await f.restart();
    expect(backend.calls).toHaveLength(1);
    expect((await f.task()).steps[0]!.state).toBe('interrupted');
    expect(f.service.managed.approval(pending.id).state).toBe('invalidated');
    await expect(
      f.action(`team/${a.id}/run`, { generation: 1, instruction: 'Continue explicitly' }),
    ).rejects.toThrow('exact interrupted');
    off = decide(f, 'approve');
    await f.action(`team/${a.id}/run`, {
      generation: 1,
      instruction: 'Continue explicitly',
      continues_attempt_id: child.child_attempt,
    });
    await f.settled();
    expect(backend.calls).toHaveLength(2);
    expect((await f.task()).runtime.invocations_spent).toBe(2);
  } finally {
    off();
    await f.close();
  }
});
test('an unconfirmed stop retains its slot and blocks continuation until explicit owned-run reconciliation', async () => {
  const { f, backend, assign } = await setup(2);
  const off = decide(f, 'deny');
  try {
    backend.stopFails = true;
    const a = await assign(),
      first = await f.action(`team/${a.id}/run`, { generation: 0 });
    const child = await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state === 'interrupted',
    );
    expect(f.service.external.stopped(child.id)).toBe(false);
    expect(f.service.children.activeCount(f.session.id)).toBe(1);
    expect(f.service.taskBudget.active(f.service.taskWork.get(a.task_id))).toBe(1);
    await expect(
      f.action(`team/${a.id}/run`, {
        generation: 1,
        instruction: 'Continue',
        continues_attempt_id: child.child_attempt,
      }),
    ).rejects.toThrow('Confirm the previous process stopped');
    backend.stopFails = false;
    const run = String(f.service.external.row(child.id).run_id);
    await f.service.external.reconcile(child, 'confirm-stop', run, () =>
      f.service.store.authorizeControl(f.session.id, f.actor),
    );
    expect(f.service.external.stopped(child.id)).toBe(true);
    await f.service.external.reconcile(child, 'confirm-stop', run, () => {
      throw Error('Saved request must precede fresh authorization');
    });
    expect(backend.calls).toHaveLength(1);
    await f.action(`team/${a.id}/run`, {
      generation: 1,
      instruction: 'Continue',
      continues_attempt_id: child.child_attempt,
    });
    await f.settled();
    expect(backend.calls).toHaveLength(2);
  } finally {
    backend.stopFails = false;
    off();
    await f.close();
  }
});
test('runtime changes reject a fresh claim before allocating an invocation or a child', async () => {
  const { f, backend, assign } = await setup(1);
  try {
    const a = await assign();
    backend.runtime.config_digest = digest('changed');
    await expect(f.action(`team/${a.id}/run`, { generation: 0 })).rejects.toThrow(
      'configuration changed',
    );
    expect(backend.calls).toHaveLength(0);
    expect(f.service.children.list(f.session.id)).toHaveLength(0);
    expect((await f.task()).runtime.invocations_spent).toBe(0);
  } finally {
    await f.close();
  }
});
test('gateway admissions are durable and separately capped; failed invocations retain their charge without spending native requests', async () => {
  let admissions = 0;
  const backend = new FixtureExternalBackend();
  backend.runtime.max_model_requests = 2;
  backend.modelCalls = 3;
  const f = await taskFixture({
    externalBackend: backend,
    admitModelRequest: () => {
      admissions++;
    },
  });
  try {
    const p = f.service.agents.inspect(f.session.id, 'salaam/builder');
    await f.service.agents.admit(f.session.id, 'builder', 'salaam/builder', digest(p), [], f.actor);
    const t = await f.plan({
      ...checkedPlan(),
      limits: { requests: 1, invocations: 1, token_units: null },
    });
    const a = await f.action('team/assign', {
      step_id: t.steps[0]!.id,
      profile_id: 'salaam/builder',
      runtime: 'fixture-acp',
      invocations: 1,
    });
    const first = await f.action(`team/${a.id}/run`, { generation: 0 });
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state === 'interrupted',
    );
    expect(admissions).toBe(2);
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM external_model_requests').get()!.n,
    ).toBe(2);
    expect((await f.task()).runtime).toMatchObject({ invocations_spent: 1, requests_spent: 0 });
    await f.restart();
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM external_model_requests').get()!.n,
    ).toBe(2);
    const child = f.service.children.inspect(f.session.id, first.child_id);
    await expect(
      f.action(`team/${a.id}/run`, {
        generation: 1,
        instruction: 'Continue',
        continues_attempt_id: child.child_attempt,
      }),
    ).rejects.toThrow('invocation allowance exhausted');
    expect(backend.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('selected external attempt cancellation stops only its owned transport and generic prompt endpoints cannot take it over', async () => {
  const { f, backend, assign } = await setup(1);
  try {
    backend.hold = true;
    const a = await assign(),
      first = await f.action(`team/${a.id}/run`, { generation: 0 });
    await until(
      () => backend.calls.length,
      (n) => n === 1,
    );
    const child = f.service.children.inspect(f.session.id, first.child_id),
      actor = await control(f.service, child.child_session);
    await expect(
      call(f.service.socket, `/v1/sessions/${child.child_session}/submissions`, {
        ...actor,
        request_id: 'bypass',
        expected_revision: f.service.store.session(child.child_session).revision,
        text: 'Start unrelated work',
      }),
    ).rejects.toThrow('owning team assignment');
    await call(f.service.socket, `/v1/attempts/${child.child_attempt}/cancel`, {
      ...actor,
      request_id: 'stop',
      expected_revision: f.service.store.session(child.child_session).revision,
    });
    await until(
      () => f.service.children.inspect(f.session.id, child.id),
      (c) => c.state === 'cancelled',
    );
    expect(f.service.external.stopped(child.id)).toBe(true);
    expect(backend.calls).toHaveLength(1);
    expect([...backend.runs.values()].every((r) => r.stopped)).toBe(true);
  } finally {
    await f.close();
  }
});
test('required-control persistence failure still stops the owned runtime and denies a pending late approval', async () => {
  const { f, backend, assign } = await setup(1);
  try {
    const a = await assign(),
      first = await f.action(`team/${a.id}/run`, { generation: 0 });
    const pending = (
      await until(
        () => f.service.managed.pending(),
        (a) => a.length === 1,
      )
    )[0]!;
    const child = f.service.children.inspect(f.session.id, first.child_id),
      original = f.service.store.transaction.bind(f.service.store);
    let once = false;
    f.service.store.transaction = (fn) => {
      if (!once) {
        once = true;
        throw Error('simulated required-control write failure');
      }
      return original(fn);
    };
    try {
      expect(() =>
        f.service.external.failControl(child.child_session, Error('control lost')),
      ).toThrow('write failure');
    } finally {
      f.service.store.transaction = original;
    }
    await until(
      () => f.service.children.inspect(f.session.id, child.id),
      (c) => c.state === 'interrupted',
    );
    expect(f.service.external.stopped(child.id)).toBe(true);
    expect(backend.commands).toBe(0);
    expect(() =>
      f.service.managed.decide(
        pending.id,
        'late',
        pending.revision,
        pending.operation_digest,
        'approve',
      ),
    ).toThrow();
  } finally {
    await f.close();
  }
});
test('a real terminal shows external invocation scope and stop state on the shared Salaam team board', async () => {
  const { f, backend, assign } = await setup(1);
  let terminal: PtyClient | undefined;
  try {
    backend.hold = true;
    const a = await assign();
    await f.action(`team/${a.id}/run`, { generation: 0 });
    await until(
      () => backend.calls.length,
      (n) => n === 1,
    );
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
      { state: f.state, columns: 144, rows: 64 },
    );
    await terminal.contains('S A L A A M');
    await terminal.write('\t\t\t');
    await terminal.contains('TEAM BOARD');
    await terminal.contains('fixture-acp');
    await terminal.contains('model usage unknown');
    await terminal.contains('stop unconfirmed');
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
    await f.action('cancel');
    expect([...backend.runs.values()].every((r) => r.stopped)).toBe(true);
  } finally {
    await terminal?.close();
    await f.close();
  }
});
test('setup and history phases cannot consume a model grant before a durable prompt dispatch', async () => {
  const { f, backend, assign } = await setup(1);
  try {
    backend.warmup = true;
    const a = await assign(),
      first = await f.action(`team/${a.id}/run`, { generation: 0 });
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state === 'interrupted',
    );
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM external_model_requests').get()!.n,
    ).toBe(0);
    expect((await f.task()).runtime.invocations_spent).toBe(1);
  } finally {
    await f.close();
  }
});
test('a shared required-control failure stops every owned external worker and fences fresh assignments', async () => {
  const { f, backend, assign } = await setup(1);
  try {
    backend.hold = true;
    const a = await assign(),
      first = await f.action(`team/${a.id}/run`, { generation: 0 });
    await until(
      () => backend.calls.length,
      (n) => n === 1,
    );
    f.service.external.failAll(Error('shared control unavailable'));
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state === 'interrupted',
    );
    expect(f.service.external.status().available).toBe(false);
    expect([...backend.runs.values()].every((r) => r.stopped)).toBe(true);
    expect(() =>
      f.service.external.validateAssignment(a.id, f.service.taskWork.get(a.task_id)),
    ).toThrow('control is unavailable');
  } finally {
    await f.close();
  }
});
