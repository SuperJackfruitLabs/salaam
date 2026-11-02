import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Artifacts } from '../../src/store/artifacts.js';
import { digest } from '../../src/core/protocol.js';
import { knownEffectFailureFixture } from './agentpod-work-helpers.js';
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

// Journal conformance fixture, not a native process or live producer proof.
async function unreportedSuccessFixture() {
  const x = await knownEffectFailureFixture(),
    { f, admitted } = x;
  const artifacts = new Artifacts(join(f.state, 'artifacts'), f.store);
  f.store.db.prepare("UPDATE attempts SET state='completed',error=NULL").run();
  f.store.db
    .prepare("UPDATE task_steps SET state='completed' WHERE task_id=?")
    .run(admitted.task_id);
  f.store.db.prepare("UPDATE durable_tasks SET state='succeeded' WHERE id=?").run(admitted.task_id);
  const task = f.tasks.get(admitted.task_id),
    root = digest(f.binding),
    tree = 'd'.repeat(64),
    configuration = 'b'.repeat(64);
  f.store.transaction(() => {
    const result = { ok: true, exit_code: 0 };
    f.store.db
      .prepare(
        "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,result_json,helper_state) VALUES('historical-check',?,1,(SELECT id FROM attempts LIMIT 1),'historical-check','check',?,?,?,'{}','returned',?,'stopped')",
      )
      .run(f.session, 'c'.repeat(64), root, configuration, JSON.stringify(result));
    const artifact = artifacts.prepare(
      f.session,
      JSON.stringify({
        version: 1,
        backend: 'linux-systemd-station-v1',
        check_id: 'historical-check-id',
        call_id: 'historical-check',
        plan_revision: 1,
        root_digest: root,
        configuration_digest: configuration,
        tree_digest: tree,
        result_digest: digest(result),
      }),
    );
    artifact.commit();
    f.store.db
      .prepare('INSERT INTO task_checks VALUES (?,?,NULL,?,1,?,0,?,?,?,NULL,?,?)')
      .run(
        'historical-check-id',
        task.id,
        task.acceptance[0]?.key ?? 'check',
        'station:' + root,
        tree,
        'profile',
        'linux-systemd-station-v1',
        'passed',
        artifact.id,
      );
    const completion = artifacts.prepare(
      f.session,
      JSON.stringify({
        task_id: task.id,
        plan_revision: 1,
        workspace: { id: 'station:' + root, revision: 0, digest: tree },
        checks: ['historical-check-id'],
        deliverables: [],
        diff: {
          backend: 'linux-systemd-station-v1',
          root_digest: root,
          configuration_digest: configuration,
          workspace_digest: tree,
        },
        exception: null,
        missing_requirements: [],
        verified: true,
      }),
    );
    completion.commit();
    f.store.db
      .prepare('INSERT INTO task_completions VALUES(?,1,?,0,?,?,?,NULL)')
      .run(task.id, 'station:' + root, tree, completion.id, 'succeeded');
  });
  return x;
}

test('unreported local success retires only producer ownership and preserves success across replay/restart', async () => {
  const { f, admitted } = await unreportedSuccessFixture();
  try {
    const request = randomUUID(),
      run = () => f.work.abandon(f.binding, request, admitted.request_id, 'a'.repeat(64));
    const before = JSON.stringify(f.store.db.prepare('SELECT * FROM task_completions').all());
    const receipt = run();
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/agentpod-work-abandon-v1.json', import.meta.url), 'utf8'),
    );
    expect(receipt).toEqual({
      ...fixture.receipt,
      request_id: request,
      work_request_id: admitted.request_id,
      session_id: f.session,
      task_id: admitted.task_id,
      binding_digest: digest(f.binding),
      evidence_digest: receipt.evidence_digest,
    });
    expect(f.tasks.get(admitted.task_id).state).toBe('succeeded');
    expect(JSON.stringify(f.store.db.prepare('SELECT * FROM task_completions').all())).toBe(before);
    f.reopen();
    expect(run()).toEqual(receipt);
    expect(() => f.work.abandon(f.binding, request, admitted.request_id, 'b'.repeat(64))).toThrow();
    await expect(f.work.completion(f.binding)).rejects.toThrow();
  } finally {
    f.close();
  }
});

test.each(['interrupted', 'unknown', 'check-drift', 'exception', 'unconfirmed', 'incomplete'])(
  'unreported local success refuses %s',
  async (failure) => {
    const { f, admitted } = await unreportedSuccessFixture();
    try {
      if (failure === 'interrupted')
        f.store.db.prepare("UPDATE attempts SET state='interrupted'").run();
      if (failure === 'unknown')
        f.store.db.prepare("UPDATE operations SET state='outcome_unknown'").run();
      if (failure === 'check-drift')
        f.store.db.prepare("UPDATE task_checks SET workspace_digest='changed'").run();
      if (failure === 'exception')
        f.store.db.prepare("UPDATE task_completions SET exception='{}'").run();
      if (failure === 'unconfirmed')
        f.store.db.prepare("UPDATE station_calls SET helper_state='unconfirmed'").run();
      if (failure === 'incomplete')
        f.store.db.prepare("UPDATE durable_tasks SET state='blocked'").run();
      expect(() =>
        f.work.abandon(f.binding, randomUUID(), admitted.request_id, 'a'.repeat(64)),
      ).toThrow();
      expect(
        f.store.db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-abandonment'").get(),
      ).toBeUndefined();
    } finally {
      f.close();
    }
  },
);

test.each(['stopped-inspection', 'unconfirmed', 'mutation', 'unknown'])(
  'historical success retirement treats cancelled read as %s',
  async (variant) => {
    const { f, admitted } = await unreportedSuccessFixture();
    try {
      f.store.db
        .prepare(
          "INSERT INTO station_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,kind,input_digest,root_digest,configuration_digest,args_json,state,helper_state) VALUES('cancelled-inspection',?,1,(SELECT id FROM attempts LIMIT 1),'cancelled-inspection','read',?,?,?,?,'cancelled',?)",
        )
        .run(
          f.session,
          'c'.repeat(64),
          digest(f.binding),
          'b'.repeat(64),
          JSON.stringify({ action: variant === 'mutation' ? 'patch' : 'inspect' }),
          variant === 'unconfirmed' ? 'unconfirmed' : 'stopped',
        );
      if (variant === 'unknown')
        f.store.db
          .prepare(
            "UPDATE station_calls SET state='outcome_unknown' WHERE id='cancelled-inspection'",
          )
          .run();
      const run = () =>
        f.work.abandon(f.binding, randomUUID(), admitted.request_id, 'a'.repeat(64));
      if (variant === 'stopped-inspection') expect(run().state).toBe('retired');
      else expect(run).toThrow();
      expect(f.tasks.get(admitted.task_id).state).toBe('succeeded');
    } finally {
      f.close();
    }
  },
);
