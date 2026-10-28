import { test, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { AgentPodAuthority } from '../../src/agentpod-authority.js';
import { ManagedWork } from '../../src/managed.js';
import { StationWork } from '../../src/station-work.js';
import { RunGrants } from '../../src/run-grants.js';

// Operator ruling 2026-10-28, across the boundary that was missed three times: the rule a hub
// renewal newly lists must reach the write check of the run already in flight. Nothing between the
// renewal and the write is stubbed here: the real authority pins the rule from the hub's renew
// (the node relays it verbatim) and the real station write check reads it from the same journal.
test('a rule added by a renewal answers the next workspace write of the run in flight', () => {
  const base = realpathSync(mkdtempSync('/tmp/sal-rule-e2e-'));
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
  // Admitted with no rule: the person has not chosen "Always allow" yet.
  const { session_id: session } = authority.admit(binding, 'admit', undefined);
  authority.renew(binding, 'renew:hub:1', 1);
  const submission = store.accept(session, 'submit', store.session(session).revision, 'Test'),
    epoch = store.allocate(session, 'boot');
  store.state(session, epoch, 'ready');
  store.claim(session, epoch);
  store.running(submission.attempt_id);
  const managed = new ManagedWork(store, {
    assertActive: () => {},
    assertMcpOperation: () => {},
    reply: () => {},
    failed: () => {},
  });
  const station = Object.assign(Object.create(StationWork.prototype), {
    store,
    managed,
    grants: new RunGrants(store),
    authority,
    grantScope: () => ({ task_id: randomUUID(), plan_revision: 1, task_state: 'running' }),
  }) as StationWork;
  let n = 0;
  const write = (path: string) => {
    const args = {
      action: 'patch',
      path,
      content: 'answer',
      expected_hash: null,
      expected_tree: 'a'.repeat(64),
    };
    const { operation, approval } = store.transaction(() =>
      (managed as any).insertPrepared(
        session,
        epoch,
        submission.attempt_id,
        'call-' + ++n,
        'workspace',
        'station:' + path,
        JSON.stringify(args),
        'a'.repeat(64),
      ),
    );
    (station as any).answerFromGrant(operation.id, session, args);
    return managed.approval(approval.id);
  };
  // Before: the write asks.
  expect(write('runs/run_Aa0Bb1/answer.md').state).toBe('pending');
  // The person chooses "Always allow"; the hub renews with the new rule (the exact renew shape).
  const rule = { id: randomUUID(), scope: 'workspace-write' as const, set_by: 'prn_owner' };
  authority.renew(binding, 'renew:hub:2', 2, [rule]);
  // The very next write of the same run is answered by that rule, and says so.
  expect(write('runs/run_Aa0Bb1/handoff.json')).toMatchObject({
    state: 'decided',
    decision: 'approve',
    decided_by: 'rule:' + rule.id,
  });
  // Revoked at the next renewal: the following write asks again.
  authority.renew(binding, 'renew:hub:3', 3);
  expect(write('runs/run_Aa0Bb1/notes.md').state).toBe('pending');
});
