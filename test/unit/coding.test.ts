import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { Artifacts } from '../../src/artifacts.js';
import { Workspaces } from '../../src/workspaces.js';
import { CodingWork, commandTerminal } from '../../src/coding.js';
import type { ExecutionBackend } from '../../src/coding-executor.js';
import { until } from '../helpers.js';

class FakeExecutor implements ExecutionBackend {
  profileDigest = 'fixture-profile';
  engineId = 'fixture-engine';
  evidence = { fixture: true };
  creates = 0;
  launches = 0;
  cleanups = 0;
  running = false;
  exit = 0;
  output = 'fixture-output\n';
  size: number | undefined;
  createFault = false;
  cleanupFault = false;
  async create() {
    this.creates++;
    if (this.createFault) throw Error('Lost create response');
    return 'container';
  }
  async start() {}
  async ready() {}
  async exec() {
    return 'exec';
  }
  async launch() {
    this.launches++;
  }
  async status() {
    return { running: this.running, exit: this.running ? null : this.exit };
  }
  async logs() {
    return {
      content: Buffer.from(this.output).toString('base64'),
      bytes: this.size ?? Buffer.byteLength(this.output),
    };
  }
  async cleanup() {
    this.cleanups++;
    if (this.cleanupFault) throw Error('Unconfirmed cleanup');
  }
}
function fixture() {
  const dir = mkdtempSync('/tmp/sal-command-'),
    source = join(dir, 'source'),
    root = join(dir, 'owned');
  mkdirSync(source);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(source, 'app.js'), 'source-canary');
  const store = new Store(join(dir, 'journal.sqlite')),
    artifacts = new Artifacts(join(dir, 'artifacts'), store),
    workspaces = new Workspaces(store, artifacts, root),
    session = store.create(source, 'create', true);
  workspaces.import(session.id, source);
  const backend = new FakeExecutor(),
    errors: Error[] = [];
  const work = new CodingWork(store, workspaces, artifacts, backend, (_session, error) =>
    errors.push(error),
  );
  const args = { step_key: 'test', command: 'node --test', expected_revision: 0 };
  return {
    dir,
    root,
    source,
    store,
    artifacts,
    workspaces,
    session,
    backend,
    work,
    errors,
    args,
    async close() {
      await work.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('stable step keys return original runs before stale lease/revision checks and preserve captured output offsets', async () => {
  const f = fixture();
  try {
    const run = f.work.start(f.session.id, null, f.args, () => {});
    const completed = await until(
      () => f.work.get(f.session.id, run.id),
      (x) => commandTerminal(x.state),
    );
    expect(completed.state).toBe('succeeded');
    expect(completed.exit_code).toBe(0);
    expect(
      f.work.start(f.session.id, null, f.args, () => {
        throw Error('expired lease');
      }).id,
    ).toBe(run.id);
    expect(f.backend.creates).toBe(1);
    expect(f.backend.launches).toBe(1);
    expect(() =>
      f.work.start(f.session.id, null, { ...f.args, command: 'changed' }, () => {}),
    ).toThrow('different arguments');
    expect(f.work.logs(f.session.id, run.id, 0)).toMatchObject({
      text: 'fixture-output\n',
      complete: true,
      next_offset: 15,
    });
    expect(() => f.work.logs(f.session.id, run.id, -1)).toThrow('offset');
    expect(readFileSync(join(f.source, 'app.js'), 'utf8')).toBe('source-canary');
    expect(f.work.cancel(f.session.id, run.id, 'cancel-finished', () => {}).state).toBe(
      'succeeded',
    );
  } finally {
    await f.close();
  }
});
test('replacement resumes the same known execution and command cancellation removes it without replay', async () => {
  const f = fixture();
  let replacement: CodingWork | undefined;
  try {
    f.backend.running = true;
    const run = f.work.start(f.session.id, null, f.args, () => {});
    await until(
      () => f.work.get(f.session.id, run.id),
      (x) => x.state === 'running',
    );
    await f.work.close();
    const workspaces = new Workspaces(f.store, f.artifacts, f.root);
    replacement = new CodingWork(f.store, workspaces, f.artifacts, f.backend, (_s, e) =>
      f.errors.push(e),
    );
    replacement.recover();
    expect(() =>
      workspaces.patch(f.session.id, 'blocked', {
        path: 'app.js',
        expected_revision: 0,
        expected_hash: 'x',
        content: 'no',
      }),
    ).toThrow('owns');
    replacement.cancel(f.session.id, run.id, 'cancel', () => {});
    const result = await until(
      () => replacement!.get(f.session.id, run.id),
      (x) => commandTerminal(x.state),
    );
    expect(result.state).toBe('cancelled');
    expect(f.backend.launches).toBe(1);
    expect(f.backend.creates).toBe(1);
    expect(f.errors).toEqual([]);
  } finally {
    await replacement?.close();
    await f.close();
  }
});
test('lost create response remains unknown until read-only reconciliation and never launches a replacement', async () => {
  const f = fixture();
  try {
    f.backend.createFault = true;
    const run = f.work.start(f.session.id, null, f.args, () => {});
    await until(
      () => f.work.get(f.session.id, run.id),
      (x) => x.state === 'outcome_unknown',
    );
    expect(() => f.work.assertSafe(f.session.id)).toThrow('uncertain executor');
    f.work.reconcile(f.session.id, run.id);
    const result = await until(
      () => f.work.get(f.session.id, run.id),
      (x) => commandTerminal(x.state),
    );
    expect(result.state).toBe('interrupted');
    expect(f.backend.creates).toBe(1);
    expect(f.backend.launches).toBe(0);
  } finally {
    await f.close();
  }
});
test('cleanup uncertainty blocks grants; positive exit receipt is settled only after confirmed removal', async () => {
  const f = fixture();
  try {
    f.backend.cleanupFault = true;
    const run = f.work.start(f.session.id, null, f.args, () => {});
    const unknown = await until(
      () => f.work.get(f.session.id, run.id),
      (x) => x.state === 'outcome_unknown',
    );
    expect(unknown.exit_code).toBe(0);
    expect(unknown.resume_state).toBe('finishing');
    f.backend.cleanupFault = false;
    f.work.reconcile(f.session.id, run.id);
    expect(
      (
        await until(
          () => f.work.get(f.session.id, run.id),
          (x) => commandTerminal(x.state),
        )
      ).state,
    ).toBe('succeeded');
    expect(f.backend.launches).toBe(1);
  } finally {
    await f.close();
  }
});
test('an unacknowledged launch is interrupted rather than inferred successful from default exit zero', async () => {
  const f = fixture();
  let replacement: CodingWork | undefined;
  try {
    f.backend.running = true;
    const run = f.work.start(f.session.id, null, f.args, () => {});
    await until(
      () => f.work.get(f.session.id, run.id),
      (x) => x.state === 'running',
    );
    await f.work.close();
    f.store.db.prepare("UPDATE command_runs SET state='launching' WHERE id=?").run(run.id);
    f.backend.running = false;
    replacement = new CodingWork(
      f.store,
      new Workspaces(f.store, f.artifacts, f.root),
      f.artifacts,
      f.backend,
      () => {},
    );
    replacement.recover();
    expect(
      (
        await until(
          () => replacement!.get(f.session.id, run.id),
          (x) => commandTerminal(x.state),
        )
      ).state,
    ).toBe('interrupted');
    expect(f.backend.launches).toBe(1);
  } finally {
    await replacement?.close();
    await f.close();
  }
});
test.each(['output', 'deadline', 'exit'])(
  'command %s failures retain the actual outcome and remove descendants',
  async (kind) => {
    const f = fixture();
    try {
      f.backend.running = true;
      const run = f.work.start(f.session.id, null, f.args, () => {});
      await until(
        () => f.work.get(f.session.id, run.id),
        (x) => x.state === 'running',
      );
      if (kind === 'output') f.backend.size = 70_000;
      if (kind === 'deadline')
        f.store.db.prepare('UPDATE command_runs SET deadline=0 WHERE id=?').run(run.id);
      if (kind === 'exit') {
        f.backend.exit = 2;
        f.backend.running = false;
      }
      const result = await until(
        () => f.work.get(f.session.id, run.id),
        (x) => commandTerminal(x.state),
      );
      expect(result.state).toBe(
        kind === 'output' ? 'output_limited' : kind === 'deadline' ? 'timed_out' : 'failed',
      );
      expect(f.backend.cleanups).toBeGreaterThan(0);
      expect(f.backend.launches).toBe(1);
    } finally {
      await f.close();
    }
  },
);
test('disk-full/recording failure and stale workspace revision deny engine calls', async () => {
  const f = fixture();
  try {
    expect(() =>
      f.work.start(f.session.id, null, { ...f.args, expected_revision: 9 }, () => {}),
    ).toThrow('revision changed');
    f.store.db.exec('PRAGMA query_only=ON');
    expect(() => f.work.start(f.session.id, null, f.args, () => {})).toThrow();
    expect(f.backend.creates).toBe(0);
    expect(f.backend.launches).toBe(0);
  } finally {
    await f.close();
  }
});

test('temporary backend loss preserves the resume phase and original execution identity', async () => {
  const f = fixture();
  let unavailable: CodingWork | undefined, replacement: CodingWork | undefined;
  try {
    f.backend.running = true;
    const run = f.work.start(f.session.id, null, f.args, () => {});
    await until(
      () => f.work.get(f.session.id, run.id),
      (x) => x.state === 'running',
    );
    await f.work.close();
    unavailable = new CodingWork(
      f.store,
      new Workspaces(f.store, f.artifacts, f.root),
      f.artifacts,
      undefined,
      () => {},
    );
    unavailable.recover();
    expect(unavailable.get(f.session.id, run.id)).toMatchObject({
      state: 'outcome_unknown',
      resume_state: 'running',
    });
    await unavailable.close();
    replacement = new CodingWork(
      f.store,
      new Workspaces(f.store, f.artifacts, f.root),
      f.artifacts,
      f.backend,
      () => {},
    );
    replacement.recover();
    replacement.reconcile(f.session.id, run.id);
    f.backend.running = false;
    expect(
      (
        await until(
          () => replacement!.get(f.session.id, run.id),
          (x) => commandTerminal(x.state),
        )
      ).state,
    ).toBe('succeeded');
    expect(f.backend.launches).toBe(1);
  } finally {
    await unavailable?.close();
    await replacement?.close();
    await f.close();
  }
});
