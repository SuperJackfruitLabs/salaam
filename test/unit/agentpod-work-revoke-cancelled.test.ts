import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ManagedWork } from '../../src/execution/managed.js';
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

// A strict attempt stopped by its owner revoking authority (for example a hub restart):
// the revocation cancelled the attempt, and nothing but journaled operator MCP calls ran.
function revokeCancelledFixture(calls = 2) {
  const f = fixture();
  const admitted = f.run();
  const task = f.tasks.get(admitted.task_id),
    step = task.steps[0]!;
  const attempt = f.store.transaction(() => {
    const a = f.store.enqueue(f.session, randomUUID(), step.instruction, undefined, null, step.id);
    f.store.db
      .prepare('INSERT INTO task_step_attempts VALUES(?,?,?,?)')
      .run(a.attempt_id, step.id, task.plan_revision, step.instruction);
    f.store.db
      .prepare("UPDATE task_steps SET state='running',attempt_id=? WHERE id=?")
      .run(a.attempt_id, step.id);
    return a.attempt_id;
  });
  f.store.db.prepare("UPDATE attempts SET state='running',worker_epoch=1 WHERE id=?").run(attempt);
  const tool = (id: string, call: boolean) =>
    f.store.transaction(() => {
      f.store.event(f.session, 'model.admitted', { attempt_id: attempt, epoch: 1 });
      f.store.event(f.session, 'tool.started', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: 'salaam_operator_mcp',
        phase: 'started',
      });
      f.store.event(f.session, 'policy.allowed', {
        attempt_id: attempt,
        epoch: 1,
        tool: 'salaam_operator_mcp',
      });
      if (call)
        f.store.event(f.session, 'operator_mcp.call', {
          attempt_id: attempt,
          server: 'fetch',
          tool: 'fetch',
          argument_digest: 'a'.repeat(64),
          outcome: 'returned',
          result_digest: 'b'.repeat(64),
        });
      f.store.event(f.session, 'tool.finished', {
        attempt_id: attempt,
        worker_epoch: 1,
        tool_call_id: id,
        tool: 'salaam_operator_mcp',
        phase: 'finished',
        failed: false,
      });
    });
  tool('catalog', false);
  for (let i = 0; i < calls; i++) tool('fetch-' + i, true);
  const managed = new ManagedWork(f.store, {
    assertActive() {},
    reply() {},
    failed() {},
    approvalTtlMs: 60000,
  });
  f.store.transaction(() =>
    f.store.execution.revokeInTransaction(
      f.session,
      'restart-revoke',
      'Hub restarted; owner stopped',
      (id) => managed.cancelInTransaction(id, 'agentpod-revocation', 'agentpod-node'),
    ),
  );
  void managed.close();
  f.store.finish(attempt, 'cancelled', null, 'Pi exited (0)');
  f.store.db.prepare("UPDATE task_steps SET state='cancelled' WHERE id=?").run(step.id);
  f.store.db.prepare("UPDATE durable_tasks SET state='blocked' WHERE id=?").run(task.id);
  f.store.db.prepare("UPDATE workers SET state='exited' WHERE session_id=?").run(f.session);
  f.work.verification.budget.block(f.session, 'Task runtime limit reached');
  f.authority.revoke(f.binding, 'restart-revoke', 'Hub restarted; owner stopped');
  return { f, admitted, attempt, task };
}

test('revoke-cancelled attempt with only journaled operator MCP calls retires and replays', () => {
  const { f, admitted, attempt } = revokeCancelledFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'revoke-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(attempt)).toMatchObject({ state: 'cancelled', resolved_by: null });
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    expect(
      f.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='operator_mcp.call'").get()!
        .n,
    ).toBe(2);
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    f.close();
  }
});

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'two-attempts',
  'attempt-not-cancelled',
  'local-cancel',
  'not-in-revocation',
  'unresolved-in-revocation',
  'cancel-after-revoke',
  'tool-after-cancel',
  'open-tool',
  'other-tool',
  'two-mcp-calls-in-one-tool',
  'mcp-call-outside-tool',
  'step-not-cancelled',
  'checks',
  'completion',
  'operation',
  'local-call',
  'command-run',
  'unbound-resource',
  'child',
])('revoke-cancelled retirement rejects %s', (failure) => {
  const { f, admitted, attempt, task } = revokeCancelledFixture();
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const event = (kind: string, payload: object) =>
      f.store.transaction(() => f.store.event(f.session, kind, payload));
    const fill = (table: string) => {
      db.exec('PRAGMA foreign_keys=OFF');
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const names = cols
        .filter((c) => c.notnull || c.pk || c.name === 'session_id')
        .map((c) => c.name);
      db.prepare(
        `INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
      ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      db.exec('PRAGMA foreign_keys=ON');
    };
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_tokens=1').run();
    if (failure === 'two-attempts') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('other',?,'other-submission','cancelled',1)",
      ).run(f.session);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'attempt-not-cancelled')
      db.prepare("UPDATE attempts SET state='interrupted' WHERE id=?").run(attempt);
    if (failure === 'local-cancel')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'not-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.attempt_ids',json('[]'))",
      ).run();
    if (failure === 'unresolved-in-revocation')
      db.prepare(
        "UPDATE session_revocations SET receipt=json_set(receipt,'$.unresolved_operations',json('[\"op\"]'))",
      ).run();
    if (failure === 'cancel-after-revoke') {
      db.prepare("DELETE FROM events WHERE kind='attempt.cancel_requested'").run();
      f.store.transaction(() =>
        f.store.event(
          f.session,
          'attempt.cancel_requested',
          { attempt_id: attempt },
          'agentpod-revocation',
        ),
      );
    }
    if (failure === 'tool-after-cancel')
      for (const kind of ['tool.started', 'tool.finished'])
        event(kind, { attempt_id: attempt, tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','bash') WHERE kind='tool.started' AND json_extract(payload,'$.tool_call_id')='fetch-0'",
      ).run();
    if (failure === 'two-mcp-calls-in-one-tool')
      (db
        .prepare(
          "DELETE FROM events WHERE kind IN ('tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-0'",
        )
        .run(),
        db
          .prepare(
            "DELETE FROM events WHERE kind IN ('tool.started') AND json_extract(payload,'$.tool_call_id')='fetch-1'",
          )
          .run(),
        db
          .prepare(
            "UPDATE events SET payload=json_set(payload,'$.tool_call_id','fetch-0') WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
          )
          .run());
    if (failure === 'mcp-call-outside-tool')
      db.prepare(
        "DELETE FROM events WHERE kind IN ('tool.started','tool.finished','policy.allowed') AND seq IN (SELECT seq FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0' OR (kind='policy.allowed' AND seq BETWEEN (SELECT min(seq) FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0') AND (SELECT max(seq) FROM events WHERE json_extract(payload,'$.tool_call_id')='fetch-0')))",
      ).run();
    if (failure === 'step-not-cancelled')
      db.prepare("UPDATE task_steps SET state='completed'").run();
    if (failure === 'checks') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
      ).run(task.id, task.steps[0]!.id, a64, a64);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'completion') {
      db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(
        "INSERT INTO task_completions(task_id,plan_revision,workspace_id,workspace_revision,workspace_digest,artifact_id,state) VALUES(?,1,'ws',0,?,'art','verified')",
      ).run(task.id, a64);
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'workspace',?,'succeeded',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, attempt, a64);
    if (failure === 'local-call') fill('local_calls');
    if (failure === 'command-run') {
      fill('command_runs');
      db.prepare("UPDATE command_runs SET state='succeeded'").run();
    }
    if (failure === 'unbound-resource')
      db.prepare(
        "INSERT INTO station_units(id,session_id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',NULL,?,'{}','/tmp/source','/tmp/output','unconfirmed')",
      ).run(a64);
    if (failure === 'child') {
      const child = f.store.create('/tmp/child', randomUUID());
      db.prepare(
        "INSERT INTO child_tasks(id,parent_session,parent_attempt,step_key,input_digest,child_session,child_attempt,authority,budget,state) VALUES('child',?,?,'child',?,?,?,'{}',1,'running')",
      ).run(f.session, attempt, a64, child.id, attempt);
    }
    expect(() =>
      f.work.fail(
        f.binding,
        'reject-revoke',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow('revoke-cancelled operator MCP reads');
    expect(f.tasks.get(admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
