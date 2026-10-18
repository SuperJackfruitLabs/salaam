import { DatabaseSync } from 'node:sqlite';
import {
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Internal acceptance tooling: the user's shared M13–M18 authorization, never a per-run allowance. */
export class LiveAcceptanceBudget {
  constructor(path) {
    this.path = path;
    const approved = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !Number.isSafeInteger(approved.max_model_requests) ||
      approved.max_model_requests < 1 ||
      !Number.isSafeInteger(approved.max_output_tokens_per_request) ||
      approved.max_output_tokens_per_request < 1 ||
      !Number.isSafeInteger(approved.admitted_requests) ||
      approved.admitted_requests < 0 ||
      approved.admitted_requests > approved.max_model_requests
    )
      throw new Error('Missing or changed live acceptance authorization');
    this.db = new DatabaseSync(path + '.sqlite');
    chmodSync(path + '.sqlite', 0o600);
    try {
      this.db.exec('PRAGMA busy_timeout=5000');
      // SQLite may return BUSY immediately while changing journal mode, despite
      // busy_timeout. Only idempotent startup statements are retried; admissions
      // and their charges are never replayed or refunded.
      const deadline = Date.now() + 5000,
        pause = new Int32Array(new SharedArrayBuffer(4));
      for (;;) {
        try {
          this.db.exec(
            'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS authorization(id INTEGER PRIMARY KEY CHECK(id=1),requests INTEGER NOT NULL,output INTEGER NOT NULL,seed INTEGER NOT NULL,authorized_on TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admissions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,output_bound INTEGER NOT NULL,created_at INTEGER NOT NULL);',
          );
          break;
        } catch (error) {
          if (error.errcode !== 5 || Date.now() >= deadline) throw error;
          Atomics.wait(pause, 0, 0, 10);
        }
      }
      this.db.exec('BEGIN IMMEDIATE');
      this.db
        .prepare('INSERT OR IGNORE INTO authorization VALUES (1,?,?,?,?)')
        .run(
          approved.max_model_requests,
          approved.max_output_tokens_per_request,
          approved.admitted_requests,
          approved.authorized_on,
        );
      const row = this.db.prepare('SELECT * FROM authorization WHERE id=1').get();
      if (
        row.requests !== approved.max_model_requests ||
        row.output !== approved.max_output_tokens_per_request
      )
        throw new Error('Live authorization changed without explicit reauthorization');
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      this.db.close();
      throw error;
    }
  }
  reauthorize({ expected_requests, expected_output, requests, output, authorized_on }) {
    if (
      !Number.isSafeInteger(requests) ||
      requests < 1 ||
      !Number.isSafeInteger(output) ||
      output < 1 ||
      typeof authorized_on !== 'string' ||
      !authorized_on.length
    )
      throw new Error('Invalid live acceptance reauthorization');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.snapshot();
      if (
        current.max_model_requests !== expected_requests ||
        current.max_output_tokens_per_request !== expected_output
      )
        throw new Error('Live reauthorization requires the current limits');
      if (requests < current.admitted_requests)
        throw new Error('Live reauthorization cannot discard charged admissions');
      this.db
        .prepare('UPDATE authorization SET requests=?,output=?,authorized_on=? WHERE id=1')
        .run(requests, output, authorized_on);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.export();
  }
  snapshot() {
    const row = this.db.prepare('SELECT * FROM authorization WHERE id=1').get(),
      count =
        Number(this.db.prepare('SELECT count(*) AS n FROM admissions').get().n) + Number(row.seed);
    return {
      authorized_on: row.authorized_on,
      max_model_requests: Number(row.requests),
      max_output_tokens_per_request: Number(row.output),
      admitted_requests: count,
      remaining_requests: Math.max(0, Number(row.requests) - count),
      runs: this.db
        .prepare(
          'SELECT run_id,count(*) AS reserved_requests,max(output_bound) AS max_output_tokens FROM admissions GROUP BY run_id ORDER BY min(created_at)',
        )
        .all(),
    };
  }
  admit(run, output) {
    if (
      typeof run !== 'string' ||
      !run.length ||
      run.length > 128 ||
      !Number.isSafeInteger(output) ||
      output < 1 ||
      output > this.snapshot().max_output_tokens_per_request
    )
      throw new Error('Live request lacks its authorized provider-enforced output bound');
    this.db.exec('BEGIN IMMEDIATE');
    const id = randomUUID();
    try {
      const current = this.snapshot();
      if (output > current.max_output_tokens_per_request)
        throw new Error('Live request lacks its authorized provider-enforced output bound');
      if (current.admitted_requests >= current.max_model_requests)
        throw new Error('Shared live acceptance request budget exhausted');
      this.db.prepare('INSERT INTO admissions VALUES (?,?,?,?)').run(id, run, output, Date.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    // The admission remains charged if export or a later local transaction fails.
    // No lost reply, daemon restart or failed HTTP request can refund it silently.
    this.export();
    return id;
  }
  export() {
    this.db.exec('BEGIN IMMEDIATE');
    const temp = this.path + '.' + randomUUID() + '.tmp';
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(this.snapshot(), null, 2) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      try {
        unlinkSync(temp);
      } catch {}
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
