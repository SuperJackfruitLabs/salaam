import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { Store } from '../../src/store.js';
import { AgentProfiles } from '../../src/agent-profiles.js';

// Item 8: the task critic's narrow authority. Only the built-in salaam/reviewer, only when the
// caller's authorize (the plan declares a critic) holds; no operator controller is involved.
const route = { provider: 'anthropic', model: 'claude-x', max_tokens: 1024 } as never;
function fixture() {
  const store = new Store(':memory:');
  const session = store.create(mkdtempSync('/tmp/sal-critic-'), 'create').id;
  const profiles = new AgentProfiles(store, route, async (r) => ({ route: r, output_cap: true }));
  return { store, session, profiles };
}

test('the critic is admitted as the built-in reviewer, resolvable, and replays its grant', async () => {
  const f = fixture();
  const grant = await f.profiles.admitCritic(f.session, 'critic-1', () => {});
  expect(grant.profile.id).toBe('salaam/reviewer');
  expect(grant.profile.tools).toEqual(['salaam_findings', 'salaam_probe', 'salaam_repository']);
  expect(grant.facts).toEqual([]);
  expect(f.profiles.resolve(f.session, 'salaam/reviewer').id).toBe(grant.id);
  expect((await f.profiles.admitCritic(f.session, 'critic-1', () => {})).id).toBe(grant.id);
});

test('without the plan declaring a critic nothing is granted', async () => {
  const f = fixture();
  await expect(
    f.profiles.admitCritic(f.session, 'critic-1', () => {
      throw new Error('No critic in the admitted plan');
    }),
  ).rejects.toThrow('No critic');
  expect(() => f.profiles.resolve(f.session, 'salaam/reviewer')).toThrow('admit');
});
