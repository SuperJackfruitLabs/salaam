import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { SalaamService } from '../dist/src/service/service.js';
import { harnessRuntimeDigest } from '../dist/src/harness/backend.js';
import { HARNESS_TARGETS } from '../dist/src/core/harness-targets.js';
import { ROOT } from '../dist/src/core/config.js';
import { hostDigests } from '../dist/src/host/host.js';
import { digest } from '../dist/src/core/protocol.js';
import { call } from '../dist/src/core/transport.js';
import { readTree } from '../dist/src/coding/workspaces.js';
import { LiveAcceptanceBudget } from './live-acceptance-budget.mjs';
if (!process.argv.includes('--run'))
  throw Error('Use --run for the authorized live daemon acceptance');
const target = process.argv[process.argv.indexOf('--target') + 1];
if (!Object.hasOwn(HARNESS_TARGETS, target)) throw Error('Select an exact named harness target');
const socket = process.env.SALAAM_TASK_REAL_SOCKET,
  scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
if (!socket || !scratch) throw Error('Select the proven dedicated executor');
const run = 'harness-service-' + target + '-' + randomUUID(),
  budget = new LiveAcceptanceBudget(join(ROOT, '.state/m13-m18-live-budget.json'));
const dir = fs.mkdtempSync(join(fs.realpathSync(scratch), 'm16-service-')),
  source = join(dir, 'source'),
  owned = join(dir, 'owned'),
  state = fs.mkdtempSync('/tmp/sal-harness-service-'),
  config = join(state, 'harness.json');
for (const p of [source, owned]) fs.mkdirSync(p, { mode: 0o700 });
const files = {
  'package.json': '{"type":"module"}\n',
  'app.js': 'export const answer = 41;\n',
  'human.txt': 'uncommitted human bytes\n',
  'app.test.js':
    "import{test}from'node:test';import assert from'node:assert/strict';import{answer}from'./app.js';test('answer',()=>assert.equal(answer,42));\n",
};
for (const [p, bytes] of Object.entries(files)) fs.writeFileSync(join(source, p), bytes);
fs.mkdirSync(join(source, '.salaam/agents'), { recursive: true });
fs.writeFileSync(
  join(source, '.salaam/agents/harness-builder.md'),
  '---\n{"role":"builder","max_requests":8}\n---\nWork only in the assigned private /workspace draft using the external harness tool inventory. Preserve tests, package.json and human.txt. Return actual outcomes for explicit integration.\n',
);
const runtimeArg = process.argv.indexOf('--runtime-root');
const runtime =
  runtimeArg >= 0
    ? fs.realpathSync(process.argv[runtimeArg + 1])
    : JSON.parse(fs.readFileSync(join(ROOT, '.state/m16-runtime-path.json'))).root;
const report = {
  schema_version: 1,
  run_id: run,
  target,
  backend: { provider: 'anthropic', model: 'claude-sonnet-4-6', output_cap: 4096 },
  success: false,
  observed_at: new Date().toISOString(),
  ...hostDigests(),
  runner_digest: createHash('sha256')
    .update(fs.readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  scope:
    'Real daemon/task assignment, shared approvals, stopped draft import, explicit integration, fresh checks and daemon reconnect; named Claude gateway backend',
  admissions: [],
  decisions: [],
};
let service, heartbeat, actor, session, task, assignment, first, checkpoint;
const until = async (fn, accept, ms = 240000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error('Daemon acceptance deadline reached');
};
const options = {
  stateDir: state,
  codingRoot: owned,
  codingSocket: socket,
  harnessConfig: config,
  admitModelRequest: (s, a, bytes, output) => {
    budget.admit(run, output);
    report.admissions.push({ session: s, attempt: a, bytes, output });
  },
};
function control() {
  const client_id = randomUUID(),
    lease = service.store.control(
      session.id,
      randomUUID(),
      client_id,
      'acquire',
      service.store.controlView(session.id).epoch,
    );
  actor = { client_id, token: lease.token };
  heartbeat = setInterval(() => {
    void call(service.socket, `/v1/sessions/${session.id}/control`, {
      ...actor,
      request_id: randomUUID(),
      action: 'renew',
      expected_epoch: service.store.controlView(session.id).epoch,
    }).catch(() => {});
  }, 3000);
}
const authorize = () => service.store.authorizeControl(session.id, actor);
const repair = `node -e 'require("node:fs").writeFileSync("app.js","export const answer = 42;\\n")'`;
try {
  report.runtime_digest = await harnessRuntimeDigest(runtime);
  fs.writeFileSync(
    config,
    JSON.stringify({
      schema: 1,
      runtimes: [
        {
          id: target,
          target,
          version: HARNESS_TARGETS[target].version,
          runtime_root: runtime,
          runtime_digest: report.runtime_digest,
          model: 'claude-sonnet-4-6',
          output: 4096,
          requests: 12,
        },
      ],
    }),
    { mode: 0o600 },
  );
  service = await SalaamService.open(options);
  report.executor = service.coding.executor.evidence;
  session = await call(service.socket, '/v1/sessions', {
    request_id: 'create',
    cwd: source,
    coding: true,
  });
  await until(
    () => service.supervisor.inspect(session.id),
    (s) => s.state === 'ready',
  );
  control();
  const profile = service.agents.inspect(session.id, 'project/harness-builder');
  await service.agents.admit(
    session.id,
    'admit-profile',
    'project/harness-builder',
    digest(profile),
    [],
    actor,
  );
  const instruction =
    target === 'codex-app-server'
      ? `Read app.js. Repair ONLY app.js by using exec_command with cmd exactly ${JSON.stringify(repair)}, workdir=/workspace and sandbox_permissions=require_escalated. Then run exactly node --test app.test.js using exec_command with workdir=/workspace and sandbox_permissions=require_escalated. Preserve all other files exactly. Do not delegate, install or use network.`
      : `Read app.js. Repair ONLY /workspace/app.js to export answer=42, using ${target === 'claude-acp' ? 'Edit or Write' : 'replace or write_file'}. Then run exactly node --test app.test.js through ${target === 'claude-acp' ? 'Bash; the outer Docker execution boundary is already proven, so use dangerouslyDisableSandbox:true if the inner sandbox is unavailable' : 'run_shell_command, dir_path=/workspace'}. Preserve package.json, app.test.js and human.txt exactly. Do not delegate, install or use network.`;
  task = service.taskWork.create(
    session.id,
    'task',
    0,
    {
      objective: 'Repair the private harness draft and integrate once',
      constraints: ['Preserve tests and human bytes'],
      steps: [{ key: 'repair', title: 'Repair', instruction, depends_on: [], checks: ['suite'] }],
      acceptance: [{ key: 'suite', command: 'node --test app.test.js', cwd: '.' }],
      deliverables: ['app.js', 'human.txt'],
      limits: { invocations: 2, token_units: null, runtime_ms: 300000, concurrency: 3 },
    },
    actor,
  );
  const baseline = service.taskVerification.start(
    task.id,
    'suite',
    null,
    'baseline',
    task.revision,
    authorize,
  );
  await until(
    () => service.taskVerification.get(baseline.id),
    (c) => ['passed', 'failed'].includes(c.state),
  );
  report.baseline = service.taskVerification.get(baseline.id);
  assert.equal(report.baseline.state, 'failed');
  assignment = service.team.assign(
    task.id,
    task.steps[0].id,
    'project/harness-builder',
    1,
    'assign',
    service.taskWork.get(task.id).revision,
    actor,
    target,
  );
  const approve = async () => {
    for (const p of service.managed.pending()) {
      const op = service.managed.operation(p.operation_id);
      if (op.kind !== 'harness') continue;
      const scope = JSON.parse(op.value).scope,
        a = scope.arguments;
      const yes =
        scope.kind === 'write'
          ? a.file_path === '/workspace/app.js'
          : a.command === 'node --test app.test.js' ||
            [repair, 'node --test app.test.js'].includes(a.cmd);
      service.managed.decide(
        p.id,
        'decision:' + p.id,
        p.revision,
        p.operation_digest,
        yes ? 'approve' : 'deny',
      );
      report.decisions.push({ id: p.id, scope, decision: yes ? 'approve' : 'deny' });
    }
  };
  const revision = service.taskWork.get(task.id).revision;
  first = service.team.run(assignment.id, 'run-once', revision, 0, null, null, actor);
  await until(
    async () => {
      await approve();
      return service.children.inspect(session.id, first.child_id);
    },
    (c) => c.state !== 'accepted',
  );
  const child = service.children.inspect(session.id, first.child_id);
  report.child = child;
  report.external = service.external.row(child.id);
  checkpoint = JSON.parse(report.external.checkpoint);
  assert.equal(child.state, 'completed');
  assert.equal(report.external.stopped, 1);
  assert.equal(checkpoint.state, 'terminal');
  assert(report.decisions.some((d) => d.scope.kind === 'write' || d.scope.kind === 'command'));
  report.proposal = service.workerWorkspaces.proposal(session.id, child.id);
  assert(report.proposal.changes.some((c) => c.path === 'app.js'));
  assert(report.proposal.changes.every((c) => c.path === 'app.js'));
  assert.equal(service.taskBudget.state(task.id).requests_spent, 0);
  assert.equal(service.taskBudget.state(task.id).invocations_spent, 1);
  const root = service.workspaces.verify(session.id);
  report.integration = service.workerWorkspaces.integrate(
    session.id,
    child.id,
    'integrate',
    root.revision,
    root.digest,
    report.proposal.patch_digest,
    authorize,
  );
  assert.equal(report.integration.state, 'applied');
  service.taskWork.complete(
    task.id,
    task.steps[0].id,
    'review',
    service.taskWork.get(task.id).revision,
    'Inspected the actual private draft and integration receipt',
    actor,
  );
  const check = service.taskVerification.start(
    task.id,
    'suite',
    null,
    'final-check',
    service.taskWork.get(task.id).revision,
    authorize,
  );
  await until(
    () => service.taskVerification.get(check.id),
    (c) => ['passed', 'failed'].includes(c.state),
  );
  report.final_check = service.taskVerification.get(check.id);
  assert.equal(report.final_check.state, 'passed');
  for (const [p, bytes] of Object.entries(files)) {
    assert.equal(fs.readFileSync(join(source, p), 'utf8'), bytes);
    if (p !== 'app.js')
      assert.equal(
        Buffer.from(
          readTree(service.workspaces.get(session.id).root)[p].content,
          'base64',
        ).toString(),
        bytes,
      );
  }
  const before = {
    admissions: report.admissions.length,
    draft: digest(readTree(service.workspaces.get(child.child_session).root)),
    session: checkpoint.session_id,
  };
  clearInterval(heartbeat);
  await service.close();
  service = await SalaamService.open(options);
  control();
  const retry = service.team.run(assignment.id, 'run-once', revision, 0, null, null, {
    client_id: 'expired',
    token: 'expired',
  });
  assert.equal(digest(retry), digest(first));
  assert.equal(report.admissions.length, before.admissions);
  assert.equal(JSON.parse(service.external.row(child.id).checkpoint).session_id, before.session);
  assert.equal(digest(readTree(service.workspaces.get(child.child_session).root)), before.draft);
  report.reconnect = {
    same_upstream_session: before.session,
    new_model_requests: report.admissions.length - before.admissions,
    unchanged_draft: true,
    same_child_id: retry.child_id,
  };
  report.task = service.taskDriver.view(task.id);
  report.success = true;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  await service?.close();
  report.budget = budget.snapshot();
  budget.export();
  budget.close();
  const path = resolve(ROOT, '.state/evidence/m16', run + '.json');
  fs.mkdirSync(resolve(path, '..'), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
  console.log(
    JSON.stringify(
      {
        report: path,
        success: report.success,
        requests: report.admissions.length,
        remaining: report.budget.remaining_requests,
        failure: report.failure,
      },
      null,
      2,
    ),
  );
}
