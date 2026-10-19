import { mkdirSync, cpSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Explicit contributor/operator preparation, never imported by a model worker.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  [output, python] = process.argv.slice(2);
if (!output || !python)
  throw Error('Usage: node scripts/prepare-a2a-peers.mjs NEW_OUTPUT_DIR ABSOLUTE_PYTHON_3_14');
if (process.version !== 'v26.7.0') throw Error('Use the pinned Node runtime');
const target = resolve(output),
  py = resolve(python),
  metadata = join(root, 'a2a-runtime'),
  pins = JSON.parse(readFileSync(join(metadata, 'pins.json'), 'utf8'));
if (existsSync(target)) throw Error('Select a new runtime directory');
const version = execFileSync(py, ['--version'], { encoding: 'utf8' }).trim();
if (!/^Python 3\.14\./.test(version)) throw Error('Select Python 3.14');
mkdirSync(target, { mode: 0o700, recursive: true });
const home = join(target, 'preparation-home'),
  node = join(target, 'node'),
  plugin = join(target, 'openclaw-plugin'),
  source = join(target, 'openclaw-source'),
  hermes = join(target, 'hermes'),
  venv = join(target, 'hermes-venv');
for (const path of [home, node, plugin, source, hermes]) mkdirSync(path, { mode: 0o700 });
const env = {
  HOME: home,
  PATH: process.env.PATH,
  LANG: 'en_US.UTF-8',
  npm_config_userconfig: join(home, 'user.npmrc'),
  npm_config_globalconfig: join(home, 'global.npmrc'),
  npm_config_cache: join(home, 'npm-cache'),
  PIP_CONFIG_FILE: '/dev/null',
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
};
writeFileSync(join(home, 'user.npmrc'), '');
writeFileSync(join(home, 'global.npmrc'), '');
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: target,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
cpSync(join(metadata, 'node/package.json'), join(node, 'package.json'));
cpSync(join(metadata, 'node/package-lock.json'), join(node, 'package-lock.json'));
run('npm', [
  'ci',
  '--prefix',
  node,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--registry=https://registry.npmjs.org/',
]);
for (const entry of pins.openclaw.sources) {
  const response = await fetch(
    `https://raw.githubusercontent.com/openclaw/openclaw/${pins.openclaw.commit}/${entry.path}`,
    { redirect: 'error', signal: AbortSignal.timeout(30000) },
  );
  if (!response.ok) throw Error(`Pinned OpenClaw source unavailable (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 131072) throw Error('Pinned plugin source exceeds bound');
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (blob !== entry.git_blob) throw Error('Pinned Git blob changed');
  writeFileSync(join(source, entry.path.split('/').at(-1)), bytes);
}
writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module' }));
symlinkSync(join(node, 'node_modules'), join(source, 'node_modules'));
writeFileSync(join(plugin, 'package.json'), JSON.stringify({ type: 'module' }));
symlinkSync(join(node, 'node_modules'), join(plugin, 'node_modules'));
// The upstream npm artifact omits several declarations. This emits its unchanged
// pinned TypeScript for the real transport rehearsal; it is not an upstream typecheck.
run(join(root, 'node_modules/.bin/tsc'), [
  '--ignoreConfig',
  '--noCheck',
  '--target',
  'ES2023',
  '--module',
  'NodeNext',
  '--moduleResolution',
  'NodeNext',
  '--outDir',
  plugin,
  ...['http.ts', 'task-store.ts', 'outbound.ts'].map((name) => join(source, name)),
]);
const archive = join(target, 'hermes.tgz'),
  response = await fetch(pins.hermes.archive, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60000),
  });
if (!response.ok) throw Error(`Pinned Hermes source unavailable (HTTP ${response.status})`);
const bytes = Buffer.from(await response.arrayBuffer());
if (
  bytes.length > 128 * 1024 * 1024 ||
  createHash('sha256').update(bytes).digest('hex') !== pins.hermes.archive_sha256
)
  throw Error('Pinned Hermes archive changed');
writeFileSync(archive, bytes);
run(py, [
  '-c',
  `import sys,tarfile
with tarfile.open(sys.argv[1]) as tar:
 members=tar.getmembers();prefix=members[0].name.split('/')[0]+'/'
 for member in members:
  if member.name==prefix[:-1]:continue
  if not member.name.startswith(prefix):raise RuntimeError('Unexpected archive root')
  member.name=member.name[len(prefix):]
  if member.name:tar.extract(member,sys.argv[2],filter='data')`,
  archive,
  hermes,
]);
run(py, ['-m', 'venv', venv]);
const installedPython = join(venv, 'bin/python');
run(installedPython, [
  '-m',
  'pip',
  'install',
  '--require-hashes',
  '--only-binary=:all:',
  '--index-url',
  'https://pypi.org/simple',
  '-r',
  join(metadata, 'hermes-requirements.txt'),
]);
const manifest = {
  schema: 1,
  pins,
  node: process.version,
  python: version,
  compiler: JSON.parse(readFileSync(join(root, 'node_modules/typescript/package.json'), 'utf8'))
    .version,
  scope: 'prepared exact peer transports; no model, execution or interoperability claim',
  openclaw_root: plugin,
  hermes_root: hermes,
  hermes_python: installedPython,
};
writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
