import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { call } from '../../src/transport.js';
import { ROOT } from '../../src/config.js';
import { acquireControl } from '../../src/attach.js';
import { until } from '../helpers.js';
import { checkedPlan } from '../task-helpers.js';
import type { Session, Controller } from '../../src/protocol.js';
import type { WorkTask } from '../../src/records.js';
import { PtyClient } from '../terminal-helpers.js';
import { readTree } from '../../src/workspaces.js';
import { digest } from '../../src/protocol.js';
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, 'exit');
  child.kill('SIGKILL');
  await done;
}
async function fixture(mode: string) {
  const dir = mkdtempSync('/tmp/sal-m11-life-'),
    source = join(dir, 'source'),
    state = join(dir, 'state'),
    socket = join(state, 'operator.sock');
  mkdirSync(source);
  writeFileSync(join(source, 'app.js'), 'fixture deliverable\n');
  let child: ChildProcess;
  const boot = async (mode: string) => {
    child = spawn(
      process.execPath,
      [join(ROOT, 'test/fixtures/task-lifecycle-service.mjs'), dir, mode],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await once(child.stdout!, 'data');
  };
  await boot(mode);
  const session = await call<Session>(socket, '/v1/sessions', {
    request_id: 'session',
    cwd: source,
    coding: true,
  });
  await until(
    () => call<Session>(socket, `/v1/sessions/${session.id}`),
    (s) => s.state === 'ready',
  );
  let actor: Controller;
  const acquire = async () => {
    const client_id = randomUUID(),
      lease = await acquireControl(socket, session.id, client_id, true);
    actor = { client_id, token: lease.token };
  };
  await acquire();
  const task = () =>
    call<WorkTask & { runtime: any; verification: any }>(
      socket,
      `/v1/tasks?session_id=${session.id}`,
    );
  const plan = async (value: unknown = checkedPlan(2)) =>
    call<WorkTask>(socket, '/v1/tasks', {
      ...actor,
      request_id: 'task',
      expected_revision: 0,
      session_id: session.id,
      plan: value,
    });
  const auto = async (compact = false) => {
    const t = await task();
    return call(socket, `/v1/tasks/${t.id}/auto`, {
      ...actor,
      request_id: 'auto',
      expected_revision: t.revision,
      max_steps: 2,
      compact,
    });
  };
  return {
    dir,
    source,
    state,
    socket,
    session,
    task,
    plan,
    auto,
    get actor() {
      return actor;
    },
    async restart(beforeBoot?: () => void) {
      await kill(child);
      beforeBoot?.();
      await boot('replacement');
      await acquire();
    },
    async close() {
      await kill(child);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('daemon SIGKILL between verified steps resumes the saved grant once; a replacement client reads the same result', async () => {
  const f = await fixture('between-steps');
  try {
    const original = await f.plan();
    await f.auto();
    await until(() => existsSync(join(f.dir, 'between-steps')), Boolean);
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'), { readOnly: true });
    const rows = db
      .prepare('SELECT id,state,attempt_id FROM task_steps WHERE task_id=? ORDER BY ordinal')
      .all(original.id);
    db.close();
    const before = { steps: rows };
    expect(before.steps[0]!.state).toBe('completed');
    expect(before.steps[1]!.attempt_id).toBeNull();
    await f.restart();
    const completed = await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(completed.id).toBe(original.id);
    expect(completed.steps.map((s) => s.id)).toEqual(original.steps.map((s) => s.id));
    expect(completed.steps[0]!.attempt_id).toBe(before.steps[0]!.attempt_id);
    const events = readFileSync(join(f.dir, 'executor-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.phase === 'launch');
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.run)).size).toBe(3);
    const result = JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [join(ROOT, 'bin/salaam.mjs'), 'tasks', 'inspect', completed.id, '--state', f.state],
          { cwd: f.source },
        )
      ).stdout,
    );
    expect(result.state).toBe('succeeded');
    expect(result.steps).toEqual(completed.steps);
  } finally {
    await f.close();
  }
});

test('a restore intent survives daemon death and refuses to overwrite a human edit made before recovery', async () => {
  const f = await fixture('restore-prepared');
  try {
    const workspace = await call<any>(f.socket, `/v1/sessions/${f.session.id}/workspace`),
      tree = readTree(workspace.root);
    const plan = checkedPlan();
    plan.steps[0]!.instruction =
      '[files] ' +
      JSON.stringify({
        action: 'patch',
        path: 'app.js',
        expected_revision: workspace.revision,
        expected_hash: digest(tree['app.js']),
        content: 'owned task edit\n',
      });
    let t = await f.plan(plan);
    const checkpoint = await call<any>(f.socket, `/v1/tasks/${t.id}/checkpoint`, {
      ...f.actor,
      request_id: 'checkpoint',
      expected_revision: t.revision,
    });
    await f.auto();
    t = await until(f.task, (t) => t.state === 'succeeded');
    const changed = await call<any>(f.socket, `/v1/sessions/${f.session.id}/workspace`);
    const pending = call(f.socket, `/v1/tasks/${t.id}/restore`, {
      ...f.actor,
      request_id: 'restore-once',
      expected_revision: t.revision,
      checkpoint_id: checkpoint.id,
      workspace_revision: changed.revision,
      workspace_digest: changed.digest,
    });
    void pending.catch(() => {});
    await until(() => existsSync(join(f.dir, 'restore-before-write')), Boolean);
    await f.restart(() =>
      writeFileSync(join(changed.root, 'app.js'), 'new human work after crash\n'),
    );
    await pending.catch(() => {});
    const restores = await call<any[]>(f.socket, `/v1/tasks/${t.id}/restores`);
    expect(restores).toHaveLength(1);
    expect(restores[0].state).toBe('conflict');
    expect(readFileSync(join(changed.root, 'app.js'), 'utf8')).toBe('new human work after crash\n');
    expect((await f.task()).state).toBe('blocked');
  } finally {
    await f.close();
  }
});

test('a daemon crash in an active automatic step pauses the task without resubmission', async () => {
  const f = await fixture('active-step');
  try {
    const original = await f.plan();
    await f.auto();
    await until(() => existsSync(join(f.source, 'probe-entered')), Boolean);
    const before = await f.task();
    await f.restart();
    const stopped = await until(f.task, (t) => !t.runtime.auto_enabled);
    expect(stopped.steps[0]).toMatchObject({
      id: original.steps[0]!.id,
      attempt_id: before.steps[0]!.attempt_id,
      state: 'interrupted',
    });
    expect(stopped.steps[1]!.attempt_id).toBeNull();
    expect(stopped.state).not.toBe('succeeded');
  } finally {
    await f.close();
  }
});

test('a human workspace edit after a verified step invalidates its pending progression grant on daemon recovery', async () => {
  const f = await fixture('between-steps');
  try {
    const initial = await f.plan();
    await f.auto();
    await until(() => existsSync(join(f.dir, 'between-steps')), Boolean);
    const db = new DatabaseSync(join(f.state, 'journal.sqlite'), { readOnly: true });
    const w = db.prepare('SELECT root FROM workspaces WHERE session_id=?').get(f.session.id)!;
    db.close();
    await f.restart(() =>
      writeFileSync(join(String(w.root), 'app.js'), 'human change between steps\n'),
    );
    const stopped = await until(
      f.task,
      (t) => !t.runtime.auto_enabled && t.runtime.auto_error,
      10000,
    );
    expect(stopped.steps[0]!.id).toBe(initial.steps[0]!.id);
    expect(stopped.steps[1]!.attempt_id).toBeNull();
    expect(stopped.state).not.toBe('succeeded');
    expect(readFileSync(join(String(w.root), 'app.js'), 'utf8')).toBe(
      'human change between steps\n',
    );
  } finally {
    await f.close();
  }
});

test('command acceptance before verification linkage is recovered without repeating a launch or claiming success', async () => {
  const f = await fixture('check-link');
  try {
    await f.plan();
    await f.auto();
    await until(() => existsSync(join(f.dir, 'command-before-link')), Boolean);
    await f.restart();
    const stopped = await until(
      f.task,
      (t) =>
        !t.runtime.auto_enabled && t.verification.checks.some((c: any) => c.state === 'failed'),
      10000,
    );
    expect(stopped.state).not.toBe('succeeded');
    expect(stopped.steps[1]!.attempt_id).toBeNull();
    expect(stopped.verification.checks).toHaveLength(1);
    const events = readFileSync(join(f.dir, 'executor-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.filter((e) => e.phase === 'create')).toHaveLength(1);
    expect(events.filter((e) => e.phase === 'launch')).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('a persisted deterministic compaction receipt survives daemon death before its reply and preserves the bounded plan', async () => {
  const f = await fixture('compaction');
  try {
    for (let n = 0; n < 2; n++) {
      const s = await call<Session>(f.socket, `/v1/sessions/${f.session.id}`);
      const a = await call<{ attempt_id: string }>(
        f.socket,
        `/v1/sessions/${f.session.id}/submissions`,
        {
          ...f.actor,
          request_id: 'seed-' + n,
          expected_revision: s.revision,
          text: 'Historical fixture context ' + 'old context '.repeat(4000),
        },
      );
      await until(
        () => call<any>(f.socket, `/v1/attempts/${a.attempt_id}`),
        (a) => a.state === 'completed',
      );
    }
    const client_id = f.actor.client_id;
    const lease = await acquireControl(f.socket, f.session.id, client_id, true);
    Object.assign(f.actor, { token: lease.token });
    const original = await f.plan({ ...checkedPlan(2), limits: { input_token_bound: 524288 } });
    writeFileSync(join(f.source, 'hold-after-compaction'), 'hold');
    await f.auto(true);
    await until(() => existsSync(join(f.source, 'compaction-persisted')), Boolean, 15000);
    const before = await f.task();
    await f.restart();
    const done = await until(f.task, (t) => t.state === 'succeeded', 15000);
    expect(done.id).toBe(original.id);
    expect(done.steps[0]!.attempt_id).toBe(before.steps[0]!.attempt_id);
    expect(done.steps.every((s) => s.state === 'completed')).toBe(true);
    const history = await call<any>(f.socket, `/v1/tasks/${done.id}/history`);
    expect(history.attempts).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 40000);

test('a real PTY creates a task, authorizes a bounded plan, detaches and reconnects to the verified outcome', async () => {
  const f = await fixture('replacement');
  let terminal: PtyClient | undefined;
  try {
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--state',
        f.state,
        '--takeover',
      ],
      { state: f.state, columns: 120, rows: 42 },
    );
    await terminal.contains('You have control');
    await terminal.write('\x0b');
    await terminal.write('Task actions\r');
    await terminal.contains('Create task · plan JSON');
    await terminal.write('\x15');
    await terminal.write(JSON.stringify(checkedPlan(2)));
    await terminal.write('\r');
    await terminal.contains('Create this task');
    await terminal.write('\x1b[C\r');
    await until(f.task, (t) => !!t?.id);
    await terminal.contains('TASK · ACCEPTED');
    await terminal.write('\x0b');
    await terminal.contains('Salaam · actions');
    await terminal.write('Task actions\r');
    await terminal.contains('Salaam · task');
    await terminal.write('Run bounded task\r');
    await terminal.contains('Bounded progression');
    await terminal.write('\x15');
    await terminal.write('2');
    await terminal.write('\r');
    await terminal.contains('Run this bounded plan');
    await terminal.write('\x1b[C\r');
    await until(f.task, (t) => !!t.runtime.started_at);
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
    const completed = await until(f.task, (t) => t.state === 'succeeded', 15000);
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.session.id,
        '--state',
        f.state,
        '--observe',
      ],
      { state: f.state, columns: 120, rows: 42 },
    );
    await terminal.contains('Observer');
    await terminal.write('\x0b');
    await terminal.contains('Salaam · actions');
    await terminal.write('Session context\r');
    await terminal.contains('SUCCEEDED');
    expect(completed.verification.completion.fresh).toBe(true);
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);
