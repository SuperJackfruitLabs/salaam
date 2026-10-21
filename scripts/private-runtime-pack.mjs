// Build only from an explicitly reviewed release tarball and the pinned Node archive.
// GNU tar is required to normalize archive metadata; no checkout/state is copied.
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  chmodSync,
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inventory, hash } from './runtime/inventory.mjs';

const [nodeArchive, packageArchive, packageSha, destination] = process.argv.slice(2);
if (!destination || !/^[a-f0-9]{64}$/.test(packageSha ?? ''))
  throw Error(
    'Usage: node scripts/private-runtime-pack.mjs NODE.tar.xz PACKAGE.tgz REVIEWED_PACKAGE_SHA256 OUTPUT.tar.gz',
  );
const pin = JSON.parse(readFileSync(new URL('./runtime-pin.json', import.meta.url)));
if (
  hash(readFileSync(nodeArchive)) !== pin.node.sha256 ||
  hash(readFileSync(packageArchive)) !== packageSha
)
  throw Error('Input checksum mismatch');
if (`${process.platform}-${process.arch}` !== pin.platform)
  throw Error('Build on pinned target platform');
const stage = mkdtempSync(join(tmpdir(), 'sal-private-'));
const buildHome = mkdtempSync(join(tmpdir(), 'sal-private-home-'));
process.umask(0o022);
try {
  writeFileSync(join(buildHome, 'user.npmrc'), '');
  writeFileSync(join(buildHome, 'global.npmrc'), '');
  for (const name of ['node', 'app', 'bin', 'tools']) mkdirSync(join(stage, name));
  execFileSync('tar', [
    '-xJf',
    resolve(nodeArchive),
    '--strip-components=1',
    '-C',
    join(stage, 'node'),
  ]);
  const node = join(stage, 'node/bin/node');
  const npm = join(stage, 'node/lib/node_modules/npm/bin/npm-cli.js');
  if (
    execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() !== `v${pin.node.version}` ||
    execFileSync(node, [npm, '--version'], { encoding: 'utf8' }).trim() !== pin.npm
  )
    throw Error('Node/npm pin mismatch');
  execFileSync(
    node,
    [
      npm,
      'install',
      '--prefix',
      join(stage, 'app'),
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      resolve(packageArchive),
    ],
    {
      env: {
        PATH: `${join(stage, 'node/bin')}:/usr/bin:/bin`,
        HOME: buildHome,
        npm_config_cache: join(buildHome, 'cache'),
        npm_config_userconfig: join(buildHome, 'user.npmrc'),
        npm_config_globalconfig: join(buildHome, 'global.npmrc'),
      },
      stdio: ['ignore', 2, 2],
    },
  );
  // npm's installer metadata contains the absolute input tarball path. It is not runtime payload.
  for (const name of ['package.json', 'package-lock.json', 'node_modules/.package-lock.json'])
    rmSync(join(stage, 'app', name), { force: true });
  const pkg = JSON.parse(
    readFileSync(join(stage, 'app/node_modules/@superjackfruitlabs/salaam/package.json')),
  );
  if (pkg.engines.node !== pin.node.version) throw Error('Package Node pin mismatch');
  if (pkg.packageManager !== `npm@${pin.npm}`) throw Error('Package npm pin mismatch');
  const storeSource = readFileSync(
    join(stage, 'app/node_modules/@superjackfruitlabs/salaam/src/store.ts'),
    'utf8',
  );
  const schemaMaximum = Number(/if \(version > (\d+)\)/.exec(storeSource)?.[1]);
  if (schemaMaximum !== pin.state_schema.max)
    throw Error('Runtime state-schema pin disagrees with packaged Store');
  for (const name of ['inventory.mjs', 'activate.mjs'])
    cpSync(new URL(`./runtime/${name}`, import.meta.url), join(stage, 'tools', name));
  cpSync(new URL('./runtime/launch.sh', import.meta.url), join(stage, 'bin/salaam'));
  chmodSync(join(stage, 'bin/salaam'), 0o755);
  cpSync(join(stage, 'bin/salaam'), join(stage, 'bin/sal'));
  // Pack regular files only. The shell bootstrap can then reject every archive
  // link before extraction without executing any unverified bundled code.
  function materialize(directory) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (lstatSync(path).isSymbolicLink()) {
        const target = realpathSync(path);
        if (!target.startsWith(`${stage}/`) || !lstatSync(target).isFile())
          throw Error(`Unsupported runtime link: ${path}`);
        const bytes = readFileSync(target),
          mode = lstatSync(target).mode & 0o777;
        unlinkSync(path);
        writeFileSync(path, bytes, { mode });
      } else if (lstatSync(path).isDirectory()) materialize(path);
    }
  }
  materialize(stage);
  const manifest = {
    schema: 1,
    platform: pin.platform,
    version: pkg.version,
    node: pin.node.version,
    npm: pin.npm,
    state_schema: pin.state_schema,
    package_sha256: packageSha,
    node_archive_sha256: pin.node.sha256,
    files: inventory(stage),
  };
  writeFileSync(join(stage, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
  execFileSync('tar', [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--hard-dereference',
    '-czf',
    resolve(destination),
    '-C',
    stage,
    '.',
  ]);
  console.log(
    JSON.stringify({
      archive: resolve(destination),
      sha256: hash(readFileSync(destination)),
      manifest_sha256: hash(readFileSync(join(stage, 'runtime.json'))),
      version: pkg.version,
    }),
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(buildHome, { recursive: true, force: true });
}
