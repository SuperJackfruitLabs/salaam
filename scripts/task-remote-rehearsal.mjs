// Opt-in: source, dependencies, Node and Docker must already be provisioned by the operator.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PtyClient } from '../dist/test/terminal-helpers.js';
import { until } from '../dist/test/helpers.js';
import { shellQuote } from '../dist/src/cli/remote.js';
import { digest } from '../dist/src/core/protocol.js';
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const host = option('--host'),
  repo = option('--repo'),
  node = option('--node');
if (
  !host ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) ||
  !repo ||
  !/^\/home\/[a-zA-Z0-9_-]+\/\.cache\/salaam-m10\.[a-zA-Z0-9]+\/m11-[a-zA-Z0-9-]+$/.test(repo) ||
  !node ||
  !/^\/home\/[a-zA-Z0-9_-]+\/\.cache\/salaam-m10\.[a-zA-Z0-9]+\/node-v26\.7\.0-linux-x64\/bin\/node$/.test(
    node,
  )
)
  throw Error(
    'Supply the explicitly permitted SSH host, disposable M11 checkout and pinned Node path.',
  );
const id = randomUUID().slice(0, 8),
  work = repo + '/r-' + id,
  state = '/tmp/sal-m11-ssh-' + id,
  source = work + '/source',
  owned = work + '/owned',
  bin = work + '/sal';
const reportPath = resolve(option('--report') ?? '.state/evidence/m11/remote.json');
mkdirSync(join(reportPath, '..'), { recursive: true });
const report = {
  schema: 1,
  started_at: new Date().toISOString(),
  success: false,
  host_alias: host,
  repo,
  work,
  state,
  scope: 'Actual macOS PTY → SSH → Linux task service and native Docker; offline provider only',
  steps: [],
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
const record = (name, details = {}) => {
  report.steps.push({ name, ...details });
  save();
  console.log(name);
};
const ssh = async (argv) =>
  (
    await promisify(execFile)(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        host,
        argv.map(shellQuote).join(' '),
      ],
      { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
    )
  ).stdout.trim();
const js = async (code) => JSON.parse(await ssh([node, '--input-type=module', '-e', code]));
const rpc = (path, body) =>
  js(
    `import{call}from${JSON.stringify(repo + '/dist/src/core/transport.js')};console.log(JSON.stringify(await call(${JSON.stringify(state + '/operator.sock')},${JSON.stringify(path)},${JSON.stringify(body)})));`,
  );
const cli = async (...args) => JSON.parse(await ssh([bin, ...args, '--state', state]));
let pid, first, observer, session, taskId;
const boot = async (mode) => {
  pid = await js(
    `import{spawn}from'node:child_process';import{openSync}from'node:fs';const fd=openSync(${JSON.stringify(work + '/daemon.log')},'a');const child=spawn(${JSON.stringify(node)},[${JSON.stringify(repo + '/test/fixtures/task-real-service.mjs')},${JSON.stringify(state)},${JSON.stringify(owned)},'/var/run/docker.sock',${JSON.stringify(mode)}],{detached:true,stdio:['ignore',fd,fd],env:{PATH:${JSON.stringify(node.slice(0, -5) + ':/usr/bin:/bin')},HOME:${JSON.stringify(state)},LANG:'en_US.UTF-8'}});child.unref();console.log(JSON.stringify(child.pid));`,
  );
  await until(() => rpc('/v1/health').catch(() => null), Boolean, 30000);
};
const kill = async () => {
  if (pid) {
    await js(
      `try{process.kill(${pid},'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}console.log('true');`,
    );
    pid = undefined;
  }
};
const home = join(reportPath, '../ssh-pty-home');
mkdirSync(home, { recursive: true });
const terminal = (observe = false) =>
  new PtyClient(
    [
      resolve('bin/salaam.mjs'),
      'remote',
      host,
      '--remote-bin',
      bin,
      '--state',
      state,
      '--session',
      session.id,
      ...(observe ? ['--observe'] : []),
    ],
    { state: home, columns: 120, rows: 42 },
  );
try {
  const fixtureFiles = {
    [bin]:
      '#!/bin/sh\nPATH=' +
      shellQuote(node.slice(0, -5)) +
      ':"$PATH"\nexport PATH\nexec ' +
      shellQuote(node) +
      ' ' +
      shellQuote(repo + '/bin/salaam.mjs') +
      ' "$@"\n',
    [source + '/package.json']: '{"type":"module"}\n',
    [source + '/math.js']: 'export const add = (a,b) => a-b;\n',
    [source + '/human.txt']: 'dirty work predating the task\n',
    [source + '/math.test.js']:
      "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './math.js';test('addition',()=>assert.equal(add(2,3),5));\n",
  };
  await js(
    `import{mkdirSync,writeFileSync,chmodSync}from'node:fs';for(const p of ${JSON.stringify([work, state, source, owned])})mkdirSync(p,{recursive:true,mode:448});for(const[p,text]of Object.entries(${JSON.stringify(fixtureFiles)}))writeFileSync(p,text);chmodSync(${JSON.stringify(bin)},448);console.log('true');`,
  );
  report.runtime = await js(
    `import{bundleDigest}from${JSON.stringify(repo + '/dist/src/core/config.js')};import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';const hash=b=>createHash('sha256').update(b).digest('hex');const files=readdirSync(${JSON.stringify(repo + '/src')}).filter(f=>f.endsWith('.ts')).sort().map(f=>({path:'src/'+f,sha256:hash(readFileSync(${JSON.stringify(repo + '/src/')}+f))}));console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,bundle_digest:bundleDigest(),runtime_source_digest:hash(JSON.stringify(files)),lock_digest:hash(readFileSync(${JSON.stringify(repo + '/package-lock.json')}))}));`,
  );
  await boot('between-steps');
  report.executor = await js(
    `import{readFileSync}from'node:fs';console.log(readFileSync(${JSON.stringify(state + '/executor-proof.json')},'utf8'));`,
  );
  session = await cli('session', 'create', '--cwd', source, '--coding');
  report.session_id = session.id;
  await until(
    () => rpc('/v1/sessions/' + session.id),
    (s) => s.state === 'ready',
    20000,
  );
  const lease = await js(
    `import{acquireControl}from${JSON.stringify(repo + '/dist/src/tui/attach.js')};console.log(JSON.stringify(await acquireControl(${JSON.stringify(state + '/operator.sock')},${JSON.stringify(session.id)},'remote-rehearsal')));`,
  );
  const auth = { client_id: 'remote-rehearsal', token: lease.token };
  const baseline = await rpc('/v1/sessions/' + session.id + '/commands', {
    ...auth,
    step_key: 'baseline',
    command: 'node --test',
    expected_revision: 0,
  });
  const failed = await until(
    () => rpc('/v1/sessions/' + session.id + '/commands/' + baseline.id),
    (r) => ['failed', 'succeeded'].includes(r.state),
    30000,
  );
  assert.equal(failed.exit_code, 1);
  record('baseline-failed', { run_id: baseline.id });
  // Release the controller so the actual SSH terminal can own task admission.
  await rpc('/v1/sessions/' + session.id + '/control', {
    ...auth,
    action: 'release',
    expected_epoch: lease.epoch,
    request_id: 'release-' + id,
  });
  first = terminal();
  await first.contains('You have control', 25000);
  const patch = {
    action: 'patch',
    path: 'math.js',
    expected_revision: 0,
    expected_hash: digest({
      content: Buffer.from('export const add = (a,b) => a-b;\n').toString('base64'),
      executable: false,
    }),
    content: 'export const add = (a,b) => a+b;\n',
  };
  const plan = {
    objective: 'Repair and verify over SSH while preserving human work',
    constraints: ['Keep human.txt'],
    acceptance: [{ key: 'suite', command: 'node --test', cwd: '.' }],
    deliverables: ['math.js'],
    limits: { requests: 12, runtime_ms: 900000, verification_runs: 8 },
    steps: [
      {
        key: 'repair',
        title: 'Repair addition',
        instruction: '[files] ' + JSON.stringify(patch),
        depends_on: [],
        checks: ['suite'],
      },
      {
        key: 'review',
        title: 'Wait for human review',
        instruction: '[review] ssh-addition',
        depends_on: ['repair'],
        checks: ['suite'],
      },
      {
        key: 'inspect',
        title: 'Inspect result',
        instruction: '[files] ' + JSON.stringify({ action: 'read', path: 'math.js' }),
        depends_on: ['review'],
        checks: ['suite'],
      },
    ],
  };
  const palette = async () => {
    await first.write('\x0b');
    await first.contains('Salaam · actions');
    await first.write('Task actions\r');
  };
  await palette();
  await first.contains('Create task · plan JSON');
  await first.write('\x15');
  await first.write(JSON.stringify(plan));
  await first.write('\r');
  await first.contains('Create this task');
  await first.write('\x1b[C\r');
  await first.contains('TASK · ACCEPTED');
  let task = await rpc('/v1/tasks?session_id=' + session.id);
  taskId = task.id;
  report.task_id = taskId;
  report.step_ids = task.steps.map((s) => s.id);
  await palette();
  await first.contains('Salaam · task');
  await first.write('Run bounded task\r');
  await first.contains('Bounded progression');
  await first.write('\x15');
  await first.write('3');
  await first.write('\r');
  await first.contains('Run this bounded plan');
  await first.write('\x1b[C\r');
  await until(
    () =>
      js(
        `import{existsSync}from'node:fs';console.log(JSON.stringify(existsSync(${JSON.stringify(state + '/between-steps')})));`,
      ),
    Boolean,
    45000,
  );
  await first.capture(join(reportPath, '../screens/ssh-between-steps.svg'));
  await first.command({ op: 'signal', signal: 'SIGKILL' });
  await first.exit();
  first = undefined;
  report.before_restart = await js(
    `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(${JSON.stringify(state + '/journal.sqlite')},{readOnly:true});console.log(JSON.stringify(db.prepare('SELECT id,state,attempt_id FROM task_steps WHERE task_id=? ORDER BY ordinal').all(${JSON.stringify(taskId)})));db.close();`,
  );
  assert.equal(report.before_restart[0].state, 'completed');
  assert.equal(report.before_restart[1].attempt_id, null);
  await kill();
  await boot('replacement');
  task = await until(
    () => rpc('/v1/tasks/' + taskId),
    (t) => t.state === 'waiting_for_person',
    30000,
  );
  assert.equal(task.steps[0].attempt_id, report.before_restart[0].attempt_id);
  record('same-task-after-daemon-sigkill', { task_id: taskId });
  observer = terminal(true);
  await observer.contains('Observer', 25000);
  await observer.write('\x0f');
  await observer.contains('Review approval');
  await observer.write('\x1b[F');
  await observer.contains('Exact request binding reviewed.');
  await observer.capture(join(reportPath, '../screens/ssh-approval.svg'));
  await observer.write('\x1b[C\r');
  task = await until(
    () => rpc('/v1/tasks/' + taskId),
    (t) => t.state === 'succeeded',
    45000,
  );
  assert.equal(task.verification.completion.fresh, true);
  assert.deepEqual(
    task.steps.map((s) => s.id),
    report.step_ids,
  );
  assert.equal(task.runtime.requests_spent, 6);
  report.completed = task;
  report.commands = await rpc('/v1/sessions/' + session.id + '/commands');
  assert.equal(report.commands.length, 5);
  assert.equal(
    report.commands.filter((r) => r.state === 'succeeded' && r.exit_code === 0).length,
    4,
  );
  report.approvals = await rpc('/v1/approvals?session=' + session.id);
  assert.equal(report.approvals.length, 1);
  assert.equal(report.approvals[0].decision, 'approve');
  const workspace = await rpc('/v1/sessions/' + session.id + '/workspace');
  report.workspace = workspace;
  report.files = await js(
    `import{readFileSync}from'node:fs';console.log(JSON.stringify({source:readFileSync(${JSON.stringify(source + '/math.js')},'utf8'),result:readFileSync(${JSON.stringify(workspace.root + '/math.js')},'utf8'),human:readFileSync(${JSON.stringify(workspace.root + '/human.txt')},'utf8')}));`,
  );
  assert.match(report.files.source, /a-b/);
  assert.match(report.files.result, /a\+b/);
  assert.equal(report.files.human, 'dirty work predating the task\n');
  await observer.write('\x0b');
  await observer.contains('Salaam · actions');
  await observer.write('Session context\r');
  await observer.contains('SUCCEEDED');
  await observer.capture(join(reportPath, '../screens/ssh-completed.svg'));
  await observer.write('\x03');
  assert.equal((await observer.exit()).restored, true);
  observer = undefined;
  report.paid_provider_calls = 0;
  report.success = true;
  record('ssh-review-fresh-verified-success', { requests: 6, checks: 4 });
} catch (error) {
  report.error = error.stack;
  save();
  throw error;
} finally {
  await first?.close();
  await observer?.close();
  await rpc('/v1/shutdown', {}).catch(() => {});
  await kill();
  report.cleanup = await js(
    `import{DatabaseSync}from'node:sqlite';import{existsSync,rmSync}from'node:fs';import{DockerCodingExecutor}from${JSON.stringify(repo + '/dist/src/coding/executor.js')};import{engineRequest,engineJson}from${JSON.stringify(repo + '/dist/src/execution/boundary.js')};const path=${JSON.stringify(state + '/journal.sqlite')};let runs=[];if(existsSync(path)){const db=new DatabaseSync(path,{readOnly:true});runs=db.prepare('SELECT id,profile_digest FROM command_runs').all();db.close();}const request=engineRequest('/var/run/docker.sock'),executor=new DockerCodingExecutor(request);for(const r of runs){executor.profileDigest=r.profile_digest;await executor.cleanup(r.id);}const rows=engineJson(await request('GET','/containers/json?all=1'));const remaining=rows.filter(c=>runs.some(r=>c.Labels?.['salaam.command.run']===r.id));if(remaining.length)throw Error('Owned containers remain');rmSync(${JSON.stringify(state)},{recursive:true,force:true});rmSync(${JSON.stringify(work)},{recursive:true,force:true});console.log(JSON.stringify({owned_containers_remaining:0,disposable_state_removed:true,disposable_workspace_removed:true}));`,
  );
  report.finished_at = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ success: report.success, report: reportPath }));
