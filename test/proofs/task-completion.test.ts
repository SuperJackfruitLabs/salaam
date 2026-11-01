import { expect, test } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskFixture, checkedPlan } from '../task-helpers.js';
import { until, ready } from '../helpers.js';
import { readTree } from '../../src/workers/workspaces.js';
import { digest } from '../../src/core/protocol.js';
import { call } from '../../src/core/transport.js';

test('completion requires fresh command receipts and deliverables; edits invalidate previous success', async () => {
  const f = await taskFixture();
  try {
    await f.plan();
    await f.run();
    await f.settled();
    await expect(f.action('finish')).rejects.toThrow('Every step');
    await f.review();
    await expect(f.action('finish')).rejects.toThrow('Fresh check');
    const receipt = await f.verify();
    expect(
      receipt.state,
      receipt.artifact_id ? f.service.artifacts.read(receipt.artifact_id) : JSON.stringify(receipt),
    ).toBe('passed');
    const evidence = JSON.parse(f.service.artifacts.read(receipt.artifact_id!));
    expect(evidence).toMatchObject({
      exit_code: 0,
      state: 'succeeded',
      profile_digest: f.backend.profileDigest,
      engine_id: f.backend.engineId,
      environment: { fixture: true },
    });
    expect(evidence.diff_digest).toMatch(/^[a-f0-9]{64}$/);
    const completed = await f.action('finish');
    expect(completed.state).toBe('succeeded');
    const profile = f.backend.profileDigest;
    f.backend.profileDigest = 'changed-profile';
    expect((await f.task()).state).toBe('blocked');
    f.backend.profileDigest = profile;
    const w = f.service.workspaces.get(f.session.id);
    writeFileSync(join(w.root, 'app.js'), 'human edit after verification\n');
    const stale = await f.task();
    expect(stale.state).toBe('blocked');
    expect(stale.verification.completion.fresh).toBe(false);
    await expect(f.action('finish')).rejects.toThrow('Fresh check');
    f.service.workspaces.refresh(
      f.session.id,
      'ack',
      w.revision,
      digest(readTree(w.root)),
      () => {},
    );
    expect(f.service.taskVerification.fresh(receipt)).toBe(false);
    expect((await f.verify()).state).toBe('passed');
    expect((await f.action('finish')).state).toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('failing tests and foreign evidence cannot become verified success; an explicit exception is distinct', async () => {
  const f = await taskFixture();
  try {
    await f.plan();
    await f.run();
    await f.settled();
    await f.review();
    f.backend.exitOverride = 1;
    expect((await f.verify()).state).toBe('failed');
    await expect(f.action('finish')).rejects.toThrow('Fresh check');
    const other = f.service.store.create(f.source, 'foreign').id,
      foreign = f.service.artifacts.put(other, 'foreign attestation');
    await expect(
      f.action('finish', {
        exception: { reason: 'Unavailable fixture check', evidence_artifact: foreign },
      }),
    ).rejects.toThrow('belong');
    const evidence = f.service.artifacts.put(
      f.session.id,
      'Operator accepted the failing fixture check for this rehearsal only',
    );
    const result = await f.action('finish', {
      exception: { reason: 'Explicit rehearsal exception', evidence_artifact: evidence },
    });
    expect(result.state).toBe('succeeded_with_exception');
    const completion = JSON.parse(
      f.service.artifacts.read(result.verification.completion.artifact_id),
    );
    expect(completion.verified).toBe(false);
    expect(completion.missing_requirements).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  'bounded progression verifies every step and recovers settled evidence (token budget disabled: %s)',
  async (uncapped) => {
    const f = await taskFixture();
    try {
      await f.plan({ ...checkedPlan(2), ...(uncapped ? { limits: { token_units: null } } : {}) });
      await f.action('auto', { max_steps: 2, compact: true });
      const result = await until(
        f.task,
        (t) =>
          ['succeeded', 'blocked', 'partially_completed'].includes(t.state) &&
          !t.runtime.auto_enabled,
        15000,
      );
      expect(result.state, JSON.stringify({ reason: result.reason, runtime: result.runtime })).toBe(
        'succeeded',
      );
      expect(result.steps.every((s) => s.state === 'completed')).toBe(true);
      expect(result.runtime.remaining_steps).toBe(0);
      expect(f.backend.runs.size).toBe(3);
      expect([...f.backend.runs.values()].every((r) => r.launches === 1)).toBe(true);
      expect(
        f.service.store.db
          .prepare(
            "SELECT count(*) n FROM task_compactions WHERE skip_reason IS NOT NULL OR compaction_id IN (SELECT id FROM compactions WHERE state='completed')",
          )
          .get(),
      ).toMatchObject({ n: 1 });
      const before = f.service.store.snapshot(f.session.id).attempts.map((a) => a.id);
      await f.restart();
      expect((await f.task()).state).toBe('succeeded');
      expect(f.service.store.snapshot(f.session.id).attempts.map((a) => a.id)).toEqual(before);
      expect(f.backend.runs.size).toBe(3);
    } finally {
      await f.close();
    }
  },
);

test('a failing automatic check stops progression without repeating a command or admitting another step', async () => {
  const f = await taskFixture();
  try {
    await f.plan(checkedPlan(2));
    f.backend.exitOverride = 1;
    await f.action('auto', { max_steps: 2 });
    const result = await until(
      f.task,
      (t) => !t.runtime.auto_enabled && t.runtime.auto_error,
      10000,
    );
    expect(result.state).not.toBe('succeeded');
    expect(result.steps[1]!.attempt_id).toBeNull();
    expect(f.backend.runs.size).toBe(1);
    await f.restart();
    expect(f.backend.runs.size).toBe(1);
    expect((await f.task()).runtime.auto_enabled).toBe(0);
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  'task request exhaustion persists across restart and prevents later steps (token budget disabled: %s)',
  async (uncapped) => {
    const f = await taskFixture();
    try {
      const plan = {
        ...checkedPlan(2),
        limits: { requests: 1, ...(uncapped ? { token_units: null } : {}) },
      };
      await f.plan(plan);
      await f.action('auto', { max_steps: 2 });
      const result = await until(f.task, (t) => !!t.runtime.blocked_reason, 10000);
      expect(result.runtime.requests_spent).toBe(1);
      if (uncapped) expect(result.runtime.token_units).toBe(0);
      else expect(result.runtime.token_units).toBeGreaterThan(0);
      expect(result.steps[1]!.attempt_id).toBeNull();
      await f.restart();
      const restored = await f.task();
      expect(restored.runtime.requests_spent).toBe(1);
      expect(restored.runtime.blocked_reason).toContain('request limit');
      expect(restored.state).not.toBe('succeeded');
    } finally {
      await f.close();
    }
  },
);

test('checkpoint restore preserves pre-existing dirty bytes and newer human edits, with a partial outcome', async () => {
  const f = await taskFixture();
  try {
    await f.plan();
    const checkpoint = await f.action('checkpoint');
    // Two actual guarded patches run in one active task step through the pinned Pi file tool.
    let w = f.service.workspaces.get(f.session.id),
      tree = readTree(w.root);
    await f.run(
      0,
      '[files] ' +
        JSON.stringify({
          action: 'patch',
          path: 'app.js',
          expected_revision: w.revision,
          expected_hash: digest(tree['app.js']),
          content: 'task edit\n',
        }),
    );
    await f.settled();
    // Preserve task review and append a second explicit repair step.
    await f.review();
    const prior = await f.task();
    const plan = {
      ...checkedPlan(),
      steps: [
        checkedPlan().steps[0]!,
        {
          key: 'extra',
          title: 'Extra file',
          instruction: 'Add task file',
          depends_on: ['step-0'],
          checks: ['tests'],
        },
      ],
    };
    await f.action('revise', { plan });
    w = f.service.workspaces.get(f.session.id);
    tree = readTree(w.root);
    await f.run(
      1,
      '[files] ' +
        JSON.stringify({
          action: 'patch',
          path: 'task-only.txt',
          expected_revision: w.revision,
          expected_hash: null,
          content: 'owned task addition\n',
        }),
    );
    await f.settled(1);
    await f.review(1);
    w = f.service.workspaces.get(f.session.id);
    writeFileSync(join(w.root, 'app.js'), 'newer human edit\n');
    const restored = await f.action('restore', {
      checkpoint_id: checkpoint.id,
      workspace_revision: w.revision,
      workspace_digest: digest(readTree(w.root)),
    });
    expect(restored.state).toBe('partial');
    expect(restored.conflicts).toEqual(['app.js']);
    const current = f.service.workspaces.get(f.session.id),
      files = readTree(current.root);
    expect(readFileSync(join(current.root, 'app.js'), 'utf8')).toBe('newer human edit\n');
    expect(files['task-only.txt']).toBeUndefined();
    expect(readFileSync(join(current.root, 'human.txt'), 'utf8')).toBe('pre-existing dirty work\n');
    expect(readFileSync(join(f.source, 'app.js'), 'utf8')).toContain('answer = 42');
    await f.restart();
    expect(
      (
        await f.action('restore', {
          checkpoint_id: checkpoint.id,
          workspace_revision: current.revision,
          workspace_digest: current.digest,
        })
      ).state,
    ).toBe('partial');
  } finally {
    await f.close();
  }
});

test('a tool error the model recovers from does not fail its checked step; the error stays recorded', async () => {
  const f = await taskFixture();
  try {
    await f.plan();
    await f.run(0, '[files] {"action":"read","path":"no-such-file.txt"}');
    const t = await until(f.task, (t) =>
      ['awaiting_review', 'failed', 'interrupted'].includes(t.steps[0]!.state),
    );
    expect(t.steps[0]!.state).toBe('awaiting_review');
    const failed = f.service.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE session_id=? AND kind='tool.finished' AND json_extract(payload,'$.failed')=1",
      )
      .get(f.session.id)!.n;
    expect(failed).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
});
