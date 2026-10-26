import { test, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { AgentPodAuthority } from '../../src/agentpod-authority.js';

// Approval scopes B part 2: an agent's standing "Always allow" rules are pinned at admission and
// checked again at every renewal. A renewal can only drop a rule, never add one.
function fixture() {
  const base = realpathSync(mkdtempSync('/tmp/sal-rules-'));
  const workspace = join(base, 'source'),
    state = join(base, 'state');
  mkdirSync(workspace);
  mkdirSync(state);
  const binding = {
    version: 1 as const,
    organization_id: 'org_' + '1'.repeat(20),
    principal_id: 'prn_' + '2'.repeat(20),
    node_id: 'node_fixture',
    station_id: 'station_fixture',
    station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
    occupancy_epoch: 1,
    hub_session_id: 'hub_fixture',
    workspace,
    run: { source: 'superpipeline' as const, id: 'run_Aa0Bb1', epoch: 1 },
  };
  const pins = join(base, 'pins.json');
  writeFileSync(
    pins,
    JSON.stringify({
      version: 1,
      organization_id: binding.organization_id,
      node_id: binding.node_id,
      station_key: binding.station_key,
      workspace,
    }),
    { mode: 0o600 },
  );
  const store = new Store(join(state, 'journal.sqlite'));
  const authority = new AgentPodAuthority(store, state, pins, () => {});
  return { store, authority, binding };
}
const rule = (set_by = 'prn_owner') => ({
  id: randomUUID(),
  scope: 'workspace-write' as const,
  set_by,
});

test('rules given at admission are pinned for the session', () => {
  const f = fixture();
  const a = rule(),
    b = rule('prn_admin');
  const admitted = f.authority.admit(f.binding, 'admit', undefined, [a, b]);
  expect(f.authority.approvalRules(admitted.session_id)).toEqual(
    [a, b].sort((x, y) => x.id.localeCompare(y.id)),
  );
  const plain = fixture();
  const none = plain.authority.admit(plain.binding, 'admit');
  expect(plain.authority.approvalRules(none.session_id)).toEqual([]);
});

test('a renewal that no longer lists a rule revokes it at once, and cannot add one', () => {
  const f = fixture();
  const a = rule(),
    b = rule();
  const { session_id } = f.authority.admit(f.binding, 'admit', undefined, [a, b]);
  f.authority.renew(f.binding, 'renew-1', 1, [a, b]);
  expect(
    f.authority
      .approvalRules(session_id)
      .map((r) => r.id)
      .sort(),
  ).toEqual([a.id, b.id].sort());
  // b revoked, and a rule set mid-run (c) does not join the run.
  const c = rule();
  f.authority.renew(f.binding, 'renew-2', 2, [a, c]);
  expect(f.authority.approvalRules(session_id)).toEqual([a]);
  // b listed again later does not come back: revocation is final for the run.
  f.authority.renew(f.binding, 'renew-3', 3, [a, b]);
  expect(f.authority.approvalRules(session_id)).toEqual([a]);
  // A renewal without rules (none left, or an older hub) revokes everything.
  f.authority.renew(f.binding, 'renew-4', 4);
  expect(f.authority.approvalRules(session_id)).toEqual([]);
  const revoked = f.store.db
    .prepare("SELECT count(*) AS n FROM events WHERE session_id=? AND kind='approval_rule.revoked'")
    .get(session_id)!;
  expect(Number(revoked.n)).toBe(2);
});

test('rules must be well formed: known scope, exact keys, unique ids, bounded count', () => {
  for (const [why, rules] of Object.entries({
    scope: [{ ...rule(), scope: 'command' }],
    extra: [{ ...rule(), paths: ['x'] }],
    missing: [{ id: randomUUID(), scope: 'workspace-write' }],
    id: [{ ...rule(), id: 'not-a-uuid' }],
    setter: [{ ...rule(), set_by: '' }],
    duplicate: (() => {
      const r = rule();
      return [r, { ...r }];
    })(),
    empty: [],
    many: Array.from({ length: 17 }, () => rule()),
    shape: 'all',
  })) {
    const f = fixture();
    expect(() => f.authority.admit(f.binding, 'admit', undefined, rules as never), why).toThrow(
      'approval rules',
    );
  }
  const f = fixture();
  f.authority.admit(f.binding, 'admit', undefined, [rule()]);
  expect(() =>
    f.authority.renew(f.binding, 'renew', 1, [{ ...rule(), scope: 'x' }] as never),
  ).toThrow('approval rules');
});

test('replaying an admission with different rules conflicts', () => {
  const f = fixture();
  const a = rule();
  f.authority.admit(f.binding, 'admit', undefined, [a]);
  expect(f.authority.admit(f.binding, 'admit', undefined, [a]).session_id).toBeTruthy();
  expect(() => f.authority.admit(f.binding, 'admit', undefined, [rule()])).toThrow();
});
