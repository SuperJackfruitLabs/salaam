import { expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, textDigest } from '../../src/core/protocol.js';
import { settlementDriver, knownReadOnlyFailureFixture } from './agentpod-work-helpers.js';
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

test('known readonly non-success retirement preserves completed diagnostic history without claiming verification', async () => {
  const { f, admitted, child, children } = knownReadOnlyFailureFixture();
  try {
    const run = () =>
      f.work.fail(
        f.binding,
        'readonly-retire',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      );
    const receipt = run();
    expect(receipt).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
    expect(f.store.attempt(child.child_attempt).state).toBe('completed');
    expect(f.tasks.get(admitted.task_id).state).toBe('cancelled');
    f.reopen();
    expect(run()).toEqual(receipt);
  } finally {
    await children.close();
    f.close();
  }
});

test.each([
  'foreign-binding',
  'changed-plan',
  'auto-enabled',
  'unfinished-child',
  'child-coding',
  'child-binding',
  'child-result-bytes',
  'unknown-model',
  'orphan-budget',
  'unmatched-model',
  'mcp-approval',
  'mcp-unknown',
  'mcp-profile',
  'mcp-result-bytes',
  'unaccounted-mcp',
  'failed-check',
  'changed-command',
  'wrong-tree',
  'missing-unit-stop',
  'unit-uncertain',
  'unit-context',
  'helper-stop',
  'unaccounted-inspection',
  'write-call',
  'unknown-unit',
  'unaccounted-tool',
  'duplicate-tool-end',
  'orphan-external',
])('known readonly non-success retirement rejects %s', async (failure) => {
  const { f, admitted, accepted, child, children, receipts } = knownReadOnlyFailureFixture();
  try {
    const db = f.store.db;
    if (failure === 'changed-plan') db.prepare("UPDATE task_steps SET instruction='changed'").run();
    if (failure === 'auto-enabled') db.prepare('UPDATE task_runtime SET auto_enabled=1').run();
    if (failure === 'unfinished-child')
      db.prepare("UPDATE child_workers SET dispatch_state='dispatching' WHERE child_id=?").run(
        child.id,
      );
    if (failure === 'child-coding' || failure === 'child-binding') {
      const row = db.prepare('SELECT binding FROM child_workers WHERE child_id=?').get(child.id)!;
      const binding = JSON.parse(String(row.binding));
      if (failure === 'child-coding') {
        binding.capabilities.commands = true;
        binding.capability_digest = digest(binding.capabilities);
      } else binding.owner_task = 'foreign-task';
      db.prepare('UPDATE child_workers SET binding=?,binding_digest=? WHERE child_id=?').run(
        canonical(binding),
        digest(binding),
        child.id,
      );
    }
    if (failure === 'child-result-bytes') {
      const row = db.prepare('SELECT artifact_id FROM child_tasks WHERE id=?').get(child.id)!;
      writeFileSync(join(f.state, 'artifacts', String(row.artifact_id)), 'changed');
    }
    if (failure === 'unknown-model')
      db.prepare("UPDATE usage_observations SET status='unknown'").run();
    if (failure === 'orphan-budget' || failure === 'orphan-external') {
      db.exec('PRAGMA foreign_keys=OFF');
      if (failure === 'orphan-budget')
        db.prepare("INSERT INTO attempt_budgets VALUES('missing',1,0,0)").run();
      else
        db.prepare(
          "INSERT INTO external_runs(child_id,run_id,state,epoch) VALUES('missing','run','running',1)",
        ).run();
      db.exec('PRAGMA foreign_keys=ON');
    }
    if (failure === 'unmatched-model')
      f.store.transaction(() =>
        f.store.event(f.session, 'model.admitted', { attempt_id: accepted.attempt_id, epoch: 1 }),
      );
    if (failure === 'mcp-approval') db.prepare("UPDATE mcp_calls SET policy='approval'").run();
    if (failure === 'mcp-unknown') db.prepare("UPDATE mcp_calls SET state='outcome_unknown'").run();
    if (failure === 'mcp-profile')
      db.prepare('UPDATE mcp_calls SET profile_digest=?').run('f'.repeat(64));
    if (failure === 'mcp-result-bytes')
      writeFileSync(join(f.state, 'artifacts', receipts.result), 'changed');
    if (failure === 'unaccounted-mcp')
      db.prepare(
        "DELETE FROM events WHERE kind IN ('tool.started','tool.finished') AND json_extract(payload,'$.tool')='salaam_mcp'",
      ).run();
    if (failure === 'failed-check') db.prepare("UPDATE task_checks SET state='failed'").run();
    if (failure === 'changed-command')
      db.prepare(
        "UPDATE station_calls SET args_json=json_set(args_json,'$.command','different') WHERE kind='check'",
      ).run();
    if (failure === 'wrong-tree')
      db.prepare(
        "UPDATE station_calls SET result_json=json_set(result_json,'$.observed_tree',?) WHERE kind='check'",
      ).run('a'.repeat(64));
    if (failure === 'missing-unit-stop')
      db.prepare('UPDATE station_units SET stop_json=NULL').run();
    if (failure === 'unit-uncertain')
      db.prepare(
        "UPDATE station_units SET stop_json=json_set(stop_json,'$.observed_empty',json('false'))",
      ).run();
    if (failure === 'unit-context')
      db.prepare('UPDATE station_units SET context_digest=?').run('f'.repeat(64));
    if (failure === 'helper-stop')
      db.prepare(
        "UPDATE station_calls SET helper_stop_json=json_set(helper_stop_json,'$.pid',99) WHERE kind='read'",
      ).run();
    if (failure === 'unaccounted-inspection')
      db.prepare("DELETE FROM events WHERE kind='station.verification_observed'").run();
    if (failure === 'write-call')
      db.prepare(
        "UPDATE station_calls SET kind='patch',attempt_id=?,task_check_id=NULL WHERE id=?",
      ).run(accepted.attempt_id, receipts.inspection);
    if (failure === 'unknown-unit')
      db.prepare(
        "INSERT INTO station_units(id,context_digest,config_json,snapshot_path,output_path,state) VALUES('unknown',?,'{}','unused','unused','unconfirmed')",
      ).run('a'.repeat(64));
    if (failure === 'unaccounted-tool')
      f.store.transaction(() => {
        const input = '{}';
        f.store.event(f.session, 'tool.started', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'effect',
          tool: 'salaam_effect',
          input,
          input_digest: textDigest(input),
          input_truncated: false,
        });
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'effect',
          tool: 'salaam_effect',
          failed: false,
        });
      });
    if (failure === 'duplicate-tool-end')
      f.store.transaction(() =>
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'readonly-mcp',
          tool: 'salaam_mcp',
          failed: false,
        }),
      );
    const binding =
      failure === 'foreign-binding'
        ? { ...f.binding, principal_id: 'prn_' + '3'.repeat(20) }
        : f.binding;
    expect(() =>
      f.work.fail(
        binding,
        'reject-readonly',
        admitted.request_id,
        'a'.repeat(64),
        settlementDriver(f),
      ),
    ).toThrow();
    expect(
      f.store.db.prepare('SELECT state FROM durable_tasks WHERE id=?').get(admitted.task_id)!.state,
    ).toBe('partially_completed');
    expect(
      db.prepare("SELECT 1 FROM requests WHERE actor='agentpod-work-failure'").get(),
    ).toBeUndefined();
  } finally {
    await children.close();
    f.close();
  }
});

test.each([true, false])(
  'known readonly non-success catalog requires an admitted selection (%s)',
  async (admittedCatalog) => {
    const { f, admitted, accepted, children } = knownReadOnlyFailureFixture();
    try {
      const input = canonical({
        action: 'catalog',
        server: admittedCatalog ? 'superlibrary' : 'foreign-server',
      });
      f.store.transaction(() => {
        f.store.event(f.session, 'tool.started', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'catalog',
          tool: 'salaam_mcp',
          input,
          input_digest: textDigest(input),
          input_truncated: false,
        });
        f.store.event(f.session, 'tool.finished', {
          attempt_id: accepted.attempt_id,
          worker_epoch: 1,
          tool_call_id: 'catalog',
          tool: 'salaam_mcp',
          failed: false,
        });
      });
      const run = () =>
        f.work.fail(
          f.binding,
          'catalog-retire',
          admitted.request_id,
          'a'.repeat(64),
          settlementDriver(f),
        );
      if (admittedCatalog)
        expect(run()).toMatchObject({ state: 'cancelled', effects: 'known_effects_preserved' });
      else expect(run).toThrow();
    } finally {
      await children.close();
      f.close();
    }
  },
);
