import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  readlinkSync,
  cpSync,
  rmSync,
  symlinkSync,
  existsSync,
  readFileSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { inventory, verify, hash } from './inventory.mjs';
import { validatePrivateRuntimeReceipt, privateRuntimeImage } from './receipt.mjs';
import { verifyReproducibleBuilds } from './reproducibility.mjs';

test('private activation gates schema, preserves pointers on rejection, and permits restored-state rollback', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sal-runtime-test-')));
  let ownerChild;
  try {
    const prefix = join(dir, 'installed'),
      bundle = join(dir, 'bundle'),
      dbPath = join(dir, 'state', 'journal.sqlite');
    mkdirSync(join(dir, 'state'), { mode: 0o700 });
    const owner = new DatabaseSync(join(dir, 'state', 'owner.sqlite'));
    owner.exec('CREATE TABLE owner (id INTEGER)');
    owner.close();
    chmodSync(join(dir, 'state', 'owner.sqlite'), 0o600);
    mkdirSync(join(bundle, 'bin'), { recursive: true });
    writeFileSync(join(bundle, 'bin/salaam'), '#!/bin/sh\nprintf private-runtime\n', {
      mode: 0o755,
    });
    const manifest = {
      schema: 1,
      platform: `${process.platform}-${process.arch}`,
      node: process.versions.node,
      version: 'fixture',
      state_schema: { min: 0, max: 31 },
      files: inventory(bundle),
    };
    const save = () => writeFileSync(join(bundle, 'runtime.json'), JSON.stringify(manifest));
    save();
    const activate = (...args) =>
      execFileSync(
        process.execPath,
        [new URL('./activate.mjs', import.meta.url).pathname, bundle, prefix, ...args],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    activate();
    const first = readlinkSync(join(prefix, 'current'));
    symlinkSync(join(dir, 'state'), join(dir, 'state-alias'));
    assert.throws(
      () => activate(join(dir, 'state-alias/journal.sqlite'), '--stopped'),
      /canonical/,
    );
    assert.equal(
      execFileSync(join(prefix, 'bin/salaam'), {
        encoding: 'utf8',
        env: { HOME: dir, PATH: '/usr/bin:/bin' },
      }),
      'private-runtime',
    );
    assert.throws(() => activate(), /requires a stopped service/);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version=32');
    assert.throws(() => activate(dbPath, '--stopped'), /schema 32 is incompatible/);
    assert.equal(readlinkSync(join(prefix, 'current')), first);
    db.exec('PRAGMA user_version=31');
    manifest.version = 'fixture-upgrade';
    save();
    // A real child holds the exact owner.sqlite transaction used by the service.
    const holdLock = async (path) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;');
      console.log('locked'); setInterval(() => {}, 1000);
    `,
          path,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      await once(child.stdout, 'data');
      return child;
    };
    ownerChild = await holdLock(join(dir, 'state', 'owner.sqlite'));
    assert.throws(() => activate(dbPath, '--stopped'), /Another Salaam process owns/);
    assert.equal(readlinkSync(join(prefix, 'current')), first);
    const dead = once(ownerChild, 'exit');
    ownerChild.kill('SIGKILL');
    await dead;
    ownerChild = undefined;
    ownerChild = await holdLock(join(prefix, '.install-owner.sqlite'));
    assert.throws(() => activate(dbPath, '--stopped'), /Another Salaam process owns/);
    assert.equal(readlinkSync(join(prefix, 'current')), first);
    const installDead = once(ownerChild, 'exit');
    ownerChild.kill('SIGKILL');
    await installDead;
    ownerChild = undefined;
    // Host supervisor and startup ownership deny replacement even with a free daemon lock.
    for (const name of ['host', 'startup']) {
      ownerChild = await holdLock(join(dir, 'state', name, 'owner.sqlite'));
      assert.throws(() => activate(dbPath, '--stopped'), /Another Salaam process owns/);
      assert.equal(readlinkSync(join(prefix, 'current')), first);
      const hostDead = once(ownerChild, 'exit');
      ownerChild.kill('SIGKILL');
      await hostDead;
      ownerChild = undefined;
    }
    // Unknown symlink lock directories must be preserved and rejected.
    const hostDir = join(dir, 'state', 'host');
    const heldHostDir = join(dir, 'held-host');
    renameSync(hostDir, heldHostDir);
    symlinkSync(heldHostDir, hostDir);
    assert.throws(() => activate(dbPath, '--stopped'), /canonical, private/);
    assert.equal(readlinkSync(hostDir), heldHostDir);
    unlinkSync(hostDir);
    renameSync(heldHostDir, hostDir);
    // Old crash artifacts are not lock authority and must not block or be deleted.
    mkdirSync(join(prefix, '.install-lock'));
    symlinkSync('unknown-owned-resource', join(prefix, 'current.next'));
    activate(dbPath, '--stopped');
    assert.equal(readlinkSync(join(prefix, 'current.next')), 'unknown-owned-resource');
    assert.notEqual(readlinkSync(join(prefix, 'current')), first);
    manifest.version = 'fixture';
    save();
    activate(dbPath, '--stopped');
    assert.equal(readlinkSync(join(prefix, 'current')), first);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 31);
    db.close();
    writeFileSync(join(bundle, 'bin/salaam'), 'tampered');
    assert.throws(() => verify(bundle), /mismatch/);
    symlinkSync('/etc/passwd', join(bundle, 'escape'));
    assert.throws(() => inventory(bundle), /Escaping symlink/);
  } finally {
    ownerChild?.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service launcher chooses private executable with no inherited credentials or Node options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-launch-test-'));
  try {
    mkdirSync(join(dir, 'bin'));
    mkdirSync(join(dir, 'node/bin'), { recursive: true });
    cpSync(new URL('./launch.sh', import.meta.url), join(dir, 'bin/salaam'));
    writeFileSync(
      join(dir, 'node/bin/node'),
      '#!/bin/sh\n/usr/bin/env\nprintf "arg=%s\\n" "$@"\n',
      { mode: 0o755 },
    );
    const result = execFileSync(
      '/bin/sh',
      [join(dir, 'bin/salaam'), 'host', 'start', '/explicit/manifest.json'],
      {
        encoding: 'utf8',
        env: {
          HOME: dir,
          PATH: '/missing',
          NODE_OPTIONS: '--invalid',
          PROVIDER_API_KEY: 'must-not-leak',
          SALAAM_TOKEN: 'must-not-leak',
        },
      },
    );
    assert.ok(result.includes(`PATH=${realpathSync(dir)}/node/bin:/usr/bin:/bin`));
    assert.ok(result.includes('arg=/explicit/manifest.json'));
    assert.ok(!result.includes('must-not-leak'));
    assert.ok(!result.includes('NODE_OPTIONS'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer rejects mismatched private archive before executing any runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-install-test-'));
  try {
    const archive = join(dir, 'bundle.tgz');
    writeFileSync(archive, 'not executable');
    const result = spawnSync(
      '/bin/sh',
      [
        new URL('../../install.sh', import.meta.url).pathname,
        '--private-runtime',
        archive,
        '--prefix',
        join(dir, 'install'),
        '--sha256',
        '0'.repeat(64),
      ],
      { encoding: 'utf8', env: { HOME: dir, PATH: '/usr/bin:/bin' } },
    );
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('Private runtime checksum mismatch'));
    assert.ok(!result.stderr.includes('Install Node'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installer rejects traversing paths and archive links even with a matching reviewed hash', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sal-unsafe-archive-')));
  try {
    for (const [name, type, link] of [
      ['../../escape', '0', ''],
      [join(dir, 'escape'), '0', ''],
      ['node', '2', '/tmp'],
      ['node', '1', '../../escape'],
    ]) {
      const header = Buffer.alloc(512);
      const field = (value, start, length) => header.write(value, start, length, 'utf8');
      field(name, 0, 100);
      field('0000644\0', 100, 8);
      field('0000000\0', 108, 8);
      field('0000000\0', 116, 8);
      field('00000000000\0', 124, 12);
      field('00000000000\0', 136, 12);
      header.fill(32, 148, 156);
      field(type, 156, 1);
      field(link, 157, 100);
      field('ustar\0', 257, 6);
      field('00', 263, 2);
      const sum = header.reduce((total, value) => total + value, 0);
      field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      const bytes = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
      const archive = join(dir, 'unsafe.tgz');
      writeFileSync(archive, bytes);
      const result = spawnSync(
        '/bin/sh',
        [
          new URL('../../install.sh', import.meta.url).pathname,
          '--private-runtime',
          archive,
          '--sha256',
          hash(bytes),
          '--prefix',
          join(dir, 'install'),
        ],
        { encoding: 'utf8', env: { HOME: dir, TMPDIR: dir, PATH: '/usr/bin:/bin' } },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsafe archive/);
      assert.equal(existsSync(join(dir, 'escape')), false);
      assert.equal(existsSync(join(dir, 'install')), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI private runtime receipt binds run, package and pinned image and denies incomplete proofs', () => {
  const expected = { commit: 'reviewed-commit', run_id: '123', run_attempt: 2, version: 'fixture' };
  const receipt = {
    schema: 1,
    kind: 'salaam-private-runtime-container-proof',
    success: true,
    commit: expected.commit,
    workflow_run_id: '123',
    workflow_run_attempt: 2,
    version: 'fixture',
    package_sha256: 'a'.repeat(64),
    archive_sha256: 'b'.repeat(64),
    manifest_sha256: 'c'.repeat(64),
    reproducible_two_builds: true,
    rebuild_archive_sha256: 'b'.repeat(64),
    rebuild_manifest_sha256: 'c'.repeat(64),
    image: privateRuntimeImage,
    platform: 'linux',
    arch: 'x64',
    network: 'none',
    source_checkout_required: false,
    deployed_fleet: false,
    system_node_absent: true,
    installed_offline: true,
    absolute_private_node: true,
    concurrent_starts_single_owner: true,
    pinned_pi_readiness: true,
    offline_turn: true,
    reconnect_preserves_attempt: true,
  };
  assert.equal(validatePrivateRuntimeReceipt(receipt, expected, 'a'.repeat(64)), receipt);
  for (const patch of [
    { workflow_run_id: 'other-run' },
    { workflow_run_attempt: 3 },
    { package_sha256: 'd'.repeat(64) },
    { image: 'node:latest' },
    { concurrent_starts_single_owner: false },
    { reconnect_preserves_attempt: undefined },
    { deployed_fleet: true },
    { network: 'bridge' },
    { reproducible_two_builds: undefined },
    { rebuild_archive_sha256: 'd'.repeat(64) },
    { rebuild_manifest_sha256: 'd'.repeat(64) },
  ])
    assert.throws(
      () => validatePrivateRuntimeReceipt({ ...receipt, ...patch }, expected, 'a'.repeat(64)),
      /private runtime container proof/,
    );
});

test('two-build verifier compares actual bytes and manifest identity before accepting reproducibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-reproducible-builds-'));
  try {
    const firstArchive = join(dir, 'first.tgz'),
      secondArchive = join(dir, 'second.tgz');
    const bytes = Buffer.from('normalized fixture packet');
    writeFileSync(firstArchive, bytes);
    writeFileSync(secondArchive, bytes);
    const first = { version: 'fixture', sha256: hash(bytes), manifest_sha256: 'a'.repeat(64) };
    const second = { ...first };
    const verified = verifyReproducibleBuilds(first, second, firstArchive, secondArchive);
    assert.equal(verified.reproducible_two_builds, true);
    const firstRecord = join(dir, 'first.json'),
      secondRecord = join(dir, 'second.json');
    writeFileSync(firstRecord, JSON.stringify(first));
    writeFileSync(secondRecord, JSON.stringify(second));
    assert.deepEqual(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            new URL('./reproducibility.mjs', import.meta.url).pathname,
            firstRecord,
            secondRecord,
            firstArchive,
            secondArchive,
          ],
          { encoding: 'utf8' },
        ),
      ),
      verified,
    );
    assert.throws(
      () =>
        verifyReproducibleBuilds(
          first,
          { ...second, manifest_sha256: 'b'.repeat(64) },
          firstArchive,
          secondArchive,
        ),
      /not byte-identical/,
    );
    writeFileSync(secondArchive, 'changed archive bytes');
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            new URL('./reproducibility.mjs', import.meta.url).pathname,
            firstRecord,
            secondRecord,
            firstArchive,
            secondArchive,
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      /not byte-identical/,
    );
    assert.throws(
      () => verifyReproducibleBuilds(first, second, firstArchive, secondArchive),
      /not byte-identical/,
    );
    assert.throws(
      () =>
        verifyReproducibleBuilds(
          first,
          { ...second, sha256: hash(Buffer.from('changed archive bytes')) },
          firstArchive,
          secondArchive,
        ),
      /not byte-identical/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('container proof overrides the image entrypoint with a shell and retains offline read-only isolation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sal-container-command-'));
  try {
    const docker = join(dir, 'docker'),
      capture = join(dir, 'arguments.json');
    // Emulate the observed image default: without an explicit shell entrypoint,
    // Docker hands its command to Node and /bin/bash becomes a JS module path.
    writeFileSync(
      docker,
      `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), at=args.indexOf('--entrypoint');
if(at<0 || args[at+1]!=='/bin/sh') {
  console.error("Cannot find module '/bin/bash'"); process.exit(42);
}
fs.writeFileSync(process.env.DOCKER_CAPTURE,JSON.stringify(args));
`,
      { mode: 0o755 },
    );
    const previous = spawnSync(docker, ['run', privateRuntimeImage, '/bin/bash'], {
      encoding: 'utf8',
    });
    assert.equal(previous.status, 42);
    assert.match(previous.stderr, /Cannot find module/);
    execFileSync(
      '/bin/sh',
      [
        new URL('./run-container.sh', import.meta.url).pathname,
        '/fixture root',
        '/archive path/private.tgz',
        'a'.repeat(64),
        'fixture',
        privateRuntimeImage,
      ],
      { env: { PATH: `${dir}:/usr/bin:/bin`, DOCKER_CAPTURE: capture } },
    );
    const args = JSON.parse(readFileSync(capture, 'utf8'));
    const option = (key) => args[args.indexOf(key) + 1];
    assert.equal(option('--entrypoint'), '/bin/sh');
    assert.equal(option('--network'), 'none');
    assert.ok(args.includes('--pull=never'));
    assert.equal(option('--cap-drop'), 'ALL');
    assert.equal(option('--security-opt'), 'no-new-privileges');
    const imageAt = args.indexOf(privateRuntimeImage);
    assert.ok(args.indexOf('--entrypoint') < imageAt);
    assert.deepEqual(args.slice(imageAt + 1), ['/input/clean-host.sh', 'a'.repeat(64), 'fixture']);
    assert.ok(privateRuntimeImage.includes('4db36457'));
    const mounts = args.filter((_, i) => args[i - 1] === '--mount');
    assert.equal(mounts.length, 4);
    assert.ok(mounts.every((m) => m.endsWith(',readonly')));
    assert.ok(
      mounts.includes(
        'type=bind,src=/archive path/private.tgz,dst=/input/private-runtime.tar.gz,readonly',
      ),
    );
    assert.ok(!mounts.some((m) => /docker\.sock|node_modules/.test(m)));
    execFileSync('/bin/sh', ['-n', new URL('./clean-host.sh', import.meta.url).pathname]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
