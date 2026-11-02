import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceError } from './protocol.js';

// Keep ownership alive even when an embedded service is no longer referenced
// after an unconfirmed shutdown. Only explicit release or OS process death may
// hand this state directory to a replacement service.
const owners = new Set<DatabaseSync>();

// A separate rollback-journal database holds an OS-managed exclusive lock for
// the service lifetime. Process death releases it; no stale timeout or PID guess.
export function acquireStateLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, 'owner.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;',
    );
  } catch {
    db.close();
    throw new ServiceError('state_locked', 'Another Salaam service owns this state directory');
  }
  owners.add(db);
  return () => {
    if (!owners.has(db)) return;
    db.exec('ROLLBACK');
    db.close();
    owners.delete(db);
  };
}
