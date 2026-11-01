import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { SalaamService } from '../dist/src/service/service.js';
import { ROOT } from '../dist/src/core/config.js';
import { hostDigests } from '../dist/src/host/host.js';
import { digest } from '../dist/src/core/protocol.js';
import { providerRoute, DEFAULT_CLAUDE_MODEL } from '../dist/src/providers/config.js';
import { call } from '../dist/src/core/transport.js';
import { readTree } from '../dist/src/coding/workspaces.js';
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';

if (!process.argv.includes('--run'))
  throw new Error('Use --run for the authorized live coding comparison');
const socket = process.env.SALAAM_TASK_REAL_SOCKET,
  scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
if (!socket || !scratch)
  throw new Error('Select the pre-provisioned proven executor socket and shared scratch');
const budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json'));
const run = 'native-coding-' + randomUUID(),
  maxOutput = 4096,
  perCaseRequests = 16;
const reportPath = resolve(ROOT, '.state/evidence/m15', run + '.json');
const inputs = {
  'package.json': '{"type":"module"}\n',
  'app.js': 'export const answer = 41;\n',
  'notes.md': '# Work in progress\n',
  'human.txt': 'uncommitted human bytes predating the assignment\n',
  'app.test.js':
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {answer} from './app.js';test('answer',()=>assert.equal(answer,42));\n",
  'notes.test.js':
    "import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('documentation',()=>assert.match(fs.readFileSync('notes.md','utf8'),/returns 42/));\n",
};
const report = {
  schema_version: 1,
  run_id: run,
  success: false,
  observed_at: new Date().toISOString(),
  ...hostDigests(),
  dataset: 'answer-and-documentation-v1',
  input_digest: digest(inputs),
  scope:
    'One bounded live coding comparison on a small versioned fixture; no general benchmark claim',
  model: DEFAULT_CLAUDE_MODEL,
  equivalent_case_bounds: {
    requests: perCaseRequests,
    output_tokens: maxOutput,
    runtime_ms: 300000,
  },
  cases: [],
};
const until = async (fn, accepts, timeout = 300000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (accepts(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Live coding acceptance deadline reached');
};
const terminal = (a) => !['accepted', 'dispatching', 'running', 'delegated'].includes(a.state);
async function execute(mode) {
  const dir = mkdtempSync(join(realpathSync(scratch), 'm15-live-')),
    source = join(dir, 'source'),
    owned = join(dir, 'owned'),
    state = mkdtempSync('/tmp/sal-coding-live-');
  mkdirSync(source);
  mkdirSync(owned, { mode: 0o700 });
  mkdirSync(join(source, '.salaam/agents'), { recursive: true });
  for (const [path, bytes] of Object.entries(inputs)) writeFileSync(join(source, path), bytes);
  for (const name of ['builder-a', 'builder-b'])
    writeFileSync(
      join(source, '.salaam/agents', name + '.md'),
      '---\n{"role":"builder","max_requests":6}\n---\nImplement only your assigned file in the private owned workspace. Batch independent reads. Inspect current workspace revision and read the file hash before patching with salaam_files. Run the assigned isolated check after repair. Return concise actual outcomes. Do not edit tests, package.json or human.txt. Use at most six model requests.\n',
    );
  const result = { mode, success: false, human_interventions: 0, scripted_operator_actions: 0 };
  report.cases.push(result);
  let service, heartbeat, leaseFailure;
  const started = Date.now();
  try {
    service = await SalaamService.open({
      stateDir: state,
      codingRoot: owned,
      codingSocket: socket,
      providerRoute: providerRoute('anthropic', DEFAULT_CLAUDE_MODEL, maxOutput),
      providerEnvironment: {},
      admitModelRequest: (_s, _a, _i, o) => budget.admit(run + '/' + mode, o),
    });
    result.executor = service.coding.executor.evidence;
    const session = await call(service.socket, '/v1/sessions', {
      request_id: 'create',
      cwd: source,
      coding: true,
    });
    const ready = await until(
      () => service.supervisor.inspect(session.id),
      (s) => ['ready', 'unhealthy'].includes(s.state),
    );
    assert.equal(ready.state, 'ready');
    const client_id = randomUUID(),
      lease = service.store.control(session.id, 'control', client_id, 'acquire', 0),
      actor = { client_id, token: lease.token };
    const authorize = () => service.store.authorizeControl(session.id, actor);
    const renew = async () => {
      await call(service.socket, `/v1/sessions/${session.id}/control`, {
        ...actor,
        action: 'renew',
        expected_epoch: service.store.controlView(session.id).epoch,
        request_id: randomUUID(),
      });
    };
    heartbeat = setInterval(() => {
      void renew().catch((error) => {
        leaseFailure = error;
      });
    }, 3000);
    const steps =
      mode === 'parallel'
        ? [
            {
              key: 'code',
              title: 'Repair code',
              instruction:
                'Use salaam_files to inspect the current private workspace revision and read app.js for its hash, then patch ONLY app.js so it exports answer=42. Run node --test app.test.js through salaam_command with the current revision. Do not edit any other file. Report actual checks and your proposal.',
              depends_on: [],
            },
            {
              key: 'docs',
              title: 'Repair documentation',
              instruction:
                'Use salaam_files to inspect the current private workspace revision and read notes.md for its hash, then patch ONLY notes.md to say The API returns 42. Run node --test notes.test.js through salaam_command with the current revision. Do not edit any other file. Report actual checks and your proposal.',
              depends_on: [],
            },
            {
              key: 'review',
              title: 'Independent review',
              instruction:
                'Review the integrated repository snapshot and diff. Read app.js and notes.md and the two unchanged tests. Confirm the code exports answer=42 and documentation says returns 42. Publish concrete findings through salaam_findings; an empty findings array is correct if no defect remains. Do not edit files or claim verified task success. Use at most four requests.',
              depends_on: ['code', 'docs'],
            },
          ]
        : [
            {
              key: 'repair',
              title: 'Repair and document',
              instruction:
                'Repair the owned workspace using salaam_files. First inspect its revision and read app.js and notes.md for their hashes. Patch ONLY app.js so it exports answer=42 and notes.md so it says The API returns 42. Each durable patch advances the workspace revision; use the current revision for subsequent patches and commands. Preserve tests, package.json and human.txt exactly. After both fixes, run node --test through salaam_command using the current revision. Command edits are disposable. Return actual outcomes, without claiming verified task success.',
              depends_on: [],
            },
          ];
    const task = service.taskWork.create(
      session.id,
      'task',
      0,
      {
        objective: 'Repair answer and documentation while preserving human work',
        constraints: [
          'Only app.js and notes.md may change; preserve all tests, package.json and human.txt',
        ],
        steps,
        acceptance: [{ key: 'suite', command: 'node --test', cwd: '.' }],
        deliverables: ['app.js', 'notes.md', 'human.txt'],
        limits: {
          requests: perCaseRequests,
          output_token_bound: maxOutput,
          runtime_ms: 300000,
          concurrency: 4,
        },
      },
      actor,
    );
    const baseline = service.taskVerification.start(
      task.id,
      'suite',
      null,
      'baseline',
      service.taskWork.get(task.id).revision,
      authorize,
    );
    await until(
      () => service.taskVerification.get(baseline.id),
      (c) => ['passed', 'failed'].includes(c.state),
    );
    assert.equal(service.taskVerification.get(baseline.id).state, 'failed');
    result.baseline_check = service.taskVerification.get(baseline.id);
    const codingStarted = Date.now();
    if (mode === 'parallel') {
      for (const id of ['project/builder-a', 'project/builder-b', 'salaam/reviewer']) {
        const profile = service.agents.inspect(session.id, id);
        await service.agents.admit(session.id, 'admit-' + id, id, digest(profile), [], actor);
        result.scripted_operator_actions++;
      }
      const assignments = task.steps.map((step, i) =>
        service.team.assign(
          task.id,
          step.id,
          i === 2 ? 'salaam/reviewer' : 'project/builder-' + (i ? 'b' : 'a'),
          i === 2 ? 4 : 6,
          'assign-' + i,
          service.taskWork.get(task.id).revision,
          actor,
        ),
      );
      for (const a of assignments.slice(0, 2))
        service.team.run(
          a.id,
          'run-' + a.id,
          service.taskWork.get(task.id).revision,
          0,
          null,
          null,
          actor,
        );
      const builders = await until(
        () => service.children.list(session.id),
        (cs) =>
          cs.length === 2 &&
          cs.every(
            (c) =>
              c.state !== 'accepted' &&
              !service.store.db
                .prepare("SELECT 1 FROM workers WHERE session_id=? AND state!='exited'")
                .get(c.child_session),
          ),
      );
      result.builders = builders.map((c) => ({
        child_id: c.id,
        profile: c.worker.binding.profile.id,
        state: c.state,
        result: service.store.attempt(c.child_attempt).result,
        error: service.store.attempt(c.child_attempt).error,
        binding_digest: c.worker.binding_digest,
        isolation: c.worker.binding.isolation,
        commands: service.coding.list(c.child_session),
      }));
      assert(
        builders.every((c) => c.state === 'completed'),
        'A live builder failed',
      );
      await renew();
      result.integrations = [];
      for (const child of builders) {
        const allowed = child.worker.binding.profile.id.endsWith('builder-a')
            ? 'app.js'
            : 'notes.md',
          proposal = service.workerWorkspaces.proposal(session.id, child.id);
        assert.deepEqual(
          proposal.changes.map((c) => c.path),
          [allowed],
          'Builder changed unassigned files',
        );
        assert(
          service.coding
            .list(child.child_session)
            .some((c) => c.state === 'succeeded' && c.exit_code === 0),
          'Builder omitted successful real command',
        );
        const root = service.workspaces.get(session.id);
        result.integrations.push(
          service.workerWorkspaces.integrate(
            session.id,
            child.id,
            'integrate-' + child.id,
            root.revision,
            root.digest,
            proposal.patch_digest,
            authorize,
          ),
        );
        result.scripted_operator_actions++;
      }
      for (const step of task.steps.slice(0, 2)) {
        service.taskWork.complete(
          task.id,
          step.id,
          'review-' + step.id,
          service.taskWork.get(task.id).revision,
          'Inspected exact applied proposal and actual isolated check receipt; final combined check remains required.',
          actor,
        );
        result.scripted_operator_actions++;
      }
      const reviewer = service.team.run(
        assignments[2].id,
        'reviewer',
        service.taskWork.get(task.id).revision,
        0,
        null,
        null,
        actor,
      );
      const child = await until(
        () => service.children.inspect(session.id, reviewer.child_id),
        (c) => c.state !== 'accepted',
      );
      result.reviewer = {
        state: child.state,
        result: service.store.attempt(child.child_attempt).result,
        error: service.store.attempt(child.child_attempt).error,
      };
      assert.equal(child.state, 'completed');
      const findings = service.store.db
        .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
        .get(child.worker.binding.worker_id);
      assert(findings, 'Reviewer omitted checked findings');
      result.reviewer.findings = JSON.parse(service.artifacts.read(findings.artifact_id));
      assert.equal(result.reviewer.findings.findings.length, 0, 'Reviewer found remaining defects');
      await renew();
      service.taskWork.complete(
        task.id,
        task.steps[2].id,
        'review-reviewer',
        service.taskWork.get(task.id).revision,
        'Inspected independently recorded review findings.',
        actor,
      );
      result.scripted_operator_actions++;
    } else {
      const accepted = service.taskWork.run(
        task.id,
        task.steps[0].id,
        'repair',
        service.taskWork.get(task.id).revision,
        null,
        null,
        actor,
      );
      const attempt = await until(() => service.store.attempt(accepted.attempt_id), terminal);
      result.attempt = { state: attempt.state, error: attempt.error, result: attempt.result };
      assert.equal(attempt.state, 'completed', 'Single-agent repair failed');
      assert(
        service.coding.list(session.id).some((c) => c.state === 'succeeded' && c.exit_code === 0),
        'Single agent omitted successful real command',
      );
      await renew();
      service.taskWork.complete(
        task.id,
        task.steps[0].id,
        'review',
        service.taskWork.get(task.id).revision,
        'Inspected actual patch and isolated check; fresh independent combined check remains required.',
        actor,
      );
      result.scripted_operator_actions++;
    }
    if (leaseFailure) throw leaseFailure;
    result.coding_elapsed_ms = Date.now() - codingStarted;
    const root = service.workspaces.verify(session.id),
      tree = readTree(root.root);
    for (const [path, bytes] of Object.entries(inputs))
      if (!['app.js', 'notes.md'].includes(path))
        assert.equal(
          Buffer.from(tree[path].content, 'base64').toString(),
          bytes,
          'Changed protected input ' + path,
        );
    assert.match(Buffer.from(tree['app.js'].content, 'base64').toString(), /answer\s*=\s*42/);
    assert.match(Buffer.from(tree['notes.md'].content, 'base64').toString(), /returns 42/);
    assert.deepEqual(
      Object.keys(tree)
        .filter((p) => !p.startsWith('.salaam/'))
        .sort(),
      Object.keys(inputs).sort(),
      'Unexpected files in final workspace',
    );
    const check = service.taskVerification.start(
      task.id,
      'suite',
      null,
      'fresh-suite',
      service.taskWork.get(task.id).revision,
      authorize,
    );
    await until(
      () => service.taskVerification.get(check.id),
      (c) => ['passed', 'failed'].includes(c.state),
    );
    result.final_check = service.taskVerification.get(check.id);
    assert.equal(result.final_check.state, 'passed');
    await renew();
    service.taskVerification.finish(
      task.id,
      'finish',
      service.taskWork.get(task.id).revision,
      null,
      authorize,
    );
    assert.equal(service.taskWork.get(task.id).state, 'succeeded');
    result.final_digest = root.digest;
    result.usage = service.store.usage.summary(session.id);
    assert.equal(result.usage.unknown_observations, 0);
    for (const [path, bytes] of Object.entries(inputs))
      assert.equal(readFileSync(join(source, path), 'utf8'), bytes, 'Original source changed');
    result.correctness = {
      hidden_assertions_passed: true,
      protected_inputs_preserved: true,
      original_source_preserved: true,
    };
    result.success = true;
  } catch (error) {
    result.failure = { name: error.name, message: error.message };
    throw error;
  } finally {
    clearInterval(heartbeat);
    await service?.close();
    result.elapsed_ms = Date.now() - started;
    if (service) {
      const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true });
      result.observations = db
        .prepare(
          'SELECT source_key,provider,model,status,input,output,cache_read,cache_write FROM usage_observations',
        )
        .all();
      result.attempts = db.prepare('SELECT id,state,error FROM attempts').all();
      db.close();
    }
    result.requests =
      budget.snapshot().runs.find((r) => r.run_id === run + '/' + mode)?.reserved_requests ?? 0;
    rmSync(dir, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
}
try {
  for (const mode of ['parallel', 'single']) await execute(mode);
  report.success = report.cases.every((c) => c.success);
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  report.shared_budget = budget.snapshot();
  budget.export();
  budget.close();
  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        success: report.success,
        cases: report.cases.map((c) => ({
          mode: c.mode,
          success: c.success,
          requests: c.requests,
          coding_elapsed_ms: c.coding_elapsed_ms,
          failure: c.failure,
        })),
        shared_remaining: report.shared_budget.remaining_requests,
      },
      null,
      2,
    ),
  );
}
