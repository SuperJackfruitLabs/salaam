import { test, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until } from '../helpers.js';
import { ROOT } from '../../src/core/config.js';
import { digest } from '../../src/core/protocol.js';
import { readTree } from '../../src/workers/workspaces.js';
import type { TeamAssignment } from '../../src/tasks/team-work.js';

async function setup(conflict = false) {
  const f = await taskFixture({
    extensionPath: join(ROOT, 'test/fixtures/writing-specialist-extension.mjs'),
  });
  let workspace = f.service.workspaces.get(f.session.id);
  f.service.workspaces.patch(f.session.id, 'seed-bug', {
    action: 'patch',
    path: 'app.js',
    expected_revision: workspace.revision,
    expected_hash: digest(readTree(workspace.root)['app.js']),
    content: 'export const answer = 41;\n',
  });
  workspace = f.service.workspaces.get(f.session.id);
  f.service.workspaces.patch(f.session.id, 'seed-notes', {
    action: 'patch',
    path: 'notes.md',
    expected_revision: workspace.revision,
    expected_hash: null,
    content: '# Work in progress\n',
  });
  mkdirSync(join(f.source, '.salaam/agents'), { recursive: true });
  for (const name of ['builder-a', 'builder-b']) {
    writeFileSync(
      join(f.source, '.salaam/agents', name + '.md'),
      '---\n{"role":"builder","max_requests":3}\n---\nImplement only your assigned fixture change.',
    );
    const profile = f.service.agents.inspect(f.session.id, 'project/' + name);
    await f.service.agents.admit(
      f.session.id,
      'admit-' + name,
      profile.id,
      digest(profile),
      [],
      f.actor,
    );
  }
  const plan = checkedPlan(2);
  plan.steps[1]!.depends_on = [];
  const task = await f.plan({ ...plan, limits: { concurrency: 4 } });
  const assignments: TeamAssignment[] = [];
  for (let n = 0; n < 2; n++)
    assignments.push(
      await f.action<TeamAssignment>('team/assign', {
        step_id: task.steps[n]!.id,
        profile_id: conflict || n === 0 ? 'project/builder-a' : 'project/builder-b',
        requests: 3,
      }),
    );
  return { f, assignments };
}
async function runBoth(f: Awaited<ReturnType<typeof taskFixture>>, assignments: TeamAssignment[]) {
  for (const a of assignments) await f.action(`team/${a.id}/run`, { generation: 0 });
  const children = await until(
    () => f.service.children.list(f.session.id),
    (cs) =>
      cs.length === 2 &&
      cs.every((c) => c.state !== 'accepted') &&
      cs.every(
        (c) =>
          !f.service.store.db
            .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
            .get(c.child_session),
      ),
    20000,
  );
  for (const child of children)
    if (child.state !== 'completed')
      throw new Error(JSON.stringify(f.service.store.attempt(child.child_attempt)));
  return children;
}
test('two actual native builders edit private drafts, deny host/credential paths, and integrate disjoint changes without overwriting dirty work', async () => {
  const { f, assignments } = await setup();
  try {
    const children = await runBoth(f, assignments);
    const parent = f.service.workspaces.get(f.session.id),
      before = readTree(parent.root);
    expect(Buffer.from(before['app.js']!.content, 'base64').toString()).toContain('41');
    const roots = children.map((c) => f.service.workspaces.get(c.child_session).root);
    expect(new Set([...roots, parent.root]).size).toBe(3);
    for (const child of children) {
      const evidence = JSON.parse(
        readFileSync(join(f.source, 'writing-evidence-' + child.child_session), 'utf8'),
      );
      expect(evidence.denied).toHaveLength(0);
      expect(evidence.command.state).toBe('succeeded');
      expect(evidence.execution.evidence).toBe('fixture');
      expect(readTree(f.service.workspaces.get(child.child_session).root)['human.txt']).toEqual(
        before['human.txt'],
      );
      expect(child.worker!.binding.capabilities.isolation).toBe('simulated-owned-copy');
    }
    await expect(f.review(0)).rejects.toThrow('Integrate');
    const task = await f.task();
    await expect(
      f.action('verify', { step_id: task.steps[0]!.id, check_key: 'tests' }),
    ).rejects.toThrow('Integrate');
    const receipts: any[] = [];
    for (const child of children) {
      const proposal = f.service.workerWorkspaces.proposal(f.session.id, child.id) as {
        patch_digest: string;
        changes: { path: string }[];
      };
      expect(proposal.changes).toHaveLength(1);
      const root = f.service.workspaces.get(f.session.id),
        request = randomUUID();
      const receipt = f.service.workerWorkspaces.integrate(
        f.session.id,
        child.id,
        request,
        root.revision,
        root.digest,
        proposal.patch_digest,
        () => f.service.store.authorizeControl(f.session.id, f.actor),
      );
      expect(receipt).toMatchObject({ state: 'applied', current: true, verified_success: false });
      expect(
        f.service.workerWorkspaces.integrate(
          f.session.id,
          child.id,
          request,
          root.revision,
          root.digest,
          proposal.patch_digest,
          () => {
            throw new Error('expired');
          },
        ),
      ).toEqual(receipt);
      receipts.push(receipt);
    }
    const merged = readTree(f.service.workspaces.get(f.session.id).root);
    expect(Buffer.from(merged['app.js']!.content, 'base64').toString()).toContain('42');
    expect(Buffer.from(merged['notes.md']!.content, 'base64').toString()).toContain('returns 42');
    expect(merged['human.txt']).toEqual(before['human.txt']);
    expect(readFileSync(join(f.source, 'human.txt'), 'utf8')).toBe('pre-existing dirty work\n');
    await f.review(0);
    await f.review(1);
    expect((await f.task()).state).not.toBe('succeeded');
    await f.restart();
    expect(f.service.workerWorkspaces.inspect(receipts[1].id)).toMatchObject({
      state: 'applied',
      current: true,
    });
    expect(f.service.children.list(f.session.id)).toHaveLength(2);
    expect(readTree(f.service.workspaces.get(f.session.id).root)).toEqual(merged);
  } finally {
    await f.close();
  }
}, 30000);

test('a human edit to the same path conflicts without overwrite; disjoint human bytes survive integration and stale patch digests fail', async () => {
  const { f, assignments } = await setup();
  try {
    const children = await runBoth(f, assignments),
      child = children.find((c) => c.worker!.binding.profile.id.endsWith('builder-a'))!;
    const proposal = f.service.workerWorkspaces.proposal(f.session.id, child.id) as {
      patch_digest: string;
    };
    let workspace = f.service.workspaces.get(f.session.id);
    f.service.workspaces.patch(f.session.id, 'human-overlap', {
      path: 'app.js',
      expected_revision: workspace.revision,
      expected_hash: digest(readTree(workspace.root)['app.js']),
      content: 'human owns this line\n',
    });
    workspace = f.service.workspaces.get(f.session.id);
    expect(() =>
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child.id,
        'conflict',
        workspace.revision,
        workspace.digest,
        proposal.patch_digest,
        () => {},
      ),
    ).toThrow('both changed');
    expect(Buffer.from(readTree(workspace.root)['app.js']!.content, 'base64').toString()).toBe(
      'human owns this line\n',
    );
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM worker_integrations').get()!.n,
    ).toBe(0);
    const disjoint = children.find((c) => c.id !== child.id)!,
      other = f.service.workerWorkspaces.proposal(f.session.id, disjoint.id) as {
        patch_digest: string;
      };
    expect(() =>
      f.service.workerWorkspaces.integrate(
        f.session.id,
        disjoint.id,
        'bad-digest',
        workspace.revision,
        workspace.digest,
        'forged',
        () => {},
      ),
    ).toThrow('exact current');
    f.service.workerWorkspaces.integrate(
      f.session.id,
      disjoint.id,
      'disjoint',
      workspace.revision,
      workspace.digest,
      other.patch_digest,
      () => {},
    );
    expect(
      Buffer.from(
        readTree(f.service.workspaces.get(f.session.id).root)['app.js']!.content,
        'base64',
      ).toString(),
    ).toBe('human owns this line\n');
  } finally {
    await f.close();
  }
}, 30000);

test('an integration committed before application stays unresolved across restart until an exact explicit resolution', async () => {
  const { f, assignments } = await setup();
  try {
    const [child] = await runBoth(f, assignments),
      root = f.service.workspaces.get(f.session.id),
      before = readTree(root.root);
    const proposal = f.service.workerWorkspaces.proposal(f.session.id, child!.id) as {
      patch_digest: string;
    };
    const replace = f.service.workspaces.replace;
    f.service.workspaces.replace = () => {
      throw new Error('barrier before mutation');
    };
    expect(() =>
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child!.id,
        'lost-apply',
        root.revision,
        root.digest,
        proposal.patch_digest,
        () => {},
      ),
    ).toThrow('barrier');
    f.service.workspaces.replace = replace;
    const row = f.service.store.db.prepare('SELECT id FROM worker_integrations').get()!;
    expect(
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child!.id,
        'lost-apply',
        root.revision,
        root.digest,
        proposal.patch_digest,
        () => {
          throw new Error('expired');
        },
      ),
    ).toMatchObject({ state: 'prepared' });
    expect(readTree(root.root)).toEqual(before);
    await f.restart();
    expect(f.service.workerWorkspaces.inspect(String(row.id))).toMatchObject({
      state: 'needs_resolution',
      generation: 1,
      current: false,
    });
    expect(readTree(f.service.workspaces.get(f.session.id).root)).toEqual(before);
    expect(() =>
      f.service.workerWorkspaces.resolve(
        String(row.id),
        'stale-root',
        root.revision,
        'changed',
        () => {},
      ),
    ).toThrow('exact unchanged');
    const resolved = f.service.workerWorkspaces.resolve(
      String(row.id),
      'resolve',
      root.revision,
      root.digest,
      () => f.service.store.authorizeControl(f.session.id, f.actor),
    );
    expect(resolved).toMatchObject({
      state: 'applied',
      generation: 2,
      current: true,
      verified_success: false,
    });
    expect(
      f.service.workerWorkspaces.resolve(
        String(row.id),
        'resolve',
        root.revision,
        root.digest,
        () => {
          throw new Error('expired');
        },
      ),
    ).toEqual(resolved);
    expect(
      f.service.store.db
        .prepare(
          "SELECT count(*) AS n FROM workspace_mutations WHERE request_key LIKE 'worker-integration:%'",
        )
        .get()!.n,
    ).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);

test('recovery reconciles a fully staged root mutation once without submitting a second integration', async () => {
  const { f, assignments } = await setup();
  try {
    const [child] = await runBoth(f, assignments),
      root = f.service.workspaces.get(f.session.id);
    const proposal = f.service.workerWorkspaces.proposal(f.session.id, child!.id) as {
      patch_digest: string;
    };
    const reconcile = f.service.workspaces.reconcile;
    f.service.workspaces.reconcile = () => {
      throw new Error('barrier after staging');
    };
    expect(() =>
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child!.id,
        'staged',
        root.revision,
        root.digest,
        proposal.patch_digest,
        () => {},
      ),
    ).toThrow('staging');
    f.service.workspaces.reconcile = reconcile;
    const row = f.service.store.db.prepare('SELECT id FROM worker_integrations').get()!;
    await f.restart();
    expect(f.service.workerWorkspaces.inspect(String(row.id))).toMatchObject({
      state: 'applied',
      generation: 1,
      current: true,
    });
    expect(
      f.service.store.db
        .prepare(
          "SELECT count(*) AS n FROM workspace_mutations WHERE request_key LIKE 'worker-integration:%'",
        )
        .get()!.n,
    ).toBe(1);
    expect(
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child!.id,
        'staged',
        root.revision,
        root.digest,
        proposal.patch_digest,
        () => {
          throw new Error('expired');
        },
      ),
    ).toMatchObject({ state: 'applied', generation: 1 });
  } finally {
    await f.close();
  }
}, 30000);

test('negative path probes fail the actual child turn and cannot yield an integratable or verified patch', async () => {
  const f = await taskFixture({
    extensionPath: join(ROOT, 'test/fixtures/writing-specialist-extension.mjs'),
  });
  try {
    mkdirSync(join(f.source, '.salaam/agents'), { recursive: true });
    writeFileSync(
      join(f.source, '.salaam/agents/escape.md'),
      '---\n{"role":"builder"}\n---\nExercise denied paths.',
    );
    const profile = f.service.agents.inspect(f.session.id, 'project/escape');
    await f.service.agents.admit(f.session.id, 'admit', profile.id, digest(profile), [], f.actor);
    const task = await f.plan(),
      a = await f.action<TeamAssignment>('team/assign', {
        step_id: task.steps[0]!.id,
        profile_id: profile.id,
        requests: 3,
      });
    const claim = await f.action<TeamAssignment>(`team/${a.id}/run`, { generation: 0 });
    const child = await until(
      () => f.service.children.inspect(f.session.id, claim.child_id!),
      (c) =>
        c.state === 'failed' &&
        !f.service.store.db
          .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
          .get(c.child_session),
    );
    const evidence = JSON.parse(
      readFileSync(join(f.source, 'writing-evidence-' + child.child_session), 'utf8'),
    );
    expect(evidence.denied).toHaveLength(4);
    expect(f.service.store.attempt(child.child_attempt).error).toContain('Tool execution failed');
    expect(f.service.workerWorkspaces.proposal(f.session.id, child.id)).toMatchObject({
      changes: [],
      worker_state: 'failed',
      verified_success: false,
    });
    expect(() =>
      f.service.workerWorkspaces.integrate(
        f.session.id,
        child.id,
        'denied',
        0,
        'unused',
        'unused',
        () => {},
      ),
    ).toThrow('Wait');
    expect((await f.task()).state).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('operator rejection persists across restart and admits only a new explicit generation', async () => {
  const {
    f,
    assignments: [a, b],
  } = await setup();
  try {
    await runBoth(f, [a!, b!]);
    await f.action(`team/${a!.id}/reject`, {
      generation: 1,
      reason: 'Revise the implementation before integration.',
    });
    expect((await f.task()).steps[0]!.state).toBe('failed');
    await f.restart();
    expect((await f.task()).steps[0]!.state).toBe('failed');
    await expect(f.action(`team/${a!.id}/run`, { generation: 1 })).rejects.toThrow(
      'new instruction',
    );
    const next = await f.action<TeamAssignment>(`team/${a!.id}/run`, {
      generation: 1,
      instruction: 'Create a revised proposal while preserving human bytes.',
    });
    await f.settled();
    expect(next.generation).toBe(2);
    expect(f.service.children.list(f.session.id)).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 30000);

test('writing profiles cannot be admitted without an execution boundary', async () => {
  const f = await taskFixture({ codingBackend: undefined });
  try {
    const profile = f.service.agents.inspect(f.session.id, 'salaam/builder');
    await expect(
      f.service.agents.admit(f.session.id, 'no-executor', profile.id, digest(profile), [], f.actor),
    ).rejects.toThrow('execution boundary');
    expect(f.service.agents.snapshot(f.session.id)).toEqual([]);
    expect(f.service.children.list(f.session.id)).toEqual([]);
  } finally {
    await f.close();
  }
});

test('task cancellation revokes a writing child and cancels its owned command before any root integration', async () => {
  const {
    f,
    assignments: [a, b],
  } = await setup();
  try {
    f.backend.holding = true;
    const claim = await f.action<TeamAssignment>(`team/${a!.id}/run`, { generation: 0 }),
      child = f.service.children.inspect(f.session.id, claim.child_id!);
    const run = await until(
      () => f.service.coding.list(child.child_session)[0],
      (r) => r?.state === 'running',
    );
    await f.action('cancel');
    await until(
      () => f.service.coding.get(child.child_session, run!.id),
      (r) => r.state === 'cancelled',
    );
    await until(
      () => f.service.children.inspect(f.session.id, child.id),
      (c) => c.state === 'cancelled',
    );
    expect(f.service.team.get(b!.id).generation).toBe(0);
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM worker_integrations').get()!.n,
    ).toBe(0);
    expect(
      Buffer.from(
        readTree(f.service.workspaces.get(f.session.id).root)['app.js']!.content,
        'base64',
      ).toString(),
    ).toContain('41');
  } finally {
    f.backend.holding = false;
    await f.close();
  }
});
