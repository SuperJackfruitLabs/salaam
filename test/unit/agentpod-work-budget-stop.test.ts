import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

test('an attempt the request budget stopped, with only failed operator MCP calls, retires and replays', () => {
  const x = budgetStopFixture();
  try {
    const receipt = failBudget(x);
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.store.attempt(x.attempt)).toMatchObject({ state: 'interrupted', resolved_by: null });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failBudget(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test('parallel operator MCP tools with failed calls also retire', () => {
  const x = budgetStopFixture(true);
  try {
    expect(failBudget(x)).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
  } finally {
    x.f.close();
  }
});

test.each(['call-in-station-tool', 'more-calls-than-tools'])(
  'request-budget retirement with parallel tools rejects %s',
  (failure) => {
    const x = budgetStopFixture(true);
    const { f, attempt } = x;
    try {
      const db = f.store.db;
      if (failure === 'call-in-station-tool') {
        // The only open tool is a station read, so the call belongs to no operator MCP tool.
        db.prepare(
          "UPDATE events SET payload=json_set(payload,'$.tool','salaam_station') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id') IN ('fetch-1','fetch-2')",
        ).run();
      }
      if (failure === 'more-calls-than-tools')
        db.prepare(
          "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-2'",
        ).run();
      expect(attempt).toBeTruthy();
      expect(() => failBudget(x, 'reject-parallel')).toThrow(
        'request budget stopped operator MCP reads',
      );
      expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    } finally {
      f.close();
    }
  },
);

test.each([
  'not-blocked',
  'auto-enabled',
  'reserved',
  'two-attempts',
  'other-error',
  'not-interrupted',
  'step-not-interrupted',
  'unhealthy-other-error',
  'missing-interrupted-event',
  'cancelled-by-someone',
  'tool-after-stop',
  'open-tool',
  'other-tool',
  'returned-call',
  'two-calls-in-one-tool',
  'operation',
  'patch-call',
  'local-call',
  'unbound-resource',
  'child',
  'checks',
])('request-budget retirement rejects %s', (failure) => {
  const x = budgetStopFixture();
  const { f, attempt, task } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    const event = (kind: string, payload: object) =>
      f.store.transaction(() => f.store.event(f.session, kind, payload));
    if (failure === 'not-blocked') db.prepare("UPDATE durable_tasks SET state='failed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'reserved') db.prepare('UPDATE task_runtime SET reserved_tokens=1').run();
    if (failure === 'two-attempts')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO attempts(id,session_id,submission_id,state,worker_epoch) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff',?,'other-submission','failed',1)",
          )
          .run(f.session),
      );
    if (failure === 'other-error')
      db.prepare(
        "UPDATE attempts SET error='Required control failed: something else' WHERE id=?",
      ).run(attempt);
    if (failure === 'not-interrupted')
      db.prepare("UPDATE attempts SET state='failed' WHERE id=?").run(attempt);
    if (failure === 'step-not-interrupted')
      db.prepare("UPDATE task_steps SET state='completed'").run();
    if (failure === 'unhealthy-other-error')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.error','unknown') WHERE kind='worker.unhealthy'",
      ).run();
    if (failure === 'missing-interrupted-event')
      db.prepare("DELETE FROM events WHERE kind='attempt.interrupted'").run();
    if (failure === 'cancelled-by-someone')
      withoutKeys(() =>
        db.prepare("INSERT INTO cancellations VALUES(?,'local-operator')").run(attempt),
      );
    if (failure === 'tool-after-stop')
      for (const kind of ['tool.started', 'tool.finished'])
        event(kind, { attempt_id: attempt, tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_files') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='inspect-1'",
      ).run();
    if (failure === 'returned-call')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.outcome','returned') WHERE kind='operator_mcp.call' AND seq=(SELECT min(seq) FROM events WHERE kind='operator_mcp.call')",
      ).run();
    if (failure === 'two-calls-in-one-tool') {
      // Both journaled calls fall inside one closed tool.
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
      db.prepare(
        "DELETE FROM events WHERE kind='tool.started' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool_call_id','fetch-1') WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='fetch-2'",
      ).run();
    }
    if (failure === 'operation')
      db.prepare(
        "INSERT INTO operations(id,session_id,attempt_id,kind,operation_digest,state,revision,worker_epoch,tool_call_id,action_key,argument_digest,target,value,target_version,policy_digest,connector,replay) VALUES('op',?,?,'review',?,'cancelled_before_dispatch',1,1,'call','action','digest','target','{}','1','policy','fixture','none')",
      ).run(f.session, attempt, a64);
    if (failure === 'patch-call')
      db.prepare("UPDATE station_calls SET kind='patch' WHERE id='inspect-1'").run();
    if (failure === 'local-call')
      withoutKeys(() => {
        const cols = db.prepare('PRAGMA table_info(local_calls)').all() as {
          name: string;
          notnull: number;
          pk: number;
        }[];
        const names = cols
          .filter((c) => c.notnull || c.pk || c.name === 'session_id')
          .map((c) => c.name);
        db.prepare(
          `INSERT INTO local_calls(${names.join(',')}) VALUES(${names.map(() => '?').join(',')})`,
        ).run(...names.map((n) => (n === 'session_id' ? f.session : n === 'id' ? 'x' : '1')));
      });
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
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,command_run_id,state,artifact_id) VALUES('chk',?,?,'tests',1,'ws',0,?,?,'e','cr','passed','art')",
          )
          .run(task.id, task.steps[0]!.id, a64, a64),
      );
    expect(() => failBudget(x, 'reject-budget')).toThrow(
      'request budget stopped operator MCP reads',
    );
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});
