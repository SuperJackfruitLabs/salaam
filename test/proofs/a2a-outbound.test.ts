import { test, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { sdkPeer } from '../fixtures/a2a-peer.js';
import { A2ABackend } from '../../src/a2a-backend.js';
import { digest } from '../../src/protocol.js';
import { until } from '../helpers.js';

async function setup() {
  const peer = await sdkPeer(),
    config = join(peer.dir, 'peers.json');
  writeFileSync(config, JSON.stringify({ schema: 1, peers: [peer.peer] }), { mode: 0o600 });
  const backend = new A2ABackend(config),
    f = await taskFixture({ externalBackend: backend });
  const profile = f.service.agents.inspect(f.session.id, 'salaam/reviewer');
  await f.service.agents.admit(
    f.session.id,
    'reviewer',
    'salaam/reviewer',
    digest(profile),
    [],
    f.actor,
  );
  const task = await f.plan({ ...checkedPlan(), limits: { invocations: 2, token_units: null } }),
    assignment = await f.action('team/assign', {
      step_id: task.steps[0]!.id,
      profile_id: 'salaam/reviewer',
      runtime: 'sdk',
      invocations: 1,
    });
  return { peer, f, assignment };
}
test('outbound SDK task uses the shared claim/invocation ledger and exports only explicitly selected immutable files', async () => {
  const { peer, f, assignment } = await setup();
  try {
    const first = await f.action(`team/${assignment.id}/run`, {
      request_id: 'remote-once',
      generation: 0,
    });
    await f.settled();
    const child = f.service.children.inspect(f.session.id, first.child_id),
      view = f.service.external.view(child.id) as any;
    expect(child.state).toBe('completed');
    expect(child.worker!.binding.capabilities).toMatchObject({
      files: false,
      commands: false,
      model_requests: false,
      isolation: 'remote-peer-no-local-tool-authority',
    });
    expect(view.checkpoint).toMatchObject({
      dialect: 'a2a',
      peer_id: 'sdk',
      task_id: 'sdk-task-1',
      state: 'terminal',
    });
    expect(view.result.verified_success).toBe(false);
    const parts = peer.requests.find((r) => r.method === 'SendMessage').params.message.parts;
    expect(parts[1].data.files).toEqual({ 'app.js': 'export const answer = 42;\n' });
    expect(JSON.stringify(parts)).not.toContain('pre-existing dirty work');
    expect(readFileSync(join(f.source, 'human.txt'), 'utf8')).toBe('pre-existing dirty work\n');
    expect((await f.task()).runtime).toMatchObject({
      requests_spent: 0,
      invocations_spent: 1,
      external_model_usage: 'unknown',
    });
    await f.restart();
    expect(f.service.external.stopped(child.id)).toBe(true);
    expect(peer.accepted).toBe(1);
    expect((await f.task()).state).not.toBe('succeeded');
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM external_model_requests').get()!.n,
    ).toBe(0);
  } finally {
    await f.close();
    await peer.close();
  }
});
test('lost remote acceptance holds the slot across daemon reopen and rejects another generation without a second send', async () => {
  const { peer, f, assignment } = await setup();
  peer.lost = true;
  try {
    const first = await f.action(`team/${assignment.id}/run`, { generation: 0 });
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state !== 'accepted',
    );
    const child = f.service.children.inspect(f.session.id, first.child_id);
    expect(child.state).toBe('interrupted');
    expect(f.service.external.stopped(child.id)).toBe(false);
    expect(peer.accepted).toBe(1);
    peer.lost = false;
    await f.restart();
    expect(f.service.external.stopped(child.id)).toBe(false);
    await expect(
      f.action(`team/${assignment.id}/run`, {
        generation: 1,
        instruction: 'Try again',
        continues_attempt_id: child.child_attempt,
      }),
    ).rejects.toThrow('Confirm the previous');
    expect(peer.accepted).toBe(1);
    expect((await f.task()).runtime.invocations_spent).toBe(1);
  } finally {
    await f.close();
    await peer.close();
  }
});
test('peer card changes prevent disclosure or SendMessage and cannot gain local tool authority', async () => {
  const { peer, f, assignment } = await setup();
  try {
    peer.card.skills.push({ id: 'control', name: 'Control' });
    const first = await f.action(`team/${assignment.id}/run`, { generation: 0 });
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state !== 'accepted',
    );
    expect(peer.accepted).toBe(0);
    expect(f.service.children.inspect(f.session.id, first.child_id).state).toBe('interrupted');
    const builder = f.service.agents.inspect(f.session.id, 'salaam/builder');
    await f.service.agents.admit(
      f.session.id,
      'builder',
      'salaam/builder',
      digest(builder),
      [],
      f.actor,
    );
    expect(() =>
      f.service.external.backend!.assertAuthority!(f.service.external.runtimes()[0]!, [
        'salaam_files',
      ]),
    ).toThrow('without local tools');
  } finally {
    await f.close();
    await peer.close();
  }
});

test('peer task loss retains its slot across restart; restored known-task terminal reconciliation releases it without another SendMessage', async () => {
  const { peer, f, assignment } = await setup();
  peer.complete = false;
  try {
    const first = await f.action(`team/${assignment.id}/run`, { generation: 0 });
    await until(
      () => peer.accepted,
      (n) => n === 1,
    );
    const task = peer.tasks.get('sdk-task-1');
    peer.tasks.clear();
    await until(
      () => f.service.children.inspect(f.session.id, first.child_id),
      (c) => c.state !== 'accepted',
    );
    expect(f.service.external.stopped(first.child_id)).toBe(false);
    await f.restart();
    expect(f.service.external.stopped(first.child_id)).toBe(false);
    expect(peer.accepted).toBe(1);
    task.status.state = 'TASK_STATE_COMPLETED';
    peer.tasks.set(task.id, task);
    const row = f.service.external.row(first.child_id);
    await f.service.external.reconcile(
      f.service.children.inspect(f.session.id, first.child_id),
      'known-terminal',
      String(row.run_id),
      () => {},
    );
    expect(f.service.external.stopped(first.child_id)).toBe(true);
    expect(peer.accepted).toBe(1);
    const view = f.service.external.view(first.child_id) as any;
    expect(view.receipt).toMatchObject({
      scope: 'remote-terminal-receipt',
      checkpoint: { task_id: task.id, state: 'terminal' },
    });
    expect(view.checkpoint.state).toBe('terminal');
  } finally {
    await f.close();
    await peer.close();
  }
});
