import {
  existsSync,
  mkdirSync,
  cpSync,
  readlinkSync,
  symlinkSync,
  renameSync,
  writeFileSync,
  rmSync,
  realpathSync,
  lstatSync,
  mkdtempSync,
  chmodSync,
} from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verify } from './inventory.mjs';

const [sourceArg, prefixArg, database, stopped] = process.argv.slice(2);
if (!sourceArg || !prefixArg) throw Error('Usage: activate.mjs BUNDLE PREFIX [DATABASE --stopped]');
const source = resolve(sourceArg),
  prefix = resolve(prefixArg);
const { manifest, digest } = verify(source);
mkdirSync(prefix, { recursive: true, mode: 0o700 });
// Exclusive install lock prevents concurrent pointer replacement; never grants service authority.
const lock = acquireOwner(prefix, '.install-owner.sqlite');
const stateReleases = [];
let transaction;
function acquireOwner(directory, name = 'owner.sqlite') {
  const path = join(directory, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (
    stat &&
    (stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0)
  )
    throw Error('Ownership lock must be a canonical private user-owned regular file');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;',
    );
  } catch {
    db.close();
    throw Error('Another Salaam process owns this state or installation');
  }
  return () => {
    db.exec('ROLLBACK');
    db.close();
  };
}
function privateLockDirectory(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o077) !== 0
  )
    throw Error('Host lock directory must be canonical, private and user-owned');
  return path;
}
try {
  const current = join(prefix, 'current');
  const previous = existsSync(current) ? readlinkSync(current) : undefined;
  if (previous || database) {
    if (!database || stopped !== '--stopped')
      throw Error('Upgrade/rollback requires a stopped service and explicit database path');
    const journal = resolve(database);
    const state = dirname(journal);
    if (
      journal !== database ||
      basename(journal) !== 'journal.sqlite' ||
      realpathSync(state) !== state ||
      realpathSync(journal) !== journal ||
      !lstatSync(journal).isFile() ||
      lstatSync(journal).uid !== process.getuid() ||
      lstatSync(state).uid !== process.getuid() ||
      (lstatSync(state).mode & 0o077) !== 0
    )
      throw Error(
        'Upgrade requires the canonical private state directory and existing journal.sqlite',
      );
    const owner = join(state, 'owner.sqlite');
    if (
      !existsSync(owner) ||
      realpathSync(owner) !== owner ||
      !lstatSync(owner).isFile() ||
      lstatSync(owner).uid !== process.getuid()
    )
      throw Error('Upgrade requires an existing canonical state owner.sqlite');
    // Match native configuration apply: startup -> host supervisor -> daemon.
    // Also create missing compatible locks, so a concurrent first host startup
    // cannot pass between an absence check and the runtime pointer switch.
    for (const directory of [join(state, 'startup'), join(state, 'host'), state])
      stateReleases.push(acquireOwner(privateLockDirectory(directory)));
    // Read-only: never migrate, create, or alter operator state during installation.
    const db = new DatabaseSync(journal, { readOnly: true });
    try {
      const version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version < manifest.state_schema.min || version > manifest.state_schema.max)
        throw Error(`State schema ${version} is incompatible with runtime ${manifest.version}`);
    } finally {
      db.close();
    }
  }
  mkdirSync(join(prefix, 'releases'), { recursive: true, mode: 0o700 });
  const target = join(prefix, 'releases', digest);
  if (!existsSync(target)) {
    const pending = mkdtempSync(join(prefix, 'releases', '.pending-'));
    try {
      cpSync(source, pending, { recursive: true, errorOnExist: true, force: false });
      verify(pending);
      renameSync(pending, target);
    } finally {
      rmSync(pending, { recursive: true, force: true });
    }
  } else verify(target);
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  const wrapper =
    '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd -P)\nexec "$root/current/bin/salaam" "$@"\n';
  for (const name of ['salaam', 'sal'])
    writeFileSync(join(prefix, 'bin', name), wrapper, { mode: 0o755 });
  if (previous) writeFileSync(join(prefix, 'previous-runtime'), previous + '\n', { mode: 0o600 });
  // Each attempt owns only its fresh staging directory; abandoned crash staging
  // never blocks retries and unknown files are never removed.
  transaction = mkdtempSync(join(prefix, '.activation-'));
  symlinkSync(`releases/${digest}`, join(transaction, 'next'));
  renameSync(join(transaction, 'next'), current);
  console.log(
    JSON.stringify({ version: manifest.version, manifest_sha256: digest, prefix, previous }),
  );
} finally {
  if (transaction) rmSync(transaction, { recursive: true, force: true });
  for (const release of stateReleases.reverse()) release();
  lock();
}
