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
import { ROOT } from '../../src/config.js';

test('release validation rejects mismatched lock versions, missing notes and unsafe tag versions', () => {
  const dir = mkdtempSync('/tmp/sal-version-');
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(join(ROOT, 'scripts/release-check.mjs'), join(dir, 'scripts/release-check.mjs'));
    const pkg = { name: '@sjl/salaam', version: '0.1.0', dependencies: { example: '1.0.0' } };
    const lock = {
      version: '0.1.0',
      packages: { '': { version: '0.1.0', dependencies: pkg.dependencies } },
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
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [0.1.0] - 2026-10-18\n');
    expect(JSON.parse(run()).version).toBe('0.1.0');
    lock.packages[''].version = '0.0.9';
    save();
    expect(() => run()).toThrow('version mismatch');
    lock.packages[''].version = '0.1.0';
    save();
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [Unreleased]\n');
    expect(() => run()).toThrow('CHANGELOG.md');
    writeFileSync(join(dir, 'CHANGELOG.md'), '## [0.1.0] - 2026-10-18\n');
    for (const tag of ['v0.2.0', 'v0.1.0;touch x', '0.1.0', 'v0.1.0+build'])
      expect(() => run(tag)).toThrow('exact package SemVer');
    pkg.version = '0.1.0-01';
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
    const asset = 'salaam-cli-0.1.0.tgz';
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
      spawnSync('sh', [join(ROOT, 'install.sh'), ...args], { encoding: 'utf8', env });
    // No prefix: fake npm records its arguments; no executable check is requested.
    expect(run('--version', '0.1.0').status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(
      expect.arrayContaining(['--ignore-scripts', '--offline', '--global']),
    );
    const prefix = join(dir, 'literal prefix $(ignored)');
    mkdirSync(join(prefix, 'bin'), { recursive: true });
    writeFileSync(join(prefix, 'bin/salaam'), '#!/bin/sh\necho "salaam 0.1.0"\n');
    chmodSync(join(prefix, 'bin/salaam'), 0o755);
    expect(run('--version', 'v0.1.0', '--prefix', prefix).status).toBe(0);
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual(
      expect.arrayContaining(['--prefix', prefix]),
    );
    rmSync(log);
    writeFileSync(join(dir, asset), 'tampered');
    const tampered = run('--version', '0.1.0');
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

test('a partial release upload never publishes a draft or overwrites published assets', () => {
  const dir = mkdtempSync('/tmp/sal-publisher-');
  try {
    const scripts = join(dir, 'scripts'),
      bin = join(dir, 'bin'),
      assets = join(dir, '.state/release');
    mkdirSync(scripts);
    mkdirSync(bin);
    mkdirSync(assets, { recursive: true });
    for (const name of ['release-check.mjs', 'github-release.mjs'])
      cpSync(join(ROOT, 'scripts', name), join(scripts, name));
    const release = {
      version: '0.1.0',
      tag: 'v0.1.0',
      commit: 'a'.repeat(40),
      prerelease: false,
      dirty: false,
    };
    writeFileSync(join(assets, 'release.json'), JSON.stringify(release));
    const stub = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SAL_TEST_LOG, JSON.stringify(args)+'\\n');
if(args[0]==='api') console.log('a'.repeat(40));
else if(args[1]==='view') {
  if(process.env.SAL_TEST_PUBLISHED) console.log(JSON.stringify({isDraft:false})); else process.exit(1);
} else if(args[1]==='upload') process.exit(5);
else if(args[1]==='download') {
  const dest = args[args.indexOf('--dir')+1];
  for(const name of ['salaam-cli-0.1.0.tgz','SHA256SUMS','release.json','install.sh']) fs.writeFileSync(path.join(dest,name),'different published bytes');
}
`;
    writeFileSync(join(bin, 'gh'), stub);
    chmodSync(join(bin, 'gh'), 0o755);
    const log = join(dir, 'calls.jsonl');
    const env = { ...process.env, PATH: bin + ':' + process.env.PATH, SAL_TEST_LOG: log };
    const run = (extra = {}) =>
      spawnSync(process.execPath, [join(scripts, 'github-release.mjs')], {
        encoding: 'utf8',
        env: { ...env, ...extra },
      });
    expect(run().status).not.toBe(0);
    let calls = readFileSync(log, 'utf8');
    expect(calls).toContain('upload');
    expect(calls).not.toContain('edit');
    writeFileSync(log, '');
    for (const name of ['salaam-cli-0.1.0.tgz', 'SHA256SUMS', 'install.sh'])
      writeFileSync(join(assets, name), 'local verified bytes');
    expect(run({ SAL_TEST_PUBLISHED: 'true' }).stderr).toContain('refusing to replace');
    calls = readFileSync(log, 'utf8');
    expect(calls).toContain('download');
    expect(calls).not.toContain('upload');
    expect(calls).not.toContain('edit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
