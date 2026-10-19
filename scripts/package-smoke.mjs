import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const tarball = resolve(
  process.argv[2] ??
    `.state/release/salaam-cli-${JSON.parse(readFileSync('package.json')).version}.tgz`,
);
const temp = mkdtempSync(join(tmpdir(), 'sal-smoke-'));
const prefix = join(temp, 'prefix'),
  state = join(temp, 'state');
const env = {
  ...process.env,
  HOME: temp,
  XDG_CONFIG_HOME: join(temp, 'config'),
  npm_config_cache: join(temp, 'empty-cache'),
};
// Do not let an installed package access the operator's provider credentials.
for (const key of Object.keys(env))
  if (/API_KEY|TOKEN|SECRET|CREDENTIAL/i.test(key)) delete env[key];
let service;
let stderr = '';
const run = async (command, ...args) =>
  (await exec(command, args, { cwd: temp, env, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
const wait = async (observe, accepts = Boolean) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (service?.exitCode !== null && service?.exitCode !== undefined)
      throw new Error('Installed service exited: ' + stderr);
    try {
      const value = await observe();
      if (accepts(value)) return value;
    } catch (e) {
      if (Date.now() + 150 >= deadline) throw e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Installed package timed out: ' + stderr);
};
try {
  const listing = (await run('tar', '-tzf', tarball)).trim().split('\n');
  assert(listing.includes('package/npm-shrinkwrap.json'));
  for (const name of ['package.json', 'package-lock.json', 'codex-pins.json'])
    assert(listing.includes('package/harness-runtime/' + name));
  assert(listing.includes('package/src/host.ts'));
  assert(listing.includes('package/dist/src/house-extension.js'));
  assert(
    !listing.some((p) =>
      /^package\/(?:\.state|\.git|test|landing|docs-site|credentials|\.env)(?:\/|$)/.test(p),
    ),
  );
  const manifest = JSON.parse(readFileSync(join(dirname(tarball), 'release.json')));
  const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  assert.equal(hash, manifest.package_sha256);
  await run(
    'npm',
    'install',
    '--global',
    '--prefix',
    prefix,
    '--ignore-scripts',
    '--offline',
    '--no-audit',
    '--no-fund',
    tarball,
  );
  const sal = join(prefix, 'bin/sal'),
    salaam = join(prefix, 'bin/salaam');
  assert.equal(realpathSync(sal), realpathSync(salaam));
  const installed = resolve(dirname(realpathSync(sal)), '..');
  assert(!installed.startsWith(resolve('.') + '/'));
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json')));
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.scripts, undefined);
  assert.equal(await run(sal, '--version'), `salaam ${pkg.version}\n`);
  assert.equal(await run(sal, '--help'), await run(salaam, '--help'));
  // Imports below come exclusively from the installed package, outside the source checkout.
  const { call } = await import(pathToFileURL(join(installed, 'dist/src/transport.js')));
  const { hostDigests } = await import(pathToFileURL(join(installed, 'dist/src/host.js')));
  assert.match(hostDigests().pi_bundle_digest, /^[a-f0-9]{64}$/);
  const start = async () => {
    service = spawn(salaam, ['service', 'start', '--foreground', '--state', state], {
      cwd: temp,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    service.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await wait(() => call(join(state, 'operator.sock'), '/v1/health'));
  };
  const stop = async () => {
    const exited = once(service, 'exit');
    await run(sal, 'service', 'stop', '--state', state);
    await exited;
  };
  await start();
  const session = JSON.parse(await run(sal, 'session', 'create', '--cwd', temp, '--state', state));
  const snapshot = () => call(join(state, 'operator.sock'), `/v1/sessions/${session.id}/snapshot`);
  await wait(snapshot, (s) => s.state === 'ready');
  await run(
    sal,
    'session',
    'submit',
    session.id,
    '--text',
    'release package proof',
    '--state',
    state,
  );
  const completed = await wait(snapshot, (s) => s.attempts[0]?.state === 'completed');
  assert.equal(completed.attempts[0].result, 'Offline reply: release package proof');
  const attempt = completed.attempts[0].id;
  await stop();
  await start();
  const recovered = await snapshot();
  assert.equal(recovered.id, session.id);
  assert.equal(recovered.attempts.length, 1);
  assert.equal(recovered.attempts[0].id, attempt);
  assert.equal(recovered.attempts[0].state, 'completed');
  await run(sal, 'session', 'resume', session.id, '--state', state);
  await wait(snapshot, (s) => s.state === 'ready');
  await run(salaam, 'session', 'probe', session.id, '--state', state);
  assert.equal(
    (await snapshot()).attempts.filter((a) => a.result === 'Offline reply: release package proof')
      .length,
    1,
  );
  await stop();
  console.log(
    JSON.stringify(
      {
        workflow_run_id: process.env.GITHUB_RUN_ID ?? null,
        workflow_run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
        package: pkg.name,
        version: pkg.version,
        sha256: hash,
        platform: process.platform,
        arch: process.arch,
        install: 'offline empty-cache',
        aliases: true,
        pinned_pi_readiness: true,
        offline_turn: true,
        daemon_restart_same_attempt: true,
        source_checkout_required: false,
      },
      null,
      2,
    ),
  );
} finally {
  if (service && service.exitCode === null && service.signalCode === null) {
    const exit = once(service, 'exit');
    service.kill('SIGTERM');
    await exit;
  }
  rmSync(temp, { recursive: true, force: true });
}
