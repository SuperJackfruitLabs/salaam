import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../dist/src/transport.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = mkdtempSync('/tmp/sal-managed-demo-');
const effectState = mkdtempSync('/tmp/sal-demo-effect-');
const cli = join(root, 'dist/src/cli.js');
const socket = join(state, 'operator.sock');
const effectSocket = join(effectState, 'effects.sock');
let service;
let external;
const run = async (...args) =>
  (
    await promisify(execFile)(process.execPath, [cli, ...args, '--state', state], {
      timeout: 15000,
    })
  ).stdout;
const until = async (fn, check) => {
  for (let i = 0; i < 200; i++) {
    const value = await fn();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Demo condition timed out');
};
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  let timer;
  await Promise.race([
    exit,
    new Promise((resolve) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
    }),
  ]);
  clearTimeout(timer);
  await exit;
};
try {
  external = spawn(process.execPath, [join(root, 'test/fixtures/mock-effect.mjs'), effectState]);
  await once(external.stdout, 'data');
  service = spawn(process.execPath, [
    cli,
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
    (value) => value.state === 'ready',
  );
  await run('session', 'submit', session.id, '--text', '[effect] alpha,beta');
  const approvals = await until(
    async () => JSON.parse(await run('approvals', 'list', '--session', session.id)),
    (value) => value.length === 2,
  );
  const details = await Promise.all(
    approvals.map(async (approval) => ({
      approval,
      operation: await call(socket, `/v1/operations/${approval.operation_id}`),
    })),
  );
  const beta = details.find((value) => value.operation.target === 'beta');
  const alpha = details.find((value) => value.operation.target === 'alpha');
  await run(
    'approvals',
    'approve',
    beta.approval.id,
    '--digest',
    beta.approval.operation_digest,
    '--revision',
    String(beta.approval.revision),
  );
  await run(
    'approvals',
    'deny',
    alpha.approval.id,
    '--digest',
    alpha.approval.operation_digest,
    '--revision',
    String(alpha.approval.revision),
  );
  const snapshot = await until(
    () => call(socket, `/v1/sessions/${session.id}/snapshot`),
    (value) => value.attempts[0]?.state === 'completed',
  );
  const effects = await call(effectSocket, '/stats');
  if (effects.count !== 1 || effects.posts !== 1 || effects.effects[0]?.payload.target !== 'beta')
    throw new Error('Demo did not execute only the approved effect');
  await run('operations', 'reconcile', beta.operation.id);
  console.log(
    JSON.stringify(
      {
        session_id: session.id,
        attempt: snapshot.attempts[0].state,
        operations: snapshot.operations.map((op) => ({ target: op.target, state: op.state })),
        external: effects,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (service && service.exitCode === null && service.signalCode === null)
      await run('service', 'stop');
  } catch {}
  await stop(service);
  await stop(external);
  rmSync(state, { recursive: true, force: true });
  rmSync(effectState, { recursive: true, force: true });
}
