import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkRelease, root } from './release-check.mjs';

const release = checkRelease();
const output = resolve(process.argv[2] ?? join(root, '.state/release'));
const stage = mkdtempSync(join(tmpdir(), 'sal-pack-'));
mkdirSync(output, { recursive: true });
try {
  for (const file of [
    'package.json',
    'package-lock.json',
    'bin',
    'src',
    'dist/src',
    'pi-pin.json',
    'harness-runtime',
    'LICENSE',
    'README.md',
    'CHANGELOG.md',
  ])
    cpSync(join(root, file), join(stage, file), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(stage, 'package.json')));
  // Published packages have no lifecycle hooks and require no compiler or checkout.
  delete pkg.scripts;
  delete pkg.devDependencies;
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stage,
    stdio: 'inherit',
  });
  // Keep the exact reviewed lock bytes, including Pi's artifact integrity.
  cpSync(join(root, 'package-lock.json'), join(stage, 'npm-shrinkwrap.json'));
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], {
      cwd: stage,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  )[0];
  const name = `salaam-cli-${release.version}.tgz`;
  renameSync(join(output, packed.filename), join(output, name));
  cpSync(join(root, 'install.sh'), join(output, 'install.sh'));
  const sha256 = (name) =>
    createHash('sha256')
      .update(readFileSync(join(output, name)))
      .digest('hex');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = Boolean(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  );
  writeFileSync(
    join(output, 'release.json'),
    JSON.stringify(
      {
        schema: 1,
        ...release,
        package: pkg.name,
        commit,
        dirty,
        node: pkg.engines.node,
        npm: pkg.packageManager,
        package_sha256: sha256(name),
        platforms: ['darwin', 'linux'],
        pin: JSON.parse(readFileSync(join(root, 'pi-pin.json'))),
      },
      null,
      2,
    ) + '\n',
  );
  writeFileSync(
    join(output, 'SHA256SUMS'),
    [name, 'install.sh', 'release.json'].map((name) => `${sha256(name)}  ${name}\n`).join(''),
  );
  console.log(
    JSON.stringify(
      {
        tarball: join(output, name),
        bytes: packed.size,
        files: packed.entryCount,
        bundled: packed.bundled.length,
        ...release,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
