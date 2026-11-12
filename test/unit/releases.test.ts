import { test, expect } from 'vitest';
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from '../../src/core/config.js';

test('release validation rejects mismatched lock versions, missing notes and unsafe tag versions', () => {
  const dir = mkdtempSync('/tmp/sal-version-');
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts/release-check.mjs'), join(dir, 'scripts/release-check.mjs'));
    const pkg = {
      name: '@superjackfruitlabs/salaam',
      version: '0.0.1',
      dependencies: { example: '1.0.0' },
    };
    const lock = {
      version: '0.0.1',
      packages: { '': { version: '0.0.1', dependencies: pkg.dependencies } },
    };
    const save = () => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
      writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
    };
    const run = (...args: string[]) =>
      execFileSync(process.execPath, [join(dir, 'scripts/release-check.mjs'), ...args], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
    save();
    writeFileSync(join(dir, 'CHANGELOG.md'), '## v0.0.1 — 2026-10-18\n');
    expect(JSON.parse(run()).version).toBe('0.0.1');
    lock.packages[''].version = '0.0.9';
    save();
    expect(() => run()).toThrow('version mismatch');
    lock.packages[''].version = '0.0.1';
    save();
    writeFileSync(join(dir, 'CHANGELOG.md'), '## Unreleased\n\n## [0.0.1] - 2026-10-18\n');
    expect(() => run()).toThrow('CHANGELOG.md');
    writeFileSync(join(dir, 'CHANGELOG.md'), '## v0.0.1 — 2026-10-18\n');
    for (const tag of ['v0.2.0', 'v0.0.1;touch x', '0.0.1', 'v0.0.1+build'])
      expect(() => run(tag)).toThrow('exact package SemVer');
    pkg.version = '0.0.1-01';
    save();
    expect(() => run()).toThrow('exact package SemVer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer checks the exact checksum before npm and forwards a literal prefix', () => {
  const dir = mkdtempSync('/tmp/sal-installer-');
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const bytes = 'test release bytes';
    const asset = 'salaam-cli-0.0.1.tgz';
    writeFileSync(join(dir, 'latest'), JSON.stringify({ tag_name: 'v0.0.1' }));
    writeFileSync(join(dir, asset), bytes);
    writeFileSync(
      join(dir, 'SHA256SUMS'),
      `${createHash('sha256').update(bytes).digest('hex')}  ${asset}\n`,
    );
    // Fake only the download and package manager. The installer's actual Node hash
    // verifier and shell argument handling run unchanged; no external endpoint is used.
    writeFileSync(
      join(bin, 'curl'),
      '#!/usr/bin/env node\nconst fs=require("node:fs"),path=require("node:path");process.stdout.write(fs.readFileSync(path.join(process.env.SAL_TEST_FILES,path.basename(process.argv.at(-1)))));\n',
    );
    writeFileSync(
      join(bin, 'npm'),
      '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.SAL_TEST_LOG,JSON.stringify(process.argv.slice(2)));\n',
    );
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const log = join(dir, 'npm.json');
    const env = {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      SAL_TEST_FILES: dir,
      SAL_TEST_LOG: log,
    };
    const run = (...args: string[]) =>
      spawnSync('sh', ['-s', '--', ...args], {
        input: readFileSync(join(ROOT, 'install.sh')),
        encoding: 'utf8',
        env,
      });
    // No prefix: fake npm records its arguments; no executable check is requested.
    expect(run().status).toBe(0);
    expect(run('--version', '0.0.1').status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(
      expect.arrayContaining(['--ignore-scripts', '--offline', '--global']),
    );
    const prefix = join(dir, 'literal prefix $(ignored)');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'bin/salaam'), '#!/bin/sh\necho "salaam 0.0.1"\n');
    chmodSync(join(prefix, 'bin/salaam'), 0o755);
    expect(run('--version', 'v0.0.1', '--prefix', prefix).status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(
      expect.arrayContaining(['--prefix', prefix]),
    );
    rmSync(log);
    writeFileSync(join(dir, asset), 'tampered');
    const tampered = run('--version', '0.0.1');
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('checksum mismatch');
    expect(existsSync(log)).toBe(false);
    expect(run('--version', '../../unsafe').status).not.toBe(0);
    expect(existsSync(log)).toBe(false);
    expect(run('--unknown').status).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('npm publishes only the release tarball whose bytes release.json names', () => {
  const dir = mkdtempSync('/tmp/sal-npm-');
  try {
    const scripts = join(dir, 'scripts'),
      bin = join(dir, 'bin'),
      dist = join(dir, 'release-dist');
    for (const d of [scripts, bin, dist]) mkdirSync(d);
    for (const name of ['release-check.mjs', 'npm-release.mjs'])
      cpSync(join(ROOT, 'scripts', name), join(scripts, name));
    const tarball = join(dist, 'salaam-cli-0.0.1.tgz');
    writeFileSync(tarball, 'release bytes');
    const release = {
      package: '@superjackfruitlabs/salaam',
      version: '0.0.1',
      prerelease: false,
      dirty: false,
      package_sha256: createHash('sha256').update('release bytes').digest('hex'),
    };
    writeFileSync(join(dist, 'release.json'), JSON.stringify(release));
    // Fake npm: `view` answers E404 (not published yet); every call is logged.
    writeFileSync(
      join(bin, 'npm'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(process.env.SAL_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'view') { process.stderr.write('npm error code E404'); process.exit(1); }
`,
    );
    chmodSync(join(bin, 'npm'), 0o755);
    const log = join(dir, 'calls.jsonl');
    const run = () =>
      spawnSync(process.execPath, [join(scripts, 'npm-release.mjs')], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          SAL_TEST_LOG: log,
          RELEASE_DIST: dist,
        },
      });
    expect(run().status).toBe(0);
    const publish = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l): string[] => JSON.parse(l))
      .find((a) => a[0] === 'publish');
    expect(publish).toEqual(
      expect.arrayContaining([tarball, '--provenance', '--ignore-scripts', 'latest']),
    );
    writeFileSync(log, '');
    writeFileSync(tarball, 'tampered bytes');
    const tampered = run();
    expect(tampered.status).not.toBe(0);
    expect(tampered.stderr).toContain('checksum mismatch');
    expect(readFileSync(log, 'utf8')).not.toContain('publish');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
