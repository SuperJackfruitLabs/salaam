// Explicit Linux rehearsal only. No provider credentials or Docker socket are used.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { planHost } from '../../dist/src/host.js';
import { ROOT } from '../../dist/src/config.js';
import { call } from '../../dist/src/transport.js';

const exec = promisify(execFile);
assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v26.7.0');
assert.equal(process.execPath, '/private-runtime/node');
assert(!existsSync('/var/run/docker.sock'));
await assert.rejects(
  exec('/bin/sh', ['-c', 'command -v node'], { env: { PATH: '/usr/bin:/bin' } }),
);
const root = '/tmp/slh-' + randomUUID().slice(0, 8),
  workspace = join(root, 'w'),
  state = join(root, 's'),
  pinsPath = join(root, 'pins.json'),
  file = join(root, 'host.json');
mkdirSync(workspace, { recursive: true, mode: 0o700 });
const pins = {
  version: 1,
  organization_id: 'org_00000000000000000001',
  node_id: 'node_linux',
  station_key: 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16),
  workspace,
};
writeFileSync(pinsPath, JSON.stringify(pins), { mode: 0o600 });
const manifest = await planHost({ mode: 'agentpod', state, agentpod_config: pinsPath });
writeFileSync(file, JSON.stringify(manifest), { mode: 0o600 });
const socket = join(state, 'operator.sock');
const until = async (fn, accept) => {
  const end = Date.now() + 30000;
  do {
    const value = await fn();
    if (accept(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw Error('Linux proof condition timed out');
};
let supervisor;
try {
  const results = await Promise.all(
    Array.from({ length: 3 }, async () =>
      JSON.parse(
        (
          await exec(
            process.execPath,
            [join(ROOT, 'bin/salaam.mjs'), 'host', 'start', '--manifest', file],
            { env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 30000 },
          )
        ).stdout,
      ),
    ),
  );
  assert(results.every((r) => r.ready && r.node === process.execPath));
  supervisor = JSON.parse(readFileSync(join(state, 'host/status.json'), 'utf8')).supervisor_pid;
  const binding = {
    ...pins,
    principal_id: 'prn_00000000000000000002',
    station_id: 'station_linux',
    occupancy_epoch: 1,
    hub_session_id: 'acps_linux',
    run: { source: 'agentpod', id: 'run_linux', epoch: 1 },
  };
  const admitted = await call(socket, '/v1/agentpod/admit', { binding, request_id: randomUUID() });
  await call(socket, '/v1/agentpod/renew', {
    binding,
    request_id: randomUUID(),
    lease_sequence: 1,
  });
  const id = admitted.session_id;
  const lease = await call(socket, `/v1/sessions/${id}/control`, {
    request_id: randomUUID(),
    client_id: 'linux-proof',
    action: 'acquire',
    expected_epoch: 0,
  });
  const controller = { client_id: 'linux-proof', token: lease.token };
  await call(socket, `/v1/sessions/${id}/resume`, controller);
  await until(
    () => call(socket, `/v1/sessions/${id}/snapshot`),
    (s) => {
      if (s.state === 'unhealthy') throw Error(s.error);
      return s.state === 'ready';
    },
  );
  const view = await call(socket, `/v1/sessions/${id}/snapshot`);
  const request = {
    ...controller,
    request_id: randomUUID(),
    expected_revision: view.revision,
    text: 'Hello from Linux with a private Node runtime',
  };
  const submission = await call(socket, `/v1/sessions/${id}/submissions`, request);
  const attempt = await until(
    () => call(socket, `/v1/attempts/${submission.attempt_id}`),
    (a) => !['accepted', 'dispatching', 'running'].includes(a.state),
  );
  assert.equal(attempt.state, 'completed', attempt.error);
  assert.equal(
    (await call(socket, `/v1/sessions/${id}/submissions`, request)).attempt_id,
    attempt.id,
  );
  const h = await call(socket, '/v1/health');
  assert.equal(h.coding_root, null);
  console.log(
    JSON.stringify({
      success: true,
      platform: process.platform,
      node: process.version,
      private_node: process.execPath,
      system_node_on_path: false,
      docker_socket: false,
      manifest_digest: results[0].manifest_digest,
      source_digest: manifest.source_digest,
      build_digest: manifest.build_digest,
      pi_bundle_digest: manifest.pi_bundle_digest,
      os_release: readFileSync('/etc/os-release', 'utf8'),
      tests: [
        'concurrent cold startup',
        'bound real Pi readiness',
        'offline model turn',
        'durable duplicate dispatch returns original attempt',
      ],
    }),
  );
} finally {
  if (!supervisor) {
    try {
      supervisor = JSON.parse(readFileSync(join(state, 'host/status.json'), 'utf8')).supervisor_pid;
    } catch {}
  }
  if (supervisor) {
    process.kill(supervisor, 'SIGTERM');
    await until(async () => {
      try {
        await call(socket, '/v1/health');
        return false;
      } catch {
        return true;
      }
    }, Boolean);
  }
  rmSync(root, { recursive: true, force: true });
}
