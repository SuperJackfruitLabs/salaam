import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
export function checkRelease(tag) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)));
  if (!semver.test(pkg.version) || (tag && tag !== `v${pkg.version}`))
    throw new Error(
      'Release tag must be v followed by the exact package SemVer (no build metadata).',
    );
  if (pkg.private || lock.version !== pkg.version || lock.packages[''].version !== pkg.version)
    throw new Error('Publishability or package/lockfile version mismatch.');
  if (JSON.stringify(pkg.dependencies) !== JSON.stringify(lock.packages[''].dependencies))
    throw new Error('Production dependencies differ from the reviewed lockfile.');
  const notes = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  if (!notes.includes(`## [${pkg.version}] - `))
    throw new Error('Add a dated CHANGELOG.md entry for this version.');
  if (tag) {
    // An arbitrary tag cannot bypass the reviewed main branch.
    execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], { cwd: root });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const tagged = execFileSync('git', ['rev-parse', `refs/tags/${tag}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    if (head !== tagged) throw new Error('Checkout is not the requested tag.');
  }
  return { version: pkg.version, tag: `v${pkg.version}`, prerelease: pkg.version.includes('-') };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(checkRelease(process.argv[2]), null, 2));
