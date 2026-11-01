// Opt-in rehearsal against a source checkout/runtime already provisioned by the operator.
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
import { DemoAcpClient } from './acp-client.mjs';
const option = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const host = option('--host'),
  root = option('--root'),
  reportPath = resolve(option('--report') ?? '.state/evidence/m10/remote.json');
if (
  !host ||
  !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host) ||
  !root ||
  !/^\/home\/[a-zA-Z0-9_-]+\/\.cache\/salaam-m10\.[a-zA-Z0-9]+$/.test(root)
)
  throw Error(
    'Supply the explicitly permitted --host and owned /home/USER/.cache/salaam-m10.ID --root.',
  );
const work = root + '/r-' + randomUUID().slice(0, 8);
const repo = root + '/repo',
  node = root + '/node-v26.7.0-linux-x64/bin/node',
  bin = root + '/bin/sal',
  state = work + '/state',
  source = work + '/task';
const sshBase = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ClearAllForwardings=yes',
];
const ssh = async (argv) =>
  (
    await promisify(execFile)('ssh', [...sshBase, host, argv.map(shellQuote).join(' ')], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const cli = async (...args) => JSON.parse(await ssh([bin, ...args, '--state', state]));
const get = async (path) =>
  JSON.parse(
    await ssh([
      node,
      '--input-type=module',
      '-e',
      `import{call}from${JSON.stringify(repo + '/dist/src/core/transport.js')};console.log(JSON.stringify(await call(${JSON.stringify(state + '/operator.sock')},${JSON.stringify(path)})));`,
    ]),
  );
const snapshot = (id) => get('/v1/sessions/' + id + '/snapshot');
const report = {
  schema: 1,
  started_at: new Date().toISOString(),
  host_alias: host,
  fixture_root: work,
  scope:
    'Real macOS PTY → SSH → Linux TUI and ACP protocol client. Offline provider only. Zed GUI is a separate pending check.',
  success: false,
  steps: [],
};
mkdirSync(join(reportPath, '..'), { recursive: true });
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
save();
const record = (name, details = {}) => {
  report.steps.push({ name, ...details });
  save();
  console.log(name);
};
const prompt = (terminal, text) =>
  terminal.write('\x1b[200~' + text + '\x1b[201~').then(() => terminal.write('\r'));
const done = async (id, n) =>
  until(
    () => snapshot(id),
    (s) => s.attempts.length === n && s.attempts.every((a) => a.state === 'completed'),
    25000,
  );
const uiArgs = (id) => [
  resolve('bin/salaam.mjs'),
  'remote',
  host,
  '--remote-bin',
  bin,
  '--state',
  state,
  '--session',
  id,
];
const localState = join(reportPath, '../pty-home');
mkdirSync(localState, { recursive: true });
let first, second, observer, acp;
try {
  await ssh([
    node,
    '--input-type=module',
    '-e',
    `import{existsSync,mkdirSync,writeFileSync}from'node:fs';const root=${JSON.stringify(root)};if(!existsSync(root+'/repo/pi-pin.json'))throw Error('Provision the pinned checkout first');mkdirSync(root+'/bin',{recursive:true,mode:448});mkdirSync(${JSON.stringify(source)},{recursive:true,mode:448});writeFileSync(root+'/bin/sal',${JSON.stringify('#!/bin/sh\nPATH=' + shellQuote(root + '/node-v26.7.0-linux-x64/bin') + ':"$PATH"\nexport PATH\nexec ' + shellQuote(node) + ' ' + shellQuote(repo + '/bin/salaam.mjs') + ' "$@"\n')},{mode:448});writeFileSync(${JSON.stringify(source + '/math.js')},'exports.add = (a,b) => a-b;\\n');writeFileSync(${JSON.stringify(source + '/math.test.js')},"const{test}=require('node:test');const assert=require('node:assert/strict');const{add}=require('./math.js');test('adds',()=>assert.equal(add(2,3),5));\\n");`,
  ]);
  report.runtime = JSON.parse(
    await ssh([
      node,
      '--input-type=module',
      '-e',
      `import{bundleDigest}from${JSON.stringify(repo + '/dist/src/core/config.js')};import{readFileSync,readdirSync}from'node:fs';import{createHash}from'node:crypto';const hash=bytes=>createHash('sha256').update(bytes).digest('hex');const files=readdirSync(${JSON.stringify(repo + '/src')}).filter(f=>f.endsWith('.ts')&&!f.startsWith('._')).sort().map(f=>({path:'src/'+f,sha256:hash(readFileSync(${JSON.stringify(repo + '/src/')}+f))}));console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,bundle_digest:bundleDigest(),runtime_source_digest:hash(JSON.stringify(files)),lock_digest:hash(readFileSync(${JSON.stringify(repo + '/package-lock.json')}))}));`,
    ]),
  );
  save();
  await cli(
    'service',
    'start',
    '--provider',
    'offline',
    '--coding-root',
    work + '/owned',
    '--coding-socket',
    '/var/run/docker.sock',
  );
  const session = await cli('session', 'create', '--cwd', source, '--coding');
  const id = session.id;
  await until(
    () => snapshot(id),
    (s) => s.state === 'ready',
    20000,
  );
  report.session_id = id;
  record('remote-service-ready');
  first = new PtyClient(uiArgs(id), { state: localState, columns: 116, rows: 40 });
  await first.contains('You have control', 20000);
  const patch = {
    action: 'patch',
    path: 'math.js',
    expected_revision: 0,
    expected_hash: digest({
      content: Buffer.from('exports.add = (a,b) => a-b;\n').toString('base64'),
      executable: false,
    }),
    content: 'exports.add = (a,b) => a+b;\n',
  };
  await prompt(first, '[files] ' + JSON.stringify(patch));
  await done(id, 1);
  const workspace = await get(`/v1/sessions/${id}/workspace`);
  assert.equal(workspace.revision, 1);
  report.workspace = { id: workspace.id, revision: workspace.revision, digest: workspace.digest };
  const command = {
    action: 'start',
    step_key: 'remote-test-once',
    command: 'sleep 15; node --test',
    expected_revision: 1,
  };
  await prompt(first, '[command] ' + JSON.stringify(command));
  const runs = await until(
    () => get(`/v1/sessions/${id}/commands?summary=1`),
    (runs) => runs[0]?.state === 'running',
    15000,
  );
  const runId = runs[0].id;
  report.command_id = runId;
  const before = await snapshot(id);
  const attempt = before.attempts.find((a) => a.state === 'running');
  assert.ok(attempt);
  report.attempt_id = attempt.id;
  report.worker_epoch = before.epoch;
  save();
  await first.command({ op: 'signal', signal: 'SIGKILL' });
  await first.exit();
  record('ssh-client-killed-during-real-command', { run_id: runId, attempt_id: attempt.id });
  second = new PtyClient([...uiArgs(id), '--observe'], {
    state: localState,
    columns: 116,
    rows: 40,
  });
  await second.contains('Observer', 20000);
  await second.write('\x0b');
  await second.contains('Salaam · actions');
  await second.write('Take control\r');
  await second.contains('Keep current state');
  await second.write('\x1b[C\r');
  await second.contains('You have control');
  await done(id, 2);
  const finished = await get(`/v1/sessions/${id}/commands/${runId}`);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.exit_code, 0);
  assert.equal((await snapshot(id)).epoch, before.epoch);
  assert.equal((await get(`/v1/sessions/${id}/commands?summary=1`)).length, 1);
  record('observer-takeover-same-worker-attempt-command', { exit_code: finished.exit_code });
  await second.write('\x14');
  await second.contains('exit 0');
  await second.capture(join(reportPath, '../remote-commands.svg'));
  await second.write('\x07');
  await second.contains('+exports.add = (a,b) => a+b;');
  await second.capture(join(reportPath, '../remote-diff.svg'));
  await prompt(second, '[review] alpha,beta');
  await until(
    () => snapshot(id),
    (s) => s.approvals.filter((a) => a.state === 'pending').length === 2,
  );
  observer = new PtyClient([...uiArgs(id), '--observe'], {
    state: localState,
    columns: 116,
    rows: 40,
  });
  await observer.contains('Observer', 20000);
  await observer.write('\x0f');
  await observer.contains('Approvals waiting');
  await observer.write('beta\r');
  await observer.contains('Review approval');
  await observer.write('\x1b[F');
  await observer.contains('Exact request binding reviewed.');
  await observer.capture(join(reportPath, '../remote-approval.svg'));
  await observer.write('\x1b[C\r');
  await until(
    () => snapshot(id),
    (s) => s.approvals.some((a) => a.decision === 'approve'),
  );
  await observer.write('\x0f');
  await observer.contains('Review approval');
  await observer.write('\r');
  const approved = await done(id, 3);
  assert.deepEqual(approved.approvals.map((a) => a.decision).sort(), ['approve', 'deny']);
  record('remote-observer-reverse-bound-approvals');
  await observer.write('\x03');
  assert.equal((await observer.exit()).restored, true);
  await second.write('\x03');
  assert.equal((await second.exit()).restored, true);
  await cli('service', 'stop');
  await cli(
    'service',
    'start',
    '--provider',
    'offline',
    '--coding-root',
    work + '/owned',
    '--coding-socket',
    '/var/run/docker.sock',
  );
  second = new PtyClient(uiArgs(id), { state: localState, columns: 116, rows: 40 });
  await second.contains('You have control', 20000);
  await until(
    () => snapshot(id),
    (s) => s.state === 'ready' && s.epoch > before.epoch,
    20000,
  );
  assert.equal((await get(`/v1/sessions/${id}/commands/${runId}`)).exit_code, 0);
  assert.equal((await get(`/v1/sessions/${id}/workspace`)).digest, workspace.digest);
  assert.equal((await snapshot(id)).attempts.length, 3);
  record('remote-daemon-restart-preserves-identities');
  await second.write('\x03');
  assert.equal((await second.exit()).restored, true);
  acp = new DemoAcpClient('ssh', [
    ...sshBase,
    host,
    [bin, 'acp', '--coding', '--state', state].map(shellQuote).join(' '),
  ]);
  const init = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(init.agentInfo.title, 'Salaam');
  const coding = await acp.request('session/new', { cwd: source, mcpServers: [] });
  const ask = async (text) =>
    acp.request('session/prompt', {
      sessionId: coding.sessionId,
      prompt: [{ type: 'text', text }],
    });
  await ask('[files] ' + JSON.stringify(patch));
  await ask(
    '[command] ' +
      JSON.stringify({ ...command, command: 'node --test', step_key: 'acp-test-once' }),
  );
  const acpRuns = await get(`/v1/sessions/${coding.sessionId}/commands?summary=1`);
  assert.equal(acpRuns[0].exit_code, 0);
  assert.ok(
    acp.messages.some(
      (m) =>
        m.params?.update?.sessionUpdate === 'tool_call_update' &&
        m.params.update.status === 'completed',
    ),
  );
  record('real-ssh-acp-coding-protocol', {
    session_id: coding.sessionId,
    workspace_id: (await get(`/v1/sessions/${coding.sessionId}/workspace`)).id,
    run_id: acpRuns[0].id,
    exit_code: 0,
  });
  report.source_content = await ssh([
    node,
    '--input-type=module',
    '-e',
    `import{readFileSync}from'node:fs';console.log(readFileSync(${JSON.stringify(source + '/math.js')},'utf8'));`,
  ]);
  assert.equal(report.source_content, 'exports.add = (a,b) => a-b;');
  report.final = await snapshot(id);
  report.success = true;
  report.finished_at = new Date().toISOString();
  save();
} catch (error) {
  report.error = error.stack;
  save();
  throw error;
} finally {
  await acp?.close();
  await first?.close();
  await second?.close();
  await observer?.close();
  await cli('service', 'stop').catch(() => {});
}
console.log(JSON.stringify({ success: true, report: reportPath }));
