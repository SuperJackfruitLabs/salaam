import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ChildWork } from '../../src/children.js';
import { Artifacts } from '../../src/artifacts.js';
import { AgentProfiles } from '../../src/agent-profiles.js';
import type { Supervisor } from '../../src/supervisor.js';

// Item 8: the critic child. A reviewer over an immutable snapshot of the verified deliverables,
// linked to the task's last step attempt (which has settled), charged to its own budget, started at once.
async function setup() {
  const dir = mkdtempSync('/tmp/sal-critic-child-');
  const store = new Store(join(dir, 'journal.sqlite'));
  const parent = store.create(dir, 'parent');
  const attempt = store.accept(
    parent.id,
    'attempt',
    store.session(parent.id).revision,
    'parent',
  ).attempt_id;
  store.db.prepare("UPDATE attempts SET state='completed' WHERE id=?").run(attempt);
  let starts = 0;
  const supervisor = {
    assertSessionProviderSupported: () => {},
    start: async (id: string) => {
      starts++;
      store.allocate(id, 'boot');
    },
  } as unknown as Supervisor;
  const children = new ChildWork(store, new Artifacts(join(dir, 'artifacts'), store), supervisor);
  const profiles = new AgentProfiles(
    store,
    { provider: 'anthropic', model: 'm', max_tokens: 1024 } as never,
    async (r) => ({ route: r, output_cap: true }),
  );
  store.workerBoundary.profiles = profiles;
  const grant = await profiles.admitCritic(parent.id, 'critic', () => {});
  return { dir, store, parent, attempt, children, grant, starts: () => starts };
}
const snapshot = {
  'runs/r/answer.md': { content: Buffer.from('# 502\n').toString('base64'), executable: false },
};

test('the critic child reviews only the snapshot, with the reviewer tools, and starts once', async () => {
  const f = await setup();
  try {
    const child = f.children.spawnCritic(
      f.parent.id,
      f.attempt,
      'critic-1',
      'Review against: cite RFC 9110.',
      4,
      f.grant,
      snapshot,
    );
    expect(JSON.parse(child.authority)).toEqual([
      'salaam_findings',
      'salaam_probe',
      'salaam_repository',
    ]);
    expect(child.parent_attempt).toBe(f.attempt);
    expect(child.budget).toBe(4);
    const binding = f.store.workerBoundary.view(child.id).binding;
    expect(binding.profile.id).toBe('salaam/reviewer');
    expect(binding.repository?.digest).toBeTruthy();
    // The snapshot is exactly the verified bytes it was given.
    const artifact = new Artifacts(join(f.dir, 'artifacts'), f.store).read(
      binding.repository!.artifact_id,
    );
    expect(JSON.parse(artifact)).toEqual(snapshot);
    expect(f.starts()).toBe(1);
    // Replaying the same critic step returns it; never a second child.
    expect(
      f.children.spawnCritic(
        f.parent.id,
        f.attempt,
        'critic-1',
        'Review against: cite RFC 9110.',
        4,
        f.grant,
        snapshot,
      ).id,
    ).toBe(child.id);
    expect(f.starts()).toBe(1);
  } finally {
    await f.children.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a critic is only the built-in reviewer, with a bounded budget and a snapshot', async () => {
  const f = await setup();
  try {
    expect(() =>
      f.children.spawnCritic(f.parent.id, f.attempt, 'c', 'p', 9, f.grant, snapshot),
    ).toThrow('budget');
    expect(() =>
      f.children.spawnCritic(
        f.parent.id,
        f.attempt,
        'c',
        'p',
        4,
        { ...f.grant, profile: { ...f.grant.profile, id: 'salaam/builder' } },
        snapshot,
      ),
    ).toThrow('reviewer');
    expect(() => f.children.spawnCritic(f.parent.id, f.attempt, 'c', 'p', 4, f.grant, {})).toThrow(
      'snapshot',
    );
  } finally {
    await f.children.close();
    f.store.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
