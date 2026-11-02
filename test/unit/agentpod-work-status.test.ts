import { expect, test, vi } from 'vitest';
import {
  fixture,
  settlementDriver,
  refusedWritesFixture,
  failRefused,
} from './agentpod-work-helpers.js';
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

// Approval scopes: an operation the run grant answered is recorded on the card with the grant.
test('work status shows a write the run grant approved, and which grant allowed it', async () => {
  const f = fixture();
  try {
    f.run();
    f.store.transaction(() =>
      f.store.event(f.session, 'permission.auto-approved', {
        rule: 'run-grant',
        grant_id: 'grant-1',
        granted_by: 'prn_human',
        operation_id: 'op-1',
        operation_digest: 'd'.repeat(64),
      }),
    );
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
    };
    expect(status.activity.at(-1)).toEqual({
      seq: expect.any(Number),
      phase: 'finished',
      tool_call_id: 'approval:op-1',
      title: 'Approved by the run grant (granted by prn_human)',
      kind: null,
      input: null,
      failed: false,
    });
  } finally {
    f.close();
  }
});

test('work status shows a write an agent rule allowed, and who set the rule', async () => {
  const f = fixture();
  try {
    f.run();
    f.store.transaction(() =>
      f.store.event(f.session, 'permission.auto-approved', {
        rule: 'agent-rule',
        rule_id: 'r1',
        set_by: 'prn_owner',
        operation_id: 'op-2',
        operation_digest: 'd'.repeat(64),
      }),
    );
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
    };
    expect(status.activity.at(-1)).toMatchObject({
      tool_call_id: 'approval:op-2',
      title: "Allowed by the agent's standing rule (set by prn_owner)",
    });
  } finally {
    f.close();
  }
});

// Card 9 (card_81a3e7a5f62b4564): the owner settles a stopped run automatically only when Salaam
// says up front it can prove it. Status carries that verdict, computed by the same checks as fail,
// and changes nothing.
test('work status says when a stopped run can retire with known effects, and changes nothing', async () => {
  const x = refusedWritesFixture();
  try {
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as {
      settlement_ready?: string;
    };
    expect(status.settlement_ready).toBe('known_effects_failure');
    expect(x.f.tasks.get(x.admitted.task_id).state).toBe('blocked');
    expect(
      x.f.store.db
        .prepare('SELECT count(*) AS n FROM events WHERE kind=\x27agentpod.work_failed\x27')
        .get()!.n,
    ).toBe(0);
    expect(failRefused(x)).toMatchObject({ effects: 'known_effects_preserved' });
  } finally {
    x.f.close();
  }
});

test('work status names the guard that refuses a stopped run', async () => {
  const x = refusedWritesFixture();
  try {
    x.f.store.db
      .prepare("UPDATE task_runtime SET blocked_reason='Task request limit reached'")
      .run();
    const status = (await x.f.work.status(x.f.binding, settlementDriver(x.f))) as unknown as Record<
      string,
      unknown
    >;
    expect('settlement_ready' in status).toBe(false);
    expect(String(status.settlement_refused)).toMatch(/^work_settlement_unsafe: Only exact/);
  } finally {
    x.f.close();
  }
});

test.each(['runtime-not-exceeded', 'other-block'])(
  'work status gives no settlement verdict for a run fail would refuse (%s)',
  async (failure) => {
    const x = refusedWritesFixture();
    try {
      if (failure === 'runtime-not-exceeded')
        x.f.store.db.prepare('UPDATE task_runtime SET started_at=?').run(Date.now());
      else
        x.f.store.db
          .prepare('UPDATE task_runtime SET blocked_reason=\x27Task request limit reached\x27')
          .run();
      const status = (await x.f.work.status(
        x.f.binding,
        settlementDriver(x.f),
      )) as unknown as Record<string, unknown>;
      expect('settlement_ready' in status).toBe(false);
      expect(() => failRefused(x)).toThrow();
    } finally {
      x.f.close();
    }
  },
);

test('a live run has no settlement verdict', async () => {
  const f = fixture();
  try {
    f.run();
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as Record<
      string,
      unknown
    >;
    expect('settlement_ready' in status).toBe(false);
  } finally {
    f.close();
  }
});

test.each(['execution-running', 'plan-changed'])(
  'work status gives no settlement verdict when the stop or the plan does not hold (%s)',
  async (failure) => {
    const x = refusedWritesFixture();
    try {
      if (failure === 'execution-running')
        x.f.store.db.prepare('DELETE FROM session_revocations WHERE session_id=?').run(x.f.session);
      else {
        const row = x.f.store.db
          .prepare('SELECT admission_json FROM agentpod_work WHERE session_id=?')
          .get(x.f.session)!;
        const admission = JSON.parse(String(row.admission_json));
        admission.work.plan_digest = 'f'.repeat(64);
        x.f.store.db
          .prepare('UPDATE agentpod_work SET admission_json=? WHERE session_id=?')
          .run(JSON.stringify(admission), x.f.session);
      }
      const status = (await x.f.work
        .status(x.f.binding, settlementDriver(x.f))
        .catch(() => ({}))) as Record<string, unknown>;
      expect('settlement_ready' in status).toBe(false);
    } finally {
      x.f.close();
    }
  },
);

test('work status shows a paused fetch host on the card, and the run goes on', async () => {
  const f = fixture();
  try {
    f.run();
    f.store.transaction(() =>
      f.store.event(f.session, 'fetch.host_paused', {
        attempt_id: 'a1',
        host: 'flaky.example',
        failures: 3,
        pause_ms: 60000,
      }),
    );
    const status = (await f.work.status(f.binding, settlementDriver(f))) as unknown as {
      activity: Record<string, unknown>[];
    };
    expect(status.activity.at(-1)).toMatchObject({
      phase: 'finished',
      title: 'Paused requests to flaky.example for 60s after 3 failures',
      failed: false,
    });
  } finally {
    f.close();
  }
});
