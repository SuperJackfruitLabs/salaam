import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';

if (!process.argv.includes('--run'))
  throw new Error(
    'Use --run to execute the authorized live acceptance, sharing .state/m13-m18-live-budget.json',
  );
const budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json'));
const run = 'native-specialists-' + randomUUID(),
  reportPath = resolve(join(ROOT, '.state/evidence/m13', run + '.json'));
const dir = mkdtempSync('/tmp/sal-specialists-live-'),
  source = join(dir, 'source'),
  owned = join(dir, 'owned'),
  state = join(dir, 'state');
mkdirSync(source);
mkdirSync(owned, { mode: 0o700 });
mkdirSync(join(source, '.salaam/agents'), { recursive: true });
writeFileSync(join(source, 'app.js'), 'export const answer = 41;\n');
writeFileSync(join(source, 'README.md'), '# Fixture API\n\nThe exported answer must equal 42.\n');
writeFileSync(join(source, 'human.txt'), 'pre-existing human work must survive\n');
const alternate = 'claude-haiku-4-5';
writeFileSync(
  join(source, '.salaam/agents/live-reviewer.md'),
  `---\n${JSON.stringify({ role: 'reviewer', provider: 'anthropic', model: alternate, max_requests: 4 })}\n---\nRead the admitted snapshot and diff. The API contract requires answer=42. Identify concrete correctness defects and publish them with actual file/line evidence through salaam_findings. Use at most four model requests. Do not claim execution or edits.\n`,
);
let service;
const report = {
  schema_version: 1,
  run_id: run,
  success: false,
  scope:
    'Live native parent/explorer/reviewer usefulness and separately admitted model route; not an external harness or execution-isolation proof',
  observed_at: new Date().toISOString(),
  ...hostDigests(),
  parent_model: DEFAULT_CLAUDE_MODEL,
  reviewer_model: alternate,
  max_output_tokens: 2048,
  run_request_limit: 12,
};
const wait = async (observe, accepts, timeout = 180000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await observe();
    if (accepts(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Live acceptance deadline reached');
};
try {
  service = await SalaamService.open({
    stateDir: state,
    codingRoot: owned,
    providerRoute: providerRoute('anthropic', DEFAULT_CLAUDE_MODEL, 2048),
    providerEnvironment: {},
    admitModelRequest: (_session, _attempt, _input, output) => budget.admit(run, output),
  });
  const session = await call(service.socket, '/v1/sessions', {
    request_id: 'create',
    cwd: source,
    coding: true,
  });
  await wait(
    () => service.supervisor.inspect(session.id),
    (s) => s.state === 'ready' || s.state === 'unhealthy',
  );
  assert.equal(service.supervisor.inspect(session.id).state, 'ready');
  const client_id = randomUUID(),
    lease = service.store.control(session.id, 'control', client_id, 'acquire', 0),
    actor = { client_id, token: lease.token };
  const privateFact = 'PARENT_ONLY_FIXTURE_' + randomUUID();
  service.tasks.update(
    session.id,
    'private-fact',
    0,
    {
      kind: 'constraint',
      text:
        privateFact + ' is unrelated private fixture context. Do not relay it in delegated goals.',
    },
    () => service.store.authorizeControl(session.id, actor),
  );
  for (const id of ['salaam/explorer', 'project/live-reviewer']) {
    const profile = service.agents.inspect(session.id, id);
    await service.agents.admit(session.id, 'admit-' + id, id, digest(profile), [], actor);
  }
  const task = service.taskWork.create(
    session.id,
    'task',
    0,
    {
      objective: 'Investigate the fixture API defect using independent read-only specialists',
      constraints: [
        'Do not edit files, run commands or request managed approvals. Preserve human work.',
      ],
      limits: { requests: 12, output_token_bound: 2048, runtime_ms: 180000 },
      steps: [
        {
          key: 'investigate',
          title: 'Independent investigation',
          instruction:
            'Use spawn_child exactly twice: step_key explorer with profile salaam/explorer and budget 3, and step_key reviewer with profile project/live-reviewer and budget 4. Give focused goals to inspect app.js against README.md: the contract requires answer=42. Do not relay unrelated parent facts or transcript text. Both children should cite actual file/line evidence; ask the reviewer to record its concrete defect through salaam_findings. Wait for both results, consume their saved results, and summarize the actual evidence. Do not edit files, run commands, request approvals, or claim verified task success.',
          depends_on: [],
        },
      ],
    },
    actor,
  );
  const accepted = service.taskWork.run(
    task.id,
    task.steps[0].id,
    'investigate',
    service.taskWork.get(task.id).revision,
    null,
    null,
    actor,
  );
  const attempt = await wait(
    () => service.store.attempt(accepted.attempt_id),
    (a) => !['accepted', 'dispatching', 'running'].includes(a.state),
  );
  report.parent_attempt = {
    id: attempt.id,
    state: attempt.state,
    error: attempt.error,
    result: attempt.result,
  };
  assert.equal(attempt.state, 'completed', 'Parent did not complete its admitted investigation');
  const children = service.children.list(session.id);
  assert.equal(children.length, 2, 'Parent did not admit exactly two specialists');
  assert(
    children.every((c) => c.state === 'completed'),
    'A specialist did not complete',
  );
  const explorer = children.find((c) => c.worker.binding.profile.id === 'salaam/explorer'),
    reviewer = children.find((c) => c.worker.binding.profile.id === 'project/live-reviewer');
  assert(explorer && reviewer, 'Wrong specialist profile used');
  assert.equal(reviewer.worker.binding.route.model, alternate);
  assert.equal(service.store.providerRoute(session.id).model, DEFAULT_CLAUDE_MODEL);
  for (const child of children) {
    const prompt = service.store.db
      .prepare('SELECT text FROM submissions WHERE attempt_id=?')
      .get(child.child_attempt).text;
    assert(!prompt.includes(privateFact), 'Unselected parent fixture fact was relayed');
  }
  const findingRow = service.store.db
    .prepare('SELECT artifact_id FROM specialist_reports WHERE worker_id=?')
    .get(reviewer.worker.binding.worker_id);
  assert(findingRow, 'Reviewer omitted its checked findings report');
  const findings = JSON.parse(service.artifacts.read(findingRow.artifact_id));
  assert(
    findings.findings.some((f) => f.path === 'app.js' && f.line === 1 && f.evidence.includes('41')),
    'Reviewer did not ground the seeded defect in actual source',
  );
  const explorerResult = service.store.attempt(explorer.child_attempt).result;
  assert(
    explorerResult.includes('app.js') && explorerResult.includes('41'),
    'Explorer omitted concrete source evidence',
  );
  report.children = children.map((c) => ({
    child_id: c.id,
    worker_id: c.worker.binding.worker_id,
    profile_id: c.worker.binding.profile.id,
    binding_digest: c.worker.binding_digest,
    route: c.worker.binding.route,
    state: c.state,
    result_id: c.result_id,
    result: service.children.consume(session.id, c.id, c.result_id),
  }));
  report.findings = findings;
  report.usage = service.store.usage.summary(session.id);
  assert.equal(report.usage.unknown_observations, 0);
  assert.equal(
    service.store.db.prepare('SELECT count(*) AS n FROM workspace_mutations').get().n,
    0,
    'Parent changed the fixture workspace',
  );
  const before = report.children.map((c) => ({ id: c.child_id, result_id: c.result_id }));
  await service.close();
  service = await SalaamService.open({
    stateDir: state,
    codingRoot: owned,
    providerRoute: providerRoute('anthropic', DEFAULT_CLAUDE_MODEL, 2048),
    providerEnvironment: {},
    admitModelRequest: (_session, _attempt, _input, output) => budget.admit(run, output),
  });
  assert.deepEqual(
    service.children.list(session.id).map((c) => ({ id: c.id, result_id: c.result_id })),
    before,
  );
  assert.equal(
    readFileSync(join(source, 'human.txt'), 'utf8'),
    'pre-existing human work must survive\n',
  );
  report.restart_preserved = true;
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await service?.close();
  if (service) {
    const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true });
    report.observations = db
      .prepare(
        'SELECT source_key,provider,model,status,input,output,cache_read,cache_write FROM usage_observations',
      )
      .all();
    report.final_attempts = db.prepare('SELECT id,state,error FROM attempts').all();
    db.close();
  }
  report.shared_budget = budget.snapshot();
  budget.export();
  budget.close();
  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  rmSync(dir, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        success: report.success,
        requests: report.shared_budget.runs.find((r) => r.run_id === run)?.reserved_requests ?? 0,
        shared_remaining: report.shared_budget.remaining_requests,
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
