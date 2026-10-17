import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { call } from '../dist/src/transport.js';
import { DemoAcpClient } from './acp-client.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = mkdtempSync('/tmp/sal-accept-demo-'),
  externalState = mkdtempSync('/tmp/sal-demo-external-');
const bin = join(root, 'bin/salaam.mjs'),
  socket = join(state, 'operator.sock'),
  effectSocket = join(externalState, 'effects.sock');
let service, external, terminal, acp;
const run = async (...args) =>
  (
    await promisify(execFile)(process.execPath, [bin, ...args, '--state', state], {
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout;
const result = (text) => JSON.parse(text.slice(text.indexOf('\n') + 1));
const until = async (fn, accept) => {
  for (let i = 0; i < 300; i++) {
    const value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Combined demo timed out');
};
const kill = async (child) => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
  }
};
const connect = async (id, load = false) => {
  acp = new DemoAcpClient(process.execPath, [bin, 'acp', '--state', state]);
  acp.on('message', (message) => {
    if (message.method === 'session/request_permission')
      acp.send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          outcome: {
            outcome: 'selected',
            optionId:
              message.params.toolCall.rawInput.target === 'alpha' ? 'reject-once' : 'allow-once',
          },
        },
      });
  });
  await acp.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await acp.request(load ? 'session/load' : 'session/resume', {
    sessionId: id,
    cwd: state,
    mcpServers: [],
  });
  return acp;
};
const prompt = async (id, text) =>
  await acp.request('session/prompt', {
    sessionId: id,
    prompt: [{ type: 'text', text }],
    _meta: { 'salaam.dev/takeover': true, 'salaam.dev/requestId': randomUUID() },
  });
try {
  external = spawn(process.execPath, [join(root, 'test/fixtures/mock-effect.mjs'), externalState]);
  await once(external.stdout, 'data');
  service = spawn(process.execPath, [
    bin,
    'service',
    'start',
    '--foreground',
    '--state',
    state,
    '--effect-socket',
    effectSocket,
  ]);
  service.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await once(service.stdout, 'data');
  const session = JSON.parse(await run('session', 'create', '--cwd', state));
  await until(
    () => call(socket, `/v1/sessions/${session.id}`),
    (s) => s.state === 'ready',
  );
  const evidence = result(
    await run(
      'artifacts',
      'put',
      session.id,
      '--text',
      'Verified build artifact from before compaction.',
    ),
  );
  let version = 0;
  const fact = async (kind, text, extra = []) =>
    result(
      await run(
        'task',
        'update',
        session.id,
        '--task-version',
        String(version++),
        '--kind',
        kind,
        '--text',
        text,
        ...extra,
      ),
    );
  await fact('objective', 'Review a staging release');
  const old = (await fact('constraint', 'Deploy to production')).facts.at(-1);
  await fact('constraint', 'Use staging only', ['--supersedes', old.id]);
  await fact('completed', 'Build the package');
  await fact('outstanding', 'Review staging evidence');
  await fact('evidence', 'Build report', ['--artifact-id', evidence.artifact_id]);
  terminal = spawn(process.execPath, [bin, 'attach', session.id, '--state', state]);
  terminal.stderr.on('data', (chunk) => process.stderr.write(chunk));
  terminal.stdout.resume();
  terminal.stdin.write('[effect] alpha,beta\n');
  await until(
    () => call(socket, `/v1/approvals?session=${session.id}`),
    (a) => a.length === 2,
  );
  await kill(terminal); // The daemon and its two approvals outlive the first client.
  await connect(session.id, true);
  await until(
    () => call(socket, `/v1/sessions/${session.id}/snapshot`),
    (s) => s.attempts[0]?.state === 'completed',
  );
  await prompt(session.id, '[children] first,second');
  const children = await until(
    () => call(socket, `/v1/sessions/${session.id}/children`),
    (c) => c.length === 2 && c.every((x) => x.state === 'completed'),
  );
  const childResult = JSON.parse(await run('children', 'result', children[0].id));
  await run(
    'children',
    'ack',
    children[0].id,
    '--result',
    childResult.result_id,
    '--request-id',
    'demo-ack',
  );
  const compactions = [];
  for (let index = 0; index < 3; index++) {
    await prompt(
      session.id,
      'Prepare checkpoint ' + index + '. ' + 'retain useful context '.repeat(300),
    );
    await acp.close();
    acp = undefined;
    const started = result(
      await run('session', 'compact', session.id, '--task-version', String(version), '--takeover'),
    );
    const completed = await until(
      () => call(socket, `/v1/compactions/${started.id}`),
      (c) => c.state !== 'running',
    );
    if (completed.state !== 'completed') throw new Error('Compaction failed: ' + completed.error);
    compactions.push(completed.cursor);
    await connect(session.id);
  }
  const next = await prompt(session.id, '[next]');
  await prompt(session.id, '[history] ' + evidence.artifact_id);
  const view = JSON.parse(await run('session', 'inspect', session.id));
  const task = JSON.parse(await run('task', 'inspect', session.id));
  if (!view.messages.some((m) => m.text === 'Next explicit work: Review staging evidence'))
    throw new Error('Outstanding work changed');
  if (task.version !== 6 || !task.facts.find((f) => f.id === old.id)?.superseded_by)
    throw new Error('Correction lost');
  const stats = await call(effectSocket, '/stats');
  if (stats.count !== 1 || stats.posts !== 1)
    throw new Error('Expected one approved external fixture effect');
  console.log(
    JSON.stringify(
      {
        session_id: session.id,
        clients: ['installed terminal attach', 'ACP v1 stdio', 'installed CLI inspect'],
        detached_with_pending_approvals: 2,
        effect: stats,
        children: children.map((c) => ({ id: c.id, result_id: c.result_id })),
        compaction_cursors: compactions,
        task_version: task.version,
        evidence_artifact: evidence.artifact_id,
        next_attempt: next._meta['salaam.dev/attemptId'],
        usage: await call(socket, `/v1/sessions/${session.id}/usage`),
        scope: 'Local offline fixtures; not an SSH transport or live model evaluation',
      },
      null,
      2,
    ),
  );
} finally {
  await acp?.close();
  await kill(terminal);
  try {
    await run('service', 'stop');
  } catch {}
  await kill(service);
  await kill(external);
  rmSync(state, { recursive: true, force: true });
  rmSync(externalState, { recursive: true, force: true });
}
