import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { digest } from '../../src/core/protocol.js';
import { fixture, settlementDriver } from './agentpod-work-helpers.js';
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

// Journal conformance for the stopped native-child concurrency denial; no live provider.
function zeroEffectFailureFixture() {
  const f = fixture();
  const plan = { ...f.plan, limits: { ...f.tasks.parse(f.plan).limits, concurrency: 1 } };
  const admitted = f.run(
    { ...f.request, work: { ...f.request.work, plan_digest: digest(f.tasks.parse(plan)) } },
    f.input,
    plan,
  );
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const accepted = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES (?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db.prepare('UPDATE task_steps SET attempt_id=? WHERE id=?').run(a.attempt_id, step.id);
    return a;
  });
  const reason = 'Task concurrency limit reached';
  f.store.db.prepare('UPDATE attempts SET worker_epoch=1 WHERE id=?').run(accepted.attempt_id);
  f.store.transaction(() =>
    f.store.event(f.session, 'model.admitted', { attempt_id: accepted.attempt_id, epoch: 1 }),
  );
  f.store.transaction(() =>
    f.store.event(f.session, 'tool.started', {
      tool: 'spawn_child',
      tool_call_id: 'child-call',
      attempt_id: accepted.attempt_id,
      worker_epoch: 1,
    }),
  );
  f.store.transaction(() =>
    f.store.event(f.session, 'policy.allowed', {
      tool: 'spawn_child',
      attempt_id: accepted.attempt_id,
      epoch: 1,
    }),
  );
  f.store.db
    .prepare("UPDATE attempts SET state='interrupted',error=? WHERE id=?")
    .run('Pi exited (0)', accepted.attempt_id);
  f.store.db.prepare("UPDATE task_steps SET state='interrupted' WHERE id=?").run(step.id);
  f.store.db.prepare('UPDATE task_runtime SET requests_spent=1 WHERE task_id=?').run(task.id);
  f.work.verification.budget.block(f.session, reason);
  f.store.transaction(() => {
    f.store.event(f.session, 'worker.unhealthy', {
      epoch: 1,
      error: 'Required control failed: ' + reason,
    });
    f.store.event(f.session, 'attempt.interrupted', {
      attempt_id: accepted.attempt_id,
      error: 'Pi exited (0)',
    });
  });
  f.authority.revoke(f.binding, 'zero-revoke', 'Original failed run stopped');
  return { f, admitted, accepted };
}

test('zero-effect concurrency retirement preserves the exact interrupted journal and replays', () => {
  const { f, admitted, accepted } = zeroEffectFailureFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'zero-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const unit = 'a'.repeat(64);
    f.store.db
      .prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state,stop_json) VALUES(?,NULL,?,'{}','/tmp/source','/tmp/output','stopped',?)",
      )
      .run(
        unit,
        'b'.repeat(64),
        JSON.stringify({
          version: 1,
          unit: `salaam-station-${unit}.service`,
          cgroup: `/system.slice/salaam-station-${unit}.service`,
          invocation: 'c'.repeat(32),
          observed_empty: true,
        }),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(accepted.attempt_id)).toMatchObject({
      state: 'interrupted',
      resolved_by: null,
    });
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    expect(f.store.db.prepare('SELECT count(*) AS n FROM operations').get()!.n).toBe(0);
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    f.close();
  }
});

test.each([
  'foreign-binding',
  'active',
  'unknown-error',
  'wrong-budget',
  'missing-event',
  'changed-plan',
  'reservation',
  'checks',
  'operation',
  'mcp-call',
  'station-read',
  'toolkit-resource',
  'unbound-resource',
  'uncertain-child',
  'other-tool',
  'finished-tool',
  'unhealthy-mismatch',
  'spent-requests',
  'wrong-step-link',
  'orphan-child-worker',
  'orphan-external',
  'orphan-model-request',
])('zero-effect concurrency retirement rejects %s', (failure) => {
  const { f, admitted, accepted } = zeroEffectFailureFixture();
  try {
    const db = f.store.db;
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_repository') WHERE kind='tool.started'",
      ).run();
    if (failure === 'finished-tool')
      f.store.transaction(() => f.store.event(f.session, 'tool.finished', {}));
    if (failure === 'unhealthy-mismatch')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.error','unknown') WHERE kind='worker.unhealthy'",
      ).run();
    if (failure === 'spent-requests') db.prepare('UPDATE task_runtime SET requests_spent=2').run();
    if (failure === 'wrong-step-link')
      db.prepare('UPDATE task_step_attempts SET plan_revision=2').run();
    if (failure.startsWith('orphan-')) {
      db.exec('PRAGMA foreign_keys=OFF');
      if (failure === 'orphan-child-worker')
        db.prepare(
          "INSERT INTO child_workers(child_id,binding,binding_digest,dispatch_state) VALUES('missing','{}',?,'dispatching')",
        ).run('a'.repeat(64));
      if (failure === 'orphan-external')
        db.prepare(
          "INSERT INTO external_runs(child_id,run_id,state,epoch) VALUES('missing','run','running',1)",
        ).run();
      if (failure === 'orphan-model-request')
        db.prepare(
          "INSERT INTO external_model_requests(id,child_id,input_bytes,output_bound) VALUES('model','missing',1,1)",
        ).run();
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'active') db.prepare("UPDATE attempts SET state='running'").run();
    if (failure === 'unknown-error') db.prepare("UPDATE attempts SET error='unknown stop'").run();
    if (failure === 'wrong-budget')
      db.prepare("UPDATE task_runtime SET blocked_reason='different'").run();
    if (failure === 'missing-event')
      db.prepare("DELETE FROM events WHERE kind='work_task.budget_blocked'").run();
    if (failure === 'changed-plan') db.prepare("UPDATE task_steps SET instruction='changed'").run();
    if (failure === 'reservation') db.prepare('UPDATE task_runtime SET reserved_requests=1').run();
    if (failure === 'checks') db.prepare('UPDATE task_runtime SET verification_runs=1').run();
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'workspace',?,'outcome_unknown',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, accepted.attempt_id, 'a'.repeat(64));
    if (failure === 'mcp-call')
      db.prepare(
        "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,created_at) VALUES('mcp',?,1,?,'call',?,?,?, ?,1,'server','tool','read','{}','returned',1)",
      ).run(f.session, accepted.attempt_id, ...Array(4).fill('a'.repeat(64)));
    if (failure === 'station-read')
      db.prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state) VALUES('read',?,1,?,'read','read',?,?,?,'{}','returned')",
      ).run(f.session, accepted.attempt_id, ...Array(3).fill('a'.repeat(64)));
    if (failure === 'toolkit-resource')
      db.prepare(
        "INSERT INTO toolkit_resources(id,session_id,root_digest,profile_digest,state_dir,input_digest,spec,owner_boot,state) VALUES('resource',?,?,?,'/tmp/fixture',?,'{}','boot','unconfirmed')",
      ).run(f.session, ...Array(3).fill('a'.repeat(64)));
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run('a'.repeat(64));
    if (failure === 'uncertain-child') {
      const child = f.store.create('/tmp/child', randomUUID());
      const a = accepted;
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, accepted.attempt_id, 'a'.repeat(64), child.id, a.attempt_id);
    }
    const binding =
      failure === 'foreign-binding'
        ? { ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }
        : f.binding;
    expect(() =>
      f.work.fail(binding, 'reject-zero', admitted.request_id, 'a'.repeat(64), settlementDriver(f)),
    ).toThrow();
    expect(f.tasks.get(admitted.task_id).state).toBe('blocked');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
