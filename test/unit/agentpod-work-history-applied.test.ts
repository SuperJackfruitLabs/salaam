import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentPodWorkDecisions } from '../../src/agentpod/work-decisions.js';
import { canonical, digest, textDigest } from '../../src/core/protocol.js';
import { StationWork } from '../../src/agentpod/station-work.js';
import { settlementDriver, preparedReadOnlyPatchFixture } from './agentpod-work-helpers.js';
import { characterizeEvidence } from '../agentpod-evidence-recorder.js';

vi.mock('../../src/core/index.js', async (importOriginal) => {
  const { recordingCore } = await import('../agentpod-evidence-recorder.js');
  return recordingCore(await importOriginal());
});
vi.mock('node:crypto', async (importOriginal) => {
  const { countingCrypto } = await import('../agentpod-evidence-recorder.js');
  return countingCrypto(await importOriginal());
});
characterizeEvidence();

async function approvedReadOnlyPatchFixture() {
  const x = preparedReadOnlyPatchFixture(60000),
    { f, managed, offer, call, attempt, args, tool, task } = x;
  const answer = {
    version: 1,
    request_id: randomUUID(),
    decision: offer,
    decision_digest: digest(offer),
    elicitation_id: 'elc_approvedfixture',
    option_id: 'approve',
    answered_by: 'operator',
    answered_at: new Date().toISOString(),
  };
  new AgentPodWorkDecisions(f.work, managed).answer(f.binding, answer);
  f.store.transaction(() => {
    expect(managed.takePermissionInTransaction(offer.operation_id)).toBe(true);
    f.store.db
      .prepare("UPDATE station_calls SET state='dispatching',revision=revision+1 WHERE id=?")
      .run(call);
    f.store.event(f.session, 'station.call.dispatching', {
      call_id: call,
      attempt_id: attempt,
      kind: 'patch',
    });
  });
  const result = {
    version: 1,
    ok: true,
    path: args.path,
    before_tree_digest: args.expected_tree,
    tree_digest: 'c'.repeat(64),
    sha256: textDigest(args.content),
    files: 1,
    root_identity: 'd'.repeat(64),
  };
  const stop = {
    version: 1,
    scope: 'local_process_group',
    method: 'observed_exit',
    pid: 43,
    identity: 'linux-proc-v1:' + 'e'.repeat(64),
  };
  const writer = Object.assign(Object.create(StationWork.prototype), {
    store: f.store,
    managed,
    artifacts: f.work.verification.artifacts,
    get: () => f.store.db.prepare('SELECT * FROM station_calls WHERE id=?').get(call),
    guard: () => {},
    authority: { leaseWindow: () => 5000 },
    helper: async () => {
      f.store.db
        .prepare(
          "UPDATE station_calls SET helper_state='stopped',helper_pid=43,helper_identity=?,helper_stop_json=? WHERE id=?",
        )
        .run(stop.identity, canonical(stop), call);
      return result;
    },
  }) as { perform(id: string): Promise<void> };
  await writer.perform(call);
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.finished', {
      attempt_id: attempt,
      worker_epoch: 1,
      tool_call_id: tool,
      tool: 'salaam_station',
      failed: false,
    }),
  );
  f.store.finish(attempt, 'completed', 'Approved patch returned', null);
  f.store.db.prepare("UPDATE task_steps SET state='completed' WHERE task_id=?").run(task.id);
  f.store.db
    .prepare(
      "UPDATE durable_tasks SET state='partially_completed',reason='Stopped before final completion' WHERE id=?",
    )
    .run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.authority.revoke(f.binding, 'approved-history-revoke', 'Original known-effect work stopped');
  const effect = JSON.parse(
    String(
      f.store.db.prepare('SELECT receipt FROM operations WHERE id=?').get(offer.operation_id)!
        .receipt,
    ),
  );
  return { ...x, answer, effect };
}

test('approved patch with closed readonly history retires without changing its produced artifact or success', async () => {
  const { f, admitted, children, managed, offer, effect } = await approvedReadOnlyPatchFixture();
  try {
    const bytes = f.work.verification.artifacts.read(effect.artifact_id);
    const run = () =>
      f.work.fail(
        f.binding,
        'applied-history-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    expect(run()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.work.verification.artifacts.read(effect.artifact_id)).toBe(bytes);
    expect(
      f.store.db.prepare('SELECT state FROM operations WHERE id=?').get(offer.operation_id)!.state,
    ).toBe('succeeded');
    const receipt = run();
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each([
  [
    'missing patch tool pair',
    "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool')='salaam_station'",
  ],
  [
    'produced artifact digest',
    "UPDATE artifacts SET digest='changed' WHERE id=(SELECT json_extract(receipt,'$.artifact_id') FROM operations LIMIT 1)",
  ],
  ['approval decision', "UPDATE approvals SET decision='deny'"],
  ['approval actor', "UPDATE approvals SET decided_by='scoped-policy'"],
  ['missing human answer', "DELETE FROM requests WHERE actor='agentpod-work-decision-answer'"],
  [
    'changed offer',
    "UPDATE requests SET hash='changed' WHERE actor='agentpod-work-decision-offer'",
  ],
  ['operator provenance', "DELETE FROM requests WHERE actor='local-operator'"],
  ['unknown helper', "UPDATE station_calls SET helper_state='running' WHERE kind='patch'"],
  ['unconfirmed operation', "UPDATE operations SET state='dispatching'"],
  ['foreign root', "UPDATE station_calls SET root_digest='foreign' WHERE kind='patch'"],
  ['foreign patch args', "UPDATE operations SET value='{}'"],
  ['changed produced receipt', "UPDATE operations SET receipt='{}'"],
  ['unknown native grant', "UPDATE usage_observations SET status='unknown'"],
  ['prior failed check', "UPDATE task_checks SET state='failed'"],
])('approved history rejects %s', async (_name, sql) => {
  const { f, admitted, children, managed } = await approvedReadOnlyPatchFixture();
  try {
    f.store.db.exec(sql);
    expect(() =>
      f.work.fail(
        f.binding,
        'applied-history-denied',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(
      f.store.db.prepare('SELECT state FROM durable_tasks WHERE id=?').get(admitted.task_id)!.state,
    ).toBe('partially_completed');
  } finally {
    await managed.close();
    await children.close();
    f.close();
  }
});

test.each(['known-stale', 'third-tree', 'before-patch', 'missing-terminal'])(
  'approved history audits %s inspection without refreshing its check',
  async (mode) => {
    const { f, admitted, children, managed, effect, receipts } =
      await approvedReadOnlyPatchFixture();
    try {
      const old = f.store.db
        .prepare("SELECT * FROM events WHERE kind='station.verification_observed' LIMIT 1")
        .get()!;
      const payload = JSON.parse(String(old.payload));
      payload.tree_digest = mode === 'third-tree' ? '9'.repeat(64) : effect.result.tree_digest;
      const check = f.store.db.prepare('SELECT * FROM task_checks WHERE id=?').get(receipts.check)!;
      const bytes = f.work.verification.artifacts.read(String(check.artifact_id));
      f.store.db.prepare('DELETE FROM events WHERE id=?').run(String(old.id));
      if (mode === 'before-patch')
        f.store.db
          .prepare('INSERT INTO events VALUES(?,?,?,?,?,?)')
          .run(
            String(old.session_id),
            Number(old.seq),
            String(old.id),
            String(old.kind),
            old.causation_id === null ? null : String(old.causation_id),
            canonical(payload),
          );
      else
        f.store.transaction(() =>
          f.store.event(f.session, 'station.verification_observed', payload),
        );
      if (mode === 'missing-terminal')
        f.store.db.prepare("DELETE FROM events WHERE kind='operation.succeeded'").run();
      const retire = () =>
        f.work.fail(
          f.binding,
          'stale-history-retire',
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        );
      if (mode === 'known-stale')
        expect(retire()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
      else expect(retire).toThrow();
      expect(f.work.verification.artifacts.read(String(check.artifact_id))).toBe(bytes);
      expect(
        f.store.db
          .prepare('SELECT workspace_digest FROM task_checks WHERE id=?')
          .get(receipts.check)!.workspace_digest,
      ).toBe(check.workspace_digest);
    } finally {
      await managed.close();
      await children.close();
      f.close();
    }
  },
);
