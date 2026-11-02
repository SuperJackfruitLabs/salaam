import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../../src/core/config.js';

const exec = promisify(execFile),
  moduleUrl = pathToFileURL(join(ROOT, 'scripts/live-acceptance-budget.mjs')).href;
test('cold startup waits for a competing rollback reader before switching to WAL without losing the seed charge', async () => {
  const dir = mkdtempSync('/tmp/sal-budget-journal-'),
    path = join(dir, 'budget.json');
  writeFileSync(
    path,
    JSON.stringify({
      authorized_on: 'fixture',
      max_model_requests: 60,
      max_output_tokens_per_request: 2048,
      admitted_requests: 3,
      runs: [],
    }),
  );
  const reader = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]+'.sqlite');db.exec('PRAGMA journal_mode=DELETE;CREATE TABLE competing_reader(value);BEGIN;SELECT * FROM competing_reader');process.stdout.write('locked');setTimeout(()=>{db.exec('COMMIT');db.close()},500);`,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      reader.stdout.once('data', () => resolve());
      reader.once('error', reject);
      reader.once('exit', (code) => {
        if (code) reject(Error('Reader fixture exited'));
      });
    });
    const program = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);b.admit('after-journal-lock',2048);process.stdout.write(JSON.stringify(b.snapshot()));b.close();`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', program, path]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      admitted_requests: 4,
      remaining_requests: 56,
    });
  } finally {
    reader.kill();
    await new Promise<void>((resolve) =>
      reader.exitCode !== null ? resolve() : reader.once('close', () => resolve()),
    );
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
test('concurrent acceptance runners share one durable 60-request cap and preserve charges after reopening', async () => {
  const dir = mkdtempSync('/tmp/sal-live-budget-'),
    path = join(dir, 'budget.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({
        authorized_on: 'fixture',
        max_model_requests: 60,
        max_output_tokens_per_request: 2048,
        admitted_requests: 0,
        runs: [],
      }),
    );
    const program = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);let accepted=0,blocked=0;for(let n=0;n<10;n++){try{b.admit(process.argv[2],2048);accepted++}catch(e){if(!e.message.includes('exhausted'))throw e;blocked++}}b.export();process.stdout.write(JSON.stringify({accepted,blocked}));b.close();`;
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        exec(process.execPath, ['--input-type=module', '-e', program, path, 'run-' + i]),
      ),
    );
    const totals = runs.map((r) => JSON.parse(r.stdout));
    expect(totals.reduce((n, r) => n + r.accepted, 0)).toBe(60);
    expect(totals.reduce((n, r) => n + r.blocked, 0)).toBe(20);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      admitted_requests: 60,
      remaining_requests: 0,
    });
    const after = await exec(process.execPath, [
      '--input-type=module',
      '-e',
      program,
      path,
      'after-restart',
    ]);
    expect(JSON.parse(after.stdout)).toEqual({ accepted: 0, blocked: 10 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
test('uncapped or oversized output is rejected without a request admission, while a pre-dispatch crash retains its reservation', async () => {
  const dir = mkdtempSync('/tmp/sal-live-bound-'),
    path = join(dir, 'budget.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({
        authorized_on: 'fixture',
        max_model_requests: 60,
        max_output_tokens_per_request: 2048,
        admitted_requests: 7,
        runs: [],
      }),
    );
    const program = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);for(const n of [0,2049,NaN]){try{b.admit('invalid',n);throw Error('accepted unsafe cap')}catch(e){if(!e.message.includes('output bound'))throw e}}b.admit('before-dispatch',2048);process.exit(0);`;
    await exec(process.execPath, ['--input-type=module', '-e', program, path]);
    const read = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);process.stdout.write(JSON.stringify(b.snapshot()));b.close();`;
    const after = await exec(process.execPath, ['--input-type=module', '-e', read, path]);
    expect(JSON.parse(after.stdout)).toMatchObject({
      admitted_requests: 8,
      remaining_requests: 52,
      runs: [{ run_id: 'before-dispatch', reserved_requests: 1 }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('explicit reauthorization preserves prior charges and existing runners observe the new limits', async () => {
  const dir = mkdtempSync('/tmp/sal-live-raise-'),
    path = join(dir, 'budget.json');
  try {
    writeFileSync(
      path,
      JSON.stringify({
        authorized_on: 'first',
        max_model_requests: 60,
        max_output_tokens_per_request: 2048,
        admitted_requests: 15,
      }),
    );
    const program = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);const peer=new LiveAcceptanceBudget(process.argv[1]);b.reauthorize({expected_requests:60,expected_output:2048,requests:200,output:4096,authorized_on:'approved'});peer.admit('after-raise',4096);try{b.reauthorize({expected_requests:60,expected_output:2048,requests:300,output:4096,authorized_on:'stale'});throw Error('accepted stale update')}catch(e){if(!e.message.includes('current limits'))throw e}try{b.reauthorize({expected_requests:200,expected_output:4096,requests:1,output:4096,authorized_on:'discard'});throw Error('discarded charges')}catch(e){if(!e.message.includes('charged admissions'))throw e}process.stdout.write(JSON.stringify(b.snapshot()));peer.close();b.close();`;
    const result = await exec(process.execPath, ['--input-type=module', '-e', program, path]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      authorized_on: 'approved',
      max_model_requests: 200,
      max_output_tokens_per_request: 4096,
      admitted_requests: 16,
      remaining_requests: 184,
      runs: [{ run_id: 'after-raise', reserved_requests: 1 }],
    });
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...saved, max_model_requests: 300 }));
    const reopen = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};new LiveAcceptanceBudget(process.argv[1]);`;
    await expect(
      exec(process.execPath, ['--input-type=module', '-e', reopen, path]),
    ).rejects.toThrow('explicit reauthorization');
    writeFileSync(path, JSON.stringify(saved));
    const read = `import {LiveAcceptanceBudget} from ${JSON.stringify(moduleUrl)};const b=new LiveAcceptanceBudget(process.argv[1]);process.stdout.write(JSON.stringify(b.snapshot()));b.close();`;
    const after = await exec(process.execPath, ['--input-type=module', '-e', read, path]);
    expect(JSON.parse(after.stdout).admitted_requests).toBe(16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
