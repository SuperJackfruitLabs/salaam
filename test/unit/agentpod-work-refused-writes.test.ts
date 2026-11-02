import { expect, test, vi } from 'vitest';
import { refusedWritesFixture, failRefused } from './agentpod-work-helpers.js';
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

test('a runtime-stopped attempt whose approved writes were all refused before the boundary retires and replays', () => {
  const x = refusedWritesFixture();
  try {
    const receipt = failRefused(x);
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('cancelled');
    x.f.reopen();
    expect(failRefused(x)).toEqual(receipt);
  } finally {
    x.f.close();
  }
});

test.each([
  'runtime-not-exceeded',
  'other-block',
  'not-cancelled',
  'other-error',
  'cancelled-by-someone',
  'write-succeeded',
  'write-failed-otherwise',
  'refused-without-approval',
  'refused-but-denied',
  'mcp-call-in-station-tool',
  'tool-started-during-stop',
  'refused-call-returned',
  'refused-call-other-code',
  'refused-call-unstopped',
  'not-sent-call-dispatched',
  'other-operation-kind',
  'other-station-call',
  'returned-mcp-outside-tool',
  'tool-after-cancel',
  'open-tool',
  'other-tool',
  'mcp-ledger-row',
  'checks',
])('runtime-stopped refused-write retirement rejects %s', (failure) => {
  const x = refusedWritesFixture();
  const { f, attempt, task } = x;
  try {
    const db = f.store.db,
      a64 = 'a'.repeat(64);
    const withoutKeys = (fn: () => void) => {
      db.exec('PRAGMA foreign_keys=OFF');
      fn();
      db.exec('PRAGMA foreign_keys=ON');
    };
    const ev = (kind: string, payload: object) =>
      f.store.transaction(() =>
        f.store.event(f.session, kind, { attempt_id: attempt, ...payload }),
      );
    if (failure === 'runtime-not-exceeded')
      db.prepare('UPDATE task_runtime SET started_at=?').run(Date.now());
    if (failure === 'other-block')
      db.prepare("UPDATE task_runtime SET blocked_reason='Task request limit reached'").run();
    if (failure === 'not-cancelled')
      db.prepare("UPDATE attempts SET state='interrupted' WHERE id=?").run(attempt);
    if (failure === 'other-error')
      db.prepare("UPDATE attempts SET error='Pi exited (1)' WHERE id=?").run(attempt);
    if (failure === 'cancelled-by-someone')
      db.prepare("UPDATE cancellations SET requested_by='local-operator'").run();
    if (failure === 'write-succeeded')
      db.prepare("UPDATE operations SET state='succeeded' WHERE id='op-1'").run();
    if (failure === 'write-failed-otherwise')
      db.prepare("UPDATE operations SET error='Station helper exited (1)' WHERE id='op-2'").run();
    if (failure === 'refused-without-approval')
      db.prepare("UPDATE approvals SET state='invalidated',decision=NULL WHERE id='ap-1'").run();
    if (failure === 'refused-but-denied')
      db.prepare("UPDATE approvals SET decision='deny' WHERE id='ap-2'").run();
    if (failure === 'mcp-call-in-station-tool')
      // The fetch's journaled call then sits inside a station tool, not an operator MCP one.
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_station') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='fetch-1'",
      ).run();
    if (failure === 'tool-started-during-stop') {
      // A tool that starts after the stop was requested, closed before the cancellation.
      ev('tool.started', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      ev('tool.finished', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      db.prepare(
        "UPDATE events SET seq=(SELECT max(seq) FROM events)+10 WHERE session_id=? AND kind='attempt.cancelled'",
      ).run(f.session);
    }
    if (failure === 'refused-call-returned')
      db.prepare("UPDATE station_calls SET state='returned' WHERE id='write-1'").run();
    if (failure === 'refused-call-other-code')
      db.prepare(
        'UPDATE station_calls SET result_json=\'{"code":"station_execution_unconfirmed"}\' WHERE id=\'write-2\'',
      ).run();
    if (failure === 'refused-call-unstopped')
      db.prepare("UPDATE station_calls SET helper_state='running' WHERE id='write-1'").run();
    if (failure === 'not-sent-call-dispatched')
      db.prepare("UPDATE station_calls SET state='failed' WHERE id='write-3'").run();
    if (failure === 'other-operation-kind')
      db.prepare("UPDATE operations SET kind='command' WHERE id='op-1'").run();
    if (failure === 'other-station-call')
      db.prepare("UPDATE station_calls SET kind='check' WHERE id='read-1'").run();
    if (failure === 'returned-mcp-outside-tool')
      ev('operator_mcp.call', { server: 'fetch', tool: 'fetch', outcome: 'returned' });
    if (failure === 'tool-after-cancel') {
      ev('tool.started', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
      ev('tool.finished', { tool_call_id: 'late', tool: 'salaam_operator_mcp' });
    }
    if (failure === 'open-tool')
      db.prepare(
        "DELETE FROM events WHERE kind='tool.finished' AND json_extract(payload,'$.tool_call_id')='write-3'",
      ).run();
    if (failure === 'other-tool')
      db.prepare(
        "UPDATE events SET payload=json_set(payload,'$.tool','salaam_files') WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool_call_id')='read-1'",
      ).run();
    if (failure === 'mcp-ledger-row')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO mcp_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,input_digest,binding_digest,profile_digest,assignment_digest,credential_generation,server_name,tool_name,policy,arguments_json,state,revision,created_at) VALUES('m',?,1,?,'m',?,?,?,?,1,'s','t','p','{}','returned',1,0)",
          )
          .run(f.session, attempt, a64, a64, a64, a64),
      );
    if (failure === 'checks')
      withoutKeys(() =>
        db
          .prepare(
            "INSERT INTO task_checks(id,task_id,step_id,check_key,plan_revision,workspace_id,workspace_revision,workspace_digest,profile_digest,engine_id,state) VALUES('c',?,?,'k',1,'w',1,?,?,'e','passed')",
          )
          .run(task.id, task.steps[0]!.id, a64, a64),
      );
    expect(() => failRefused(x, 'reject-refused')).toThrow(
      'runtime-stopped refused workspace writes',
    );
    expect(f.tasks.get(x.admitted.task_id).state).not.toBe('cancelled');
  } finally {
    f.close();
  }
});
