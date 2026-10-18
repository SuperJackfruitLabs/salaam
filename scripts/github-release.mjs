import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { root } from './release-check.mjs';

const directory = join(root, '.state/release');
const release = JSON.parse(readFileSync(join(directory, 'release.json')));
if (release.dirty !== false)
  throw new Error('Refusing to publish an artifact from uncommitted source.');
const gh = (args) => execFileSync('gh', args, { cwd: root, encoding: 'utf8' });
const tagged = gh(['api', `repos/{owner}/{repo}/commits/${release.tag}`, '--jq', '.sha']).trim();
if (tagged !== release.commit) throw new Error('Package commit does not match the remote tag.');
const assets = [`salaam-cli-${release.version}.tgz`, 'SHA256SUMS', 'release.json', 'install.sh'];
let existing;
try {
  existing = JSON.parse(gh(['release', 'view', release.tag, '--json', 'isDraft,assets']));
} catch {
  /* create below; API/network failure cannot create a duplicate tag release */
}
if (existing && !existing.isDraft) {
  const temp = mkdtempSync(join(tmpdir(), 'sal-release-compare-'));
  try {
    gh(['release', 'download', release.tag, '--dir', temp]);
    for (const name of assets) {
      const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
      if (sha(join(temp, name)) !== sha(join(directory, name)))
        throw new Error('Published release differs; refusing to replace immutable asset: ' + name);
    }
    console.log('Published release already contains the exact verified assets.');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
} else {
  if (!existing)
    gh([
      'release',
      'create',
      release.tag,
      '--verify-tag',
      '--draft',
      '--title',
      `Salaam ${release.version}`,
      '--generate-notes',
      ...(release.prerelease ? ['--prerelease'] : []),
    ]);
  gh([
    'release',
    'upload',
    release.tag,
    ...assets.map((name) => join(directory, name)),
    '--clobber',
  ]);
  gh([
    'release',
    'edit',
    release.tag,
    '--draft=false',
    ...(release.prerelease ? ['--prerelease'] : ['--latest']),
  ]);
  console.log('Published complete GitHub Release: ' + release.tag);
}
