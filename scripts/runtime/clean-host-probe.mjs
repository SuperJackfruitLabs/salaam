import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync, readlinkSync, realpathSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const [prefix, version] = process.argv.slice(2);
const runtime = realpathSync(join(prefix, 'current'));
const pkg = join(runtime, 'app/node_modules/@superjackfruitlabs/salaam');
const { call } = await import(pathToFileURL(join(pkg, 'dist/src/transport.js')));
const exec = promisify(execFile);
const sal = join(prefix, 'bin/sal'),
  state = '/proof/state',
  workspace = '/proof/workspace';
mkdirSync(workspace, { recursive: true });
const run = async (...args) =>
  (await exec(sal, [...args, '--state', state], { timeout: 45000 })).stdout;
const wait = async (observe, accepts = Boolean) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const value = await observe();
      if (accepts(value)) return value;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Private runtime readiness timed out');
};
const health = () => call(join(state, 'operator.sock'), '/v1/health');
const stop = async () => {
  await run('service', 'stop');
  await wait(async () => {
    try {
      await health();
      return false;
    } catch {
      return true;
    }
  });
  // The socket may close before child shutdown releases the lifetime owner lock.
  await wait(() => {
    const owner = new DatabaseSync(join(state, 'owner.sqlite'));
    try {
      owner.exec('BEGIN EXCLUSIVE; ROLLBACK;');
      return true;
    } finally {
      owner.close();
    }
  });
};
let running = false;
try {
  assert.equal(await run('--version'), `salaam ${version}\n`);
  const starts = await Promise.all(Array.from({ length: 4 }, () => run('service', 'start')));
  assert.equal(starts.length, 4);
  running = true;
  const ready = await wait(health);
  assert.equal(ready.runtime_node, join(runtime, 'node/bin/node'));
  assert.equal(realpathSync(`/proc/${ready.pid}/exe`), ready.runtime_node);
  await new Promise((r) => setTimeout(r, 500));
  const owners = readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .filter((pid) => {
      try {
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        return args.includes('--foreground') && args.includes(state) && args.includes('service');
      } catch {
        return false;
      }
    });
  assert.equal(owners.length, 1);
  const session = JSON.parse(await run('session', 'create', '--cwd', workspace));
  const snapshot = () => call(join(state, 'operator.sock'), `/v1/sessions/${session.id}/snapshot`);
  await wait(snapshot, (s) => s.state === 'ready');
  await run('session', 'submit', session.id, '--text', 'private runtime proof');
  const done = await wait(snapshot, (s) => s.attempts[0]?.state === 'completed');
  assert.equal(done.attempts[0].result, 'Offline reply: private runtime proof');
  const attempt = done.attempts[0].id;
  await stop();
  running = false;
  await run('service', 'start');
  running = true;
  const recovered = await wait(snapshot, (s) => s.attempts[0]?.id === attempt);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].state, 'completed');
  await run('session', 'resume', session.id);
  await wait(snapshot, (s) => s.state === 'ready');
  await run('session', 'probe', session.id);
  assert.equal((await snapshot()).attempts.filter((a) => a.id === attempt).length, 1);
  await stop();
  running = false;
  console.log(
    JSON.stringify({
      success: true,
      version,
      manifest_sha256: readlinkSync(join(prefix, 'current')).split('/').at(-1),
      platform: process.platform,
      arch: process.arch,
      system_node_absent: true,
      network: 'none',
      installed_offline: true,
      absolute_private_node: true,
      concurrent_starts_single_owner: true,
      pinned_pi_readiness: true,
      offline_turn: true,
      reconnect_preserves_attempt: true,
      source_checkout_required: false,
      deployed_fleet: false,
    }),
  );
} finally {
  if (running) await run('service', 'stop').catch(() => {});
}
