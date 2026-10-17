import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { textDigest, ServiceError } from './protocol.js';
import type { Store } from './store.js';

export class Artifacts {
  constructor(
    private dir: string,
    private store: Store,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  put(session: string, content: string): string {
    this.store.session(session);
    const id = randomUUID();
    const path = join(this.dir, id);
    const temp = path + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const dirFd = openSync(this.dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    try {
      this.store.transaction(() => {
        this.store.db
          .prepare('INSERT INTO artifacts VALUES (?,?,?,?)')
          .run(id, session, textDigest(content), Buffer.byteLength(content));
        this.store.event(session, 'artifact.created', {
          artifact_id: id,
          digest: textDigest(content),
        });
      });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    return id;
  }
  read(id: string): string {
    const row = this.store.db.prepare('SELECT digest FROM artifacts WHERE id=?').get(id) as
      { digest: string } | undefined;
    if (!row) throw new ServiceError('not_found', 'Artifact not found', 404);
    const value = readFileSync(join(this.dir, id), 'utf8');
    if (textDigest(value) !== row.digest)
      throw new ServiceError('artifact_corrupt', 'Artifact digest mismatch', 500);
    return value;
  }
}
