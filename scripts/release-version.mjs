import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { semver, root } from './release-check.mjs';

const version = process.argv[2];
if (!version || !semver.test(version))
  throw new Error('Usage: npm run release:version -- X.Y.Z[-prerelease]');
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  throw new Error('Commit or stash existing work before preparing a version.');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
// semver is already in the pinned production dependency tree.
const { default: semverLib } = await import('semver');
if (!semverLib.gt(version, pkg.version))
  throw new Error('New version must be greater than the current version.');
execFileSync('npm', ['version', version, '--no-git-tag-version', '--ignore-scripts'], {
  cwd: root,
  stdio: 'inherit',
});
const file = new URL('../CHANGELOG.md', import.meta.url);
const notes = readFileSync(file, 'utf8');
writeFileSync(
  file,
  notes.replace(
    '## [Unreleased]',
    `## [Unreleased]\n\n## [${version}] - ${new Date().toISOString().slice(0, 10)}`,
  ),
);
console.log(
  `Review CHANGELOG.md, commit and merge the version change, then push an annotated v${version} tag from main. No commit, tag or publication was created.`,
);
