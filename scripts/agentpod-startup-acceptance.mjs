import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ROOT } from '../dist/src/config.js';

// Provision this existing pinned image outside model execution. No pull/install happens here.
const image =
  'docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32';
const exec = promisify(execFile);
const contextAt = process.argv.indexOf('--docker-context');
const prefix = contextAt < 0 ? [] : ['--context', process.argv[contextAt + 1]];
const name = 'salaam-startup-' + randomUUID().slice(0, 8);
const mount = [
  'src',
  'dist/src',
  'bin',
  'node_modules',
  'pi-pin.json',
  'package.json',
  'package-lock.json',
  'test/fixtures/agentpod-linux-host.mjs',
].flatMap((p) => ['--mount', `type=bind,src=${join(ROOT, p)},dst=/opt/salaam/${p},readonly`]);
try {
  const { stdout } = await exec(
    'docker',
    [
      ...prefix,
      'run',
      '--rm',
      '--name',
      name,
      '--label',
      'dev.salaam.proof=agentpod-startup-v1',
      '--network',
      'none',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '1g',
      '--pids-limit',
      '128',
      ...mount,
      '--env',
      'PATH=/usr/bin:/bin',
      '--entrypoint',
      '/bin/sh',
      image,
      '-c',
      'mkdir /private-runtime && mv /usr/local/bin/node /private-runtime/node && exec /private-runtime/node /opt/salaam/test/fixtures/agentpod-linux-host.mjs',
    ],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout.trim());
  assert.equal(result.success, true);
  const report = {
    ...result,
    image,
    recorded_at: new Date().toISOString(),
    scope:
      'Isolated Linux container, pinned Pi offline provider, no network or Docker socket, selected source/runtime mounts only',
  };
  const dir = join(ROOT, '.state/evidence/m19');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'linux-startup.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  // Only this randomly named proof resource; never prune user images, volumes or containers.
  await exec('docker', [...prefix, 'rm', '-fv', name], { timeout: 10000 }).catch(() => {});
}
