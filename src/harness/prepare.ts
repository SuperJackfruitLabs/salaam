import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
  renameSync,
  rmSync,
  createWriteStream,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT } from '../core/index.js';
import { harnessRuntimeDigest, assertHarnessArtifactRoot } from './backend.js';

/** Explicit operator setup, outside all worker turns. Fixed lock, no lifecycle scripts or inherited credentials. */
export async function prepareHarnessRuntime(
  destination: string,
  arch: string,
): Promise<{ root: string; digest: string; arch: string }> {
  if (!['linux-arm64', 'linux-x64'].includes(arch))
    throw Error('Select --arch linux-arm64 or linux-x64 for the Docker execution host');
  const output = resolve(destination);
  if (existsSync(output))
    throw Error('Runtime destination already exists; choose a new directory for renewed admission');
  const parent = realpathSync(dirname(output)),
    temp = mkdtempSync(join(parent, '.salaam-runtime-')),
    bundle = join(temp, 'bundle');
  const exec = promisify(execFile),
    home = join(temp, 'home');
  try {
    for (const p of [bundle, home]) mkdirSync(p, { mode: 0o700 });
    for (const file of ['package.json', 'package-lock.json'])
      writeFileSync(join(bundle, file), readFileSync(join(ROOT, 'harness-runtime', file)), {
        mode: 0o600,
      });
    for (const name of ['user.npmrc', 'global.npmrc'])
      writeFileSync(join(temp, name), '', { mode: 0o600 });
    const env = {
      HOME: home,
      PATH: dirname(process.execPath) + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
      NPM_CONFIG_USERCONFIG: join(temp, 'user.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(temp, 'global.npmrc'),
      NPM_CONFIG_CACHE: join(temp, 'cache'),
    };
    await exec(
      'npm',
      [
        'ci',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--registry=https://registry.npmjs.org',
      ],
      { cwd: bundle, env, timeout: 300000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pin = JSON.parse(readFileSync(join(ROOT, 'harness-runtime/codex-pins.json'), 'utf8'))[
      arch
    ] as { url: string; integrity: string };
    const response = await fetch(pin.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok || !response.body) throw Error('Pinned Codex archive download failed');
    const archive = join(temp, 'codex.tgz'),
      hash = createHash('sha512');
    let size = 0;
    await pipeline(
      Readable.fromWeb(response.body as any),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > 1024 * 1024 * 1024) return done(Error('Harness archive exceeds bound'));
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
    );
    if (hash.digest('base64') !== pin.integrity)
      throw Error('Pinned Codex archive integrity mismatch');
    const listing = await exec('tar', ['-tzf', archive], {
      env,
      timeout: 30000,
      maxBuffer: 1048576,
    });
    if (
      listing.stdout
        .split('\n')
        .filter(Boolean)
        .some((path) => !path.startsWith('package/') || path.split('/').includes('..'))
    )
      throw Error('Unsafe pinned archive layout');
    mkdirSync(join(bundle, 'codex'), { mode: 0o700 });
    await exec('tar', ['-xzf', archive, '--strip-components=1', '-C', join(bundle, 'codex')], {
      env,
      timeout: 120000,
      maxBuffer: 1048576,
    });
    assertHarnessArtifactRoot(bundle);
    const hashValue = await harnessRuntimeDigest(bundle);
    if (existsSync(output)) throw Error('Runtime destination appeared during setup');
    renameSync(bundle, output);
    return { root: output, digest: hashValue, arch };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
