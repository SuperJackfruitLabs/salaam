import { expect, test, vi } from 'vitest';
import { digest } from '../../src/core/protocol.js';
import { budgetStopFixture, failBudget } from './agentpod-work-helpers.js';
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

// The request budget stopped an attempt after its approved workspace writes and its review had
// succeeded: the writes are known effects, recorded against their returned patch calls.
function budgetStopKnownEffectsFixture() {
  const x = budgetStopFixture();
  const { f, attempt } = x;
  const db = f.store.db,
    a64 = 'a'.repeat(64),
    c64 = 'c'.repeat(64),
    root = digest(f.binding);
  db.exec('PRAGMA foreign_keys=OFF');
  for (const n of [1, 2]) {
    const op = `00000000-0000-4000-8000-00000000000${n}`,
      call = `call-${n}`,
      result = { version: 1, ok: true, path: `runs/r/f${n}.md`, sha256: a64 };
    const receipt = {
      version: 1,
      scope: 'station-workspace',
      artifact_id: `artifact-${n}`,
      call_id: call,
      root_digest: root,
      configuration_digest: c64,
      input_digest: a64,
      result,
    };
    db.prepare(
      "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state,receipt,resolution) VALUES(?,?,?,1,?,'workspace',?,?,?,'station:runs/r','v','t','policy','station-workspace-v1','opaque','succeeded',?,'workspace-content-receipt-v1')",
    ).run(
      op,
      f.session,
      attempt,
      call,
      `write-${n}`,
      a64,
      `${n}`.repeat(64),
      JSON.stringify(receipt),
    );
    db.prepare(
      "INSERT INTO approvals(id,operation_id,session_id,worker_epoch,operation_digest,actor_scope,policy_digest,expires_at,state,decision,decided_by) VALUES(?,?,?,1,?,'owner','policy',0,'decided','approve','owner')",
    ).run(`ap-${n}`, op, f.session, `${n}`.repeat(64));
    db.prepare(
      "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,operation_id,state,helper_state,result_json) VALUES(?,?,1,?,?,'patch',?,?,?,'{}',?,'returned','stopped',?)",
    ).run(call, f.session, attempt, call, a64, root, c64, op, JSON.stringify(result));
  }
  db.prepare(
    "INSERT INTO operations(id,session_id,attempt_id,worker_epoch,tool_call_id,kind,action_key,argument_digest,operation_digest,target,value,target_version,policy_digest,connector,replay,state,receipt,resolution) VALUES('00000000-0000-4000-8000-000000000009',?,?,1,'review','review','review-1',?,?,'review','v','t','policy','local-review-v1','read-only','succeeded','{}','local-review-receipt')",
  ).run(f.session, attempt, a64, '9'.repeat(64));
  db.prepare(
    "INSERT INTO approvals(id,operation_id,session_id,worker_epoch,operation_digest,actor_scope,policy_digest,expires_at,state,decision,decided_by) VALUES('ap-9','00000000-0000-4000-8000-000000000009',?,1,?,'owner','policy',0,'decided','approve','owner')",
  ).run(f.session, '9'.repeat(64));
  // A checked command ran in its own station unit, now stopped with a complete stop proof.
  db.prepare(
    "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,helper_state) VALUES('check-1',?,1,?,'check-1','check',?,?,?,'{}','returned','stopped')",
  ).run(f.session, attempt, a64, root, c64);
  const unit = 'b'.repeat(16),
    name = `salaam-station-${unit}.service`;
  db.prepare(
    "INSERT INTO station_units(id,session_id,call_id,context_digest,config_json,snapshot_path,output_path,state,stop_json) VALUES(?,?,'check-1','digest','{}','/s','/o','stopped',?)",
  ).run(
    unit,
    f.session,
    JSON.stringify({
      version: 1,
      observed_empty: true,
      unit: name,
      cgroup: `/system.slice/${name}`,
      invocation: 'd'.repeat(32),
    }),
  );
  db.exec('PRAGMA foreign_keys=ON');
  return x;
}

test('a request-budget stop after approved writes and a review retires with them as known effects', () => {
  const x = budgetStopKnownEffectsFixture();
  try {
    const receipt = failBudget(x, 'known-retire');
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failBudget(x, 'known-retire')).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'write-not-succeeded',
  'write-not-approved',
  'write-approval-pending',
  'write-digest-mismatch',
  'write-without-call',
  'write-call-not-returned',
  'write-effect-other-call',
  'write-effect-other-root',
  'write-effect-other-result',
  'write-effect-not-ok',
  'write-other-resolution',
  'review-not-succeeded',
  'review-not-approved',
  'review-not-read-only',
  'other-operation-kind',
  'check-not-returned',
  'unit-not-stopped',
  'unit-without-proof',
  'unit-for-other-call',
  'cancelled-by-someone',
  'other-error',
  'tool-after-stop',
  'other-ledger',
])('request-budget known-effects retirement rejects %s', (failure) => {
  const x = budgetStopKnownEffectsFixture();
  const { f, attempt } = x;
  try {
    const db = f.store.db,
      w1 = '00000000-0000-4000-8000-000000000001',
      rv = '00000000-0000-4000-8000-000000000009';
    const set = (sql: string, ...args: unknown[]) => {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(sql).run(...(args as never[]));
      db.exec('PRAGMA foreign_keys=ON');
    };
    const effect = (path: string, value: string) =>
      set(
        `UPDATE operations SET receipt=json_set(receipt,'${path}',json(?)) WHERE id=?`,
        value,
        w1,
      );
    if (failure === 'write-not-succeeded')
      set("UPDATE operations SET state='failed_definite' WHERE id=?", w1);
    if (failure === 'write-not-approved')
      set("UPDATE approvals SET decision='deny' WHERE id='ap-1'");
    if (failure === 'write-approval-pending')
      set("UPDATE approvals SET state='pending' WHERE id='ap-1'");
    if (failure === 'write-digest-mismatch')
      set("UPDATE approvals SET operation_digest=? WHERE id='ap-1'", '0'.repeat(64));
    if (failure === 'write-without-call')
      set("UPDATE station_calls SET operation_id=NULL WHERE id='call-1'");
    if (failure === 'write-call-not-returned')
      set("UPDATE station_calls SET state='outcome_unknown' WHERE id='call-1'");
    if (failure === 'write-effect-other-call') effect('$.call_id', '"call-2"');
    if (failure === 'write-effect-other-root')
      effect('$.root_digest', JSON.stringify('0'.repeat(64)));
    if (failure === 'write-effect-other-result') effect('$.result.path', '"elsewhere.md"');
    if (failure === 'write-effect-not-ok') {
      effect('$.result.ok', 'false');
      set(
        "UPDATE station_calls SET result_json=json_set(result_json,'$.ok',json('false')) WHERE id='call-1'",
      );
    }
    if (failure === 'write-other-resolution')
      set("UPDATE operations SET resolution='other' WHERE id=?", w1);
    if (failure === 'review-not-succeeded')
      set("UPDATE operations SET state='failed_definite' WHERE id=?", rv);
    if (failure === 'review-not-approved')
      set("UPDATE approvals SET state='invalidated',decision=NULL WHERE id='ap-9'");
    if (failure === 'review-not-read-only')
      set("UPDATE operations SET replay='opaque' WHERE id=?", rv);
    if (failure === 'other-operation-kind') set("UPDATE operations SET kind='mcp' WHERE id=?", rv);
    if (failure === 'check-not-returned')
      set("UPDATE station_calls SET state='failed' WHERE id='check-1'");
    if (failure === 'unit-not-stopped')
      set("UPDATE station_units SET state='unconfirmed' WHERE call_id='check-1'");
    if (failure === 'unit-without-proof')
      set("UPDATE station_units SET stop_json=NULL WHERE call_id='check-1'");
    if (failure === 'unit-for-other-call')
      set("UPDATE station_units SET call_id='call-1' WHERE call_id='check-1'");
    if (failure === 'cancelled-by-someone')
      set("INSERT INTO cancellations VALUES(?,'local-operator')", attempt);
    if (failure === 'other-error')
      set(
        "UPDATE attempts SET error='Required control failed: something else' WHERE id=?",
        attempt,
      );
    if (failure === 'tool-after-stop')
      for (const kind of ['tool.started', 'tool.finished'])
        f.store.transaction(() =>
          f.store.event(f.session, kind, {
            attempt_id: attempt,
            tool_call_id: 'late',
            tool: 'salaam_station',
          }),
        );
    if (failure === 'other-ledger')
      set(
        "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,revision,created_at) VALUES('m',?,1,?,'m',?,?,?,?,1,'s','t','p','{}','returned',1,0)",
        f.session,
        attempt,
        ...Array(4).fill('a'.repeat(64)),
      );
    expect(() => failBudget(x, 'reject-known')).toThrow();
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
  } finally {
    f.close();
  }
});
