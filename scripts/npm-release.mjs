import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './release-check.mjs';
const directory = join(root, '.state/release');
const release = JSON.parse(readFileSync(join(directory, 'release.json')));
if (release.dirty !== false)
  throw new Error('Refusing to publish an artifact from uncommitted source.');
const tarball = join(directory, `salaam-cli-${release.version}.tgz`);
if (createHash('sha256').update(readFileSync(tarball)).digest('hex') !== release.package_sha256)
  throw new Error('Release tarball checksum mismatch.');
const sha512 = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
const existing = spawnSync(
  'npm',
  ['view', `${release.package}@${release.version}`, 'dist.integrity', '--json'],
  { encoding: 'utf8' },
);
if (existing.status === 0) {
  if (JSON.parse(existing.stdout) !== sha512)
    throw new Error('npm version already exists with different bytes.');
  console.log('npm already contains the identical verified tarball.');
} else {
  if (!existing.stderr.includes('E404'))
    throw new Error('Unable to establish npm version absence: ' + existing.stderr);
  execFileSync(
    'npm',
    [
      'publish',
      tarball,
      '--access',
      'public',
      '--ignore-scripts',
      '--provenance',
      '--tag',
      release.prerelease ? 'next' : 'latest',
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
