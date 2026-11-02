import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call } from '../dist/src/core/transport.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = mkdtempSync('/tmp/sal-child-demo-'),
  socket = join(state, 'operator.sock'),
  cli = join(root, 'dist/src/cli/cli.js');
let service;
const run = async (...args) =>
  (
    await promisify(execFile)(process.execPath, [cli, ...args, '--state', state], {
      timeout: 15000,
    })
  ).stdout;
const until = async (fn, check) => {
  for (let i = 0; i < 200; i++) {
    const result = await fn();
    if (check(result)) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Demo timed out');
};
try {
  service = spawn(process.execPath, [cli, 'service', 'start', '--foreground', '--state', state]);
  service.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await once(service.stdout, 'data');
  const parent = JSON.parse(await run('session', 'create', '--cwd', state));
  await until(
    () => call(socket, `/v1/sessions/${parent.id}`),
    (x) => x.state === 'ready',
  );
  await run('session', 'submit', parent.id, '--text', '[children] first,second');
  const children = await until(
    async () => JSON.parse(await run('session', 'children', parent.id)),
    (rows) => rows.length === 2 && rows.every((x) => x.state === 'completed'),
  );
  const result = JSON.parse(await run('children', 'result', children[0].id));
  const again = JSON.parse(await run('children', 'result', children[0].id));
  if (JSON.stringify(result) !== JSON.stringify(again))
    throw new Error('Repeated delivery changed the result');
  await run(
    'children',
    'ack',
    children[0].id,
    '--result',
    result.result_id,
    '--request-id',
    'demo-ack',
  );
  await run(
    'children',
    'ack',
    children[0].id,
    '--result',
    result.result_id,
    '--request-id',
    'demo-ack',
  );
  const usage = JSON.parse(await run('session', 'usage', parent.id));
  if (usage.observations !== 6 || usage.unknown_observations !== 0)
    throw new Error('Unexpected request accounting');
  console.log(
    JSON.stringify(
      {
        parent_session: parent.id,
        children: children.map((x) => ({ id: x.id, state: x.state, result_id: x.result_id })),
        repeated_result: result.result_id,
        usage,
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
  if (service && service.exitCode === null && service.signalCode === null) {
    const exit = once(service, 'exit');
    service.kill('SIGTERM');
    const timer = setTimeout(() => service.kill('SIGKILL'), 2000);
    await exit;
    clearTimeout(timer);
  }
  rmSync(state, { recursive: true, force: true });
}
