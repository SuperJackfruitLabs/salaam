// Opt-in: source, dependencies, Node and Docker must already be provisioned by the operator.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PtyClient } from '../dist/test/terminal-helpers.js';
import { until } from '../dist/test/helpers.js';
import { shellQuote } from '../dist/src/remote.js';
import { digest } from '../dist/src/protocol.js';
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
  !/^\/home\/[a-zA-Z0-9_-]+\/\.cache\/salaam-m10\.[a-zA-Z0-9]+\/m12-[a-zA-Z0-9-]+$/.test(repo) ||
  !node ||
  !/^\/home\/[a-zA-Z0-9_-]+\/\.cache\/salaam-m10\.[a-zA-Z0-9]+\/node-v26\.7\.0-linux-x64\/bin\/node$/.test(
    node,
  )
)
  throw Error(
    'Supply the explicitly permitted SSH host, disposable M12 checkout and pinned Node path.',
  );
const id = randomUUID().slice(0, 8),
  work = repo + '/r-' + id,
  state = '/tmp/sal-m12-ssh-' + id,
  source = work + '/source',
  owned = work + '/owned',
  bin = work + '/sal';
const reportPath = resolve(option('--report') ?? '.state/evidence/m12/remote.json');
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
    `import{call}from${JSON.stringify(repo + '/dist/src/transport.js')};console.log(JSON.stringify(await call(${JSON.stringify(state + '/operator.sock')},${JSON.stringify(path)},${JSON.stringify(body)})));`,
  );
const cli = async (...args) => JSON.parse(await ssh([bin, ...args, '--state', state]));
let pid, first, observer, session, taskId;
let manifest;
const boot = async () => {
  pid = await js(
    `import{spawn}from'node:child_process';import{openSync}from'node:fs';const fd=openSync(${JSON.stringify(work + '/host.log')},'a');const p=spawn(${JSON.stringify(node)},[${JSON.stringify(repo + '/bin/salaam.mjs')},'host','run','--manifest',${JSON.stringify(work + '/host.json')}],{detached:true,stdio:['ignore',fd,fd],env:{PATH:${JSON.stringify(node.slice(0, -5) + ':/usr/bin:/bin')},HOME:${JSON.stringify(state)},LANG:'en_US.UTF-8'}});p.unref();console.log(JSON.stringify(p.pid));`,
  );
  await until(() => rpc('/v1/health').catch(() => null), Boolean, 45000);
};
const kill = async () => {
  if (pid) {
    await js(
      `try{process.kill(${pid},'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}console.log('true');`,
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
  const files = {
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
      "import{test}from'node:test';import assert from'node:assert/strict';import{add}from'./math.js';test('addition',()=>assert.equal(add(2,3),5));\n",
  };
  await js(
    `import{mkdirSync,writeFileSync,chmodSync}from'node:fs';for(const p of ${JSON.stringify([work, state, source, owned])})mkdirSync(p,{recursive:true,mode:448});for(const[p,text]of Object.entries(${JSON.stringify(files)}))writeFileSync(p,text);chmodSync(${JSON.stringify(bin)},448);console.log('true');`,
  );
  manifest = await js(
    `import{planHost,hostUnit}from${JSON.stringify(repo + '/dist/src/host.js')};import{writeFileSync}from'node:fs';const m=await planHost(${JSON.stringify({ state, coding_root: owned, coding_socket: '/var/run/docker.sock' })});writeFileSync(${JSON.stringify(work + '/host.json')},JSON.stringify(m),{mode:384});writeFileSync(${JSON.stringify(work + '/salaam.service')},hostUnit(${JSON.stringify(work + '/host.json')},'systemd'));console.log(JSON.stringify(m));`,
  );
  report.manifest = manifest;
  await boot();
  report.executor = await js(
    `import{readFileSync}from'node:fs';console.log(readFileSync(${JSON.stringify(state + '/executor-proof.json')},'utf8'));`,
  );
  session = await cli('session', 'create', '--cwd', source, '--coding');
  await until(
    () => rpc('/v1/sessions/' + session.id),
    (s) => s.state === 'ready',
    30000,
  );
  const patch = {
    action: 'patch',
    path: 'math.js',
    expected_revision: 0,
    expected_hash: digest({
      content: Buffer.from(files[source + '/math.js']).toString('base64'),
      executable: false,
    }),
    content: 'export const add = (a,b) => a+b;\n',
  };
  const plan = {
    objective: 'A bounded recurring remote repair with a checked diff',
    constraints: ['Preserve human.txt'],
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
        title: 'Review the checked repair',
        instruction: '[review] m12-addition',
        depends_on: ['repair'],
        checks: ['suite'],
      },
    ],
  };
  await js(
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(work + '/plan.json')},${JSON.stringify(JSON.stringify(plan))});console.log('true');`,
  );
  const templateTask = await cli(
    'tasks',
    'create',
    session.id,
    '--plan',
    work + '/plan.json',
    '--revision',
    '0',
  );
  const definition = await cli(
    'schedules',
    'create',
    templateTask.id,
    '--name',
    'M12 remote repair',
    '--revision',
    String(templateTask.revision),
    '--max-steps',
    '2',
  );
  report.template = definition;
  const accepted = await cli(
    'schedules',
    'run',
    definition.id,
    '--key',
    'pilot-1',
    '--revision',
    '1',
    '--request-id',
    'pilot-trigger',
  );
  report.reservation = accepted;
  const occurrences = await until(
    () => cli('schedules', 'occurrences', definition.id),
    (v) => !!v.occurrences[0]?.job_run_id,
    30000,
  );
  const occurrence = occurrences.occurrences[0],
    run = await rpc('/v1/jobs/' + occurrence.job_run_id);
  session = { id: occurrence.session_id };
  taskId = run.task_id;
  report.job_run = run;
  let task = await until(
    () => rpc('/v1/tasks/' + taskId),
    (t) => t.state === 'waiting_for_person',
    45000,
  );
  assert.equal(task.steps[0].state, 'completed');
  first = terminal();
  await first.contains('You have control', 30000);
  await first.write('\x07');
  await first.contains('math.js');
  await first.capture(join(reportPath, '../screens/ssh-checked-diff.svg'));
  const diff = await rpc('/v1/sessions/' + session.id + '/workspace/diff');
  report.diff = diff;
  assert.equal(diff.changes[0].path, 'math.js');
  const attemptsBefore = (await rpc('/v1/sessions/' + session.id + '/snapshot')).attempts;
  await first.command({ op: 'signal', signal: 'SIGKILL' });
  await first.exit();
  first = undefined;
  const duplicate = await cli(
    'schedules',
    'run',
    definition.id,
    '--key',
    'pilot-1',
    '--revision',
    '0',
    '--request-id',
    'logical-retry',
  );
  assert.equal(duplicate.id, accepted.id);
  assert.equal(duplicate.session_id, accepted.session_id);
  await assert.rejects(
    () => cli('schedules', 'run', definition.id, '--key', 'overlap', '--revision', '1'),
    /settlement/,
  );
  const snapshotsBefore = await rpc('/v1/sessions/' + session.id + '/snapshot');
  assert.equal(snapshotsBefore.attempts.length, attemptsBefore.length);
  record('same-job-after-terminal-loss-duplicate-and-overlap', {
    occurrence_id: accepted.id,
    session_id: session.id,
    task_id: taskId,
  });
  observer = terminal(true);
  await observer.contains('Observer', 30000);
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
  report.completed = task;
  report.commands = await rpc('/v1/sessions/' + session.id + '/commands');
  assert.equal(report.commands.filter((r) => r.exit_code === 0).length, 3);
  report.inbox = await until(
    () => rpc('/v1/inbox'),
    (v) => v.items.some((i) => i.kind === 'result'),
    15000,
  );
  await observer.write('\x0b');
  await observer.contains('Salaam · actions');
  await observer.write('Session context\r');
  await until(
    () => observer.screen(),
    (s) => s.includes('SESSION CONTEXT') || s.includes('TASK FACTS'),
  );
  await observer.write('\x1b[1;5H');
  await observer.contains('OPERATOR INBOX');
  await observer.capture(join(reportPath, '../screens/ssh-completed.svg'));
  await observer.write('\x03');
  assert.equal((await observer.exit()).restored, true);
  observer = undefined;
  const workspace = await rpc('/v1/sessions/' + session.id + '/workspace');
  report.workspace = workspace;
  report.files = await js(
    `import{readFileSync}from'node:fs';console.log(JSON.stringify({source:readFileSync(${JSON.stringify(source + '/math.js')},'utf8'),result:readFileSync(${JSON.stringify(workspace.root + '/math.js')},'utf8'),human:readFileSync(${JSON.stringify(workspace.root + '/human.txt')},'utf8')}));`,
  );
  assert.match(report.files.source, /a-b/);
  assert.match(report.files.result, /a\+b/);
  assert.equal(report.files.human, files[source + '/human.txt']);
  // Enable a short skip-policy schedule, then crash only the supervised daemon while its task is settled.
  const def = { kind: 'interval', anchor: 0, every_ms: 1000, missed: 'skip', max_catch_up: 1 };
  await js(
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(work + '/schedule.json')},${JSON.stringify(JSON.stringify(def))});console.log('true');`,
  );
  await cli(
    'schedules',
    'update',
    definition.id,
    '--revision',
    '1',
    '--status',
    'active',
    '--schedule',
    work + '/schedule.json',
  );
  const beforeHost = await cli('host', 'inspect', '--manifest', work + '/host.json');
  report.before_host_restart = beforeHost.supervisor;
  await js(`process.kill(${beforeHost.supervisor.daemon_pid},'SIGKILL');console.log('true');`);
  await until(
    () => rpc('/v1/health').catch(() => null),
    (h) => h === null,
    5000,
  ).catch(() => {});
  await until(
    () => cli('host', 'inspect', '--manifest', work + '/host.json').catch(() => null),
    (h) =>
      h?.supervisor?.daemon_pid !== beforeHost.supervisor.daemon_pid &&
      h?.health?.service === 'healthy',
    60000,
  );
  const afterHost = await cli('host', 'inspect', '--manifest', work + '/host.json');
  report.after_host_restart = afterHost.supervisor;
  assert.ok(afterHost.supervisor.restarts > beforeHost.supervisor.restarts);
  const schedule = await cli('schedules', 'inspect', definition.id);
  await cli(
    'schedules',
    'update',
    definition.id,
    '--revision',
    String(schedule.revision),
    '--status',
    'paused',
    '--schedule',
    work + '/schedule.json',
  );
  const durable = await cli(
    'schedules',
    'run',
    definition.id,
    '--key',
    'pilot-1',
    '--revision',
    '0',
    '--request-id',
    'post-restart-retry',
  );
  assert.equal(durable.id, accepted.id);
  assert.equal((await rpc('/v1/tasks/' + taskId)).state, 'succeeded');
  report.events = await js(
    `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(${JSON.stringify(state + '/journal.sqlite')},{readOnly:true});console.log(JSON.stringify({skips:db.prepare("SELECT payload FROM events WHERE kind='schedule.skipped'").all().map(r=>JSON.parse(r.payload)),occurrences:db.prepare('SELECT * FROM recurring_occurrences').all(),attempts:db.prepare('SELECT id,session_id,state FROM attempts').all()}));db.close();`,
  );
  assert.ok(report.events.skips.some((s) => s.reason === 'missed-policy'));
  // Stop additional scheduled work explicitly; the original successful occurrence is retained.
  for (const r of report.events.occurrences.filter((r) => r.id !== accepted.id && r.job_run_id)) {
    const j = await rpc('/v1/jobs/' + r.job_run_id);
    if (!['succeeded', 'cancelled'].includes(j.state))
      await cli('jobs', 'cancel', j.id, '--revision', String(j.revision), '--takeover');
  }
  record('supervised-daemon-sigkill-missed-slot-and-stable-retry', {
    restart_count: afterHost.supervisor.restarts,
    missed: report.events.skips.length,
  });
  const supervisorBefore = pid;
  await js(`process.kill(${pid},'SIGKILL');console.log('true');`);
  pid = undefined;
  await until(
    () => rpc('/v1/health').catch(() => null),
    (h) => h === null,
    30000,
  );
  await boot();
  const recovered = await cli(
    'schedules',
    'run',
    definition.id,
    '--key',
    'pilot-1',
    '--revision',
    '0',
    '--request-id',
    'supervisor-retry',
  );
  assert.equal(recovered.id, accepted.id);
  report.supervisor_recovery = {
    old_pid: supervisorBefore,
    new_pid: pid,
    same_occurrence: recovered.id,
  };
  record(
    'supervisor-death-fences-daemon-and-fresh-supervisor-preserves-job',
    report.supervisor_recovery,
  );
  report.paid_provider_calls = 0;
  report.success = true;
} catch (error) {
  report.error = error.stack;
  save();
  throw error;
} finally {
  await first?.close();
  await observer?.close();
  await kill();
  await until(
    () => rpc('/v1/health').catch(() => null),
    (h) => h === null,
    30000,
  ).catch(() => {});
  report.cleanup = await js(
    `import{DatabaseSync}from'node:sqlite';import{existsSync,rmSync}from'node:fs';import{DockerCodingExecutor}from${JSON.stringify(repo + '/dist/src/coding-executor.js')};import{engineRequest,engineJson}from${JSON.stringify(repo + '/dist/src/execution-boundary.js')};let runs=[];if(existsSync(${JSON.stringify(state + '/journal.sqlite')})){const db=new DatabaseSync(${JSON.stringify(state + '/journal.sqlite')},{readOnly:true});runs=db.prepare('SELECT id,profile_digest FROM command_runs').all();db.close();}const request=engineRequest('/var/run/docker.sock'),executor=new DockerCodingExecutor(request);for(const r of runs){executor.profileDigest=r.profile_digest;await executor.cleanup(r.id);}const rows=engineJson(await request('GET','/containers/json?all=1'));if(rows.some(c=>runs.some(r=>c.Labels?.['salaam.command.run']===r.id)))throw Error('Owned containers remain');rmSync(${JSON.stringify(state)},{recursive:true,force:true});rmSync(${JSON.stringify(work)},{recursive:true,force:true});console.log(JSON.stringify({owned_containers_remaining:0,disposable_state_removed:true,disposable_workspace_removed:true}));`,
  );
  report.finished_at = new Date().toISOString();
  save();
}
console.log(JSON.stringify({ success: report.success, report: reportPath }));
