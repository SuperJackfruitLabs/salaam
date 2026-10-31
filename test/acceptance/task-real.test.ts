import { expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, bundleDigest } from '../../src/config.js';
import { call } from '../../src/transport.js';
import { acquireControl } from '../../src/attach.js';
import { digest, type Session } from '../../src/protocol.js';
import { engineRequest, engineJson } from '../../src/execution-boundary.js';
import { DockerCodingExecutor } from '../../src/coding-executor.js';
import { until } from '../helpers.js';
import { PtyClient } from '../terminal-helpers.js';
import { readTree } from '../../src/workspaces.js';

test('real executor: TUI task, guarded repair, daemon SIGKILL between steps, bound human approval and fresh completion', async () => {
  const engineSocket = process.env.SALAAM_TASK_REAL_SOCKET,
    scratch = process.env.SALAAM_TASK_REAL_SCRATCH;
  if (!engineSocket || !scratch)
    throw Error(
      'Set SALAAM_TASK_REAL_SOCKET and SALAAM_TASK_REAL_SCRATCH to a pre-provisioned proven Docker backend',
    );
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const fixture = mkdtempSync(join(realpathSync(scratch), 'm11-')),
    source = join(fixture, 'source'),
    owned = join(fixture, 'owned');
  mkdirSync(source);
  mkdirSync(owned, { mode: 0o700 });
  const state = mkdtempSync('/tmp/sal-m11-real-'),
    socket = join(state, 'operator.sock'),
    reportPath = resolve(
      process.env.SALAAM_TASK_REAL_REPORT ?? join(ROOT, '.state/evidence/m11/real-local.json'),
    );
  mkdirSync(resolve(reportPath, '..'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(source, 'math.js'), 'export const add = (a,b) => a-b;\n');
  writeFileSync(
    join(source, 'math.test.js'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from './math.js';test('addition',()=>assert.equal(add(2,3),5));\n",
  );
  writeFileSync(join(source, 'human.txt'), 'dirty work predating this task\n');
  let child: ChildProcess | undefined,
    terminal: PtyClient | undefined,
    stderr = '';
  let result: Record<string, any> = {
    schema: 1,
    observed_at: new Date().toISOString(),
    success: false,
    scope:
      'Offline Pi and real pinned Docker Node executor; local terminal and replacement operator clients',
    state,
    fixture,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    bundle_digest: bundleDigest(),
  };
  const boot = async (mode: string) => {
    child = spawn(
      process.execPath,
      [join(ROOT, 'test/fixtures/task-real-service.mjs'), state, owned, engineSocket, mode],
      {
        env: {
          PATH: process.env.PATH,
          HOME: state,
          TMPDIR: process.env.TMPDIR,
          LANG: 'en_US.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stderr!.on('data', (v) => {
      stderr = (stderr + v.toString()).slice(-12000);
    });
    await Promise.race([
      once(child.stdout!, 'data'),
      once(child, 'exit').then(() => {
        throw Error('Real fixture failed to start: ' + stderr);
      }),
    ]);
  };
  const kill = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  };
  try {
    await boot('between-steps');
    result.initial_executor = JSON.parse(readFileSync(join(state, 'executor-proof.json'), 'utf8'));
    const session = await call<Session>(socket, '/v1/sessions', {
      request_id: 'real-session',
      cwd: source,
      coding: true,
    });
    await until(
      () => call<Session>(socket, `/v1/sessions/${session.id}`),
      (s) => s.state === 'ready',
      20000,
    );
    const lease = await acquireControl(socket, session.id, 'baseline');
    const baseline = await call<any>(socket, `/v1/sessions/${session.id}/commands`, {
      client_id: 'baseline',
      token: lease.token,
      step_key: 'baseline-failing-test',
      command: 'node --test',
      expected_revision: 0,
    });
    const failed = await until(
      () => call<any>(socket, `/v1/sessions/${session.id}/commands/${baseline.id}`),
      (r) => ['failed', 'succeeded'].includes(r.state),
      30000,
    );
    expect(failed.exit_code).toBe(1);
    result.baseline = failed;
    const workspace = await call<any>(socket, `/v1/sessions/${session.id}/workspace`),
      tree = readTree(workspace.root);
    const plan = {
      objective: 'Repair addition, retain human work and verify the repository',
      constraints: ['Only the task-owned working copy may change', 'Keep human.txt intact'],
      steps: [
        {
          key: 'repair',
          title: 'Repair addition',
          instruction:
            '[files] ' +
            JSON.stringify({
              action: 'patch',
              path: 'math.js',
              expected_revision: 0,
              expected_hash: digest(tree['math.js']),
              content: 'export const add = (a,b) => a+b;\n',
            }),
          depends_on: [],
          checks: ['suite'],
        },
        {
          key: 'review',
          title: 'Wait for bound operator review',
          instruction: '[review] repaired-addition',
          depends_on: ['repair'],
          checks: ['suite'],
        },
        {
          key: 'inspect',
          title: 'Inspect the owned result',
          instruction: '[files] ' + JSON.stringify({ action: 'read', path: 'math.js' }),
          depends_on: ['review'],
          checks: ['suite'],
        },
      ],
      acceptance: [{ key: 'suite', command: 'node --test', cwd: '.' }],
      deliverables: ['math.js', 'math.test.js', 'human.txt'],
      limits: {
        requests: 8,
        runtime_ms: 180000,
        concurrency: 2,
        input_token_bound: 131072,
        output_token_bound: 1024,
        token_units: 1100000,
        verification_runs: 4,
      },
    };
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        session.id,
        '--state',
        state,
        '--takeover',
      ],
      { state, columns: 120, rows: 42 },
    );
    await terminal.contains('You have control');
    const palette = async () => {
      await terminal!.write('\x0b');
      await terminal!.contains('Salaam · actions');
      await terminal!.write('Task actions\r');
    };
    await palette();
    await terminal.contains('Create task · plan JSON');
    await terminal.write('\x15');
    await terminal.write(JSON.stringify(plan));
    await terminal.write('\r');
    await terminal.contains('Create this task');
    await terminal.write('\x1b[C\r');
    await terminal.contains('TASK · ACCEPTED');
    const task = () => call<any>(socket, `/v1/tasks?session_id=${session.id}`);
    const created = await task();
    result.task_id = created.id;
    result.step_ids = created.steps.map((s: any) => s.id);
    await palette();
    await terminal.contains('Salaam · task');
    await terminal.write('Create task checkpoint\r');
    const checkpoints = await until(
      () => call<any[]>(socket, `/v1/tasks/${created.id}/checkpoints`),
      (rows) => rows.length === 1,
    );
    result.checkpoint = checkpoints[0];
    await terminal.contains('TASK · ACCEPTED');
    await palette();
    await terminal.contains('Salaam · task');
    await terminal.write('Run bounded task\r');
    await terminal.contains('Bounded progression');
    await terminal.write('\x15');
    await terminal.write('3');
    await terminal.write('\r');
    await terminal.contains('Run this bounded plan');
    await terminal.write('\x1b[C\r');
    // Detaching never owns the task, worker or executor lifetime.
    await until(() => existsSync(join(state, 'between-steps')), Boolean, 45000);
    await terminal.close();
    terminal = undefined;
    const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true });
    result.before_restart = {
      steps: db
        .prepare('SELECT id,state,attempt_id FROM task_steps WHERE task_id=? ORDER BY ordinal')
        .all(created.id),
      grants: db.prepare('SELECT * FROM task_grants WHERE task_id=?').all(created.id),
    };
    db.close();
    expect(result.before_restart.steps[0].state).toBe('completed');
    expect(result.before_restart.steps[1].attempt_id).toBeNull();
    await kill();
    await boot('replacement');
    result.resumed_executor = JSON.parse(readFileSync(join(state, 'executor-proof.json'), 'utf8'));
    const waiting = await until(task, (t) => t.state === 'waiting_for_person', 30000);
    expect(waiting.steps[0].attempt_id).toBe(result.before_restart.steps[0].attempt_id);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', session.id, '--state', state, '--observe'],
      { state, columns: 120, rows: 42 },
    );
    await terminal.contains('Observer');
    // The observer frame can precede the first session/approval snapshot.
    await terminal.contains('1 approval waiting');
    await terminal.write('\x0f');
    await terminal.contains('Approve?');
    await terminal.write('\x1b[F');
    // Reading to the end lifts the read-to-the-end gate before approving.
    await until(
      () => terminal!.screen(),
      (screen) => screen.includes('Approve once') && !screen.includes('Read to the end'),
    );
    await terminal.capture(join(ROOT, '.state/evidence/m11/screens/real-approval.svg'));
    await terminal.write('\x1b[C\r');
    const completed = await until(task, (t) => t.state === 'succeeded', 45000);
    expect(completed.verification.completion.fresh).toBe(true);
    expect(completed.steps.map((s: any) => s.id)).toEqual(result.step_ids);
    expect(completed.runtime.requests_spent).toBe(6);
    const finalWorkspace = await call<any>(socket, `/v1/sessions/${session.id}/workspace`);
    expect(readFileSync(join(finalWorkspace.root, 'math.js'), 'utf8')).toContain('a+b');
    expect(readFileSync(join(finalWorkspace.root, 'human.txt'), 'utf8')).toBe(
      'dirty work predating this task\n',
    );
    expect(readFileSync(join(source, 'math.js'), 'utf8')).toContain('a-b');
    await terminal.write('\x0b');
    await terminal.contains('Salaam · actions');
    await terminal.write('Session context\r');
    await terminal.contains('SUCCEEDED');
    await terminal.capture(join(ROOT, '.state/evidence/m11/screens/real-completed.svg'));
    await terminal.write('\x03');
    expect((await terminal.exit()).restored).toBe(true);
    terminal = undefined;
    const commands = await call<any[]>(socket, `/v1/sessions/${session.id}/commands`);
    expect(commands).toHaveLength(5);
    expect(commands.filter((r) => r.state === 'succeeded' && r.exit_code === 0)).toHaveLength(4);
    const artifacts = await call<any>(
      socket,
      `/v1/sessions/${session.id}/history?artifact_id=${completed.verification.completion.artifact_id}`,
    );
    expect(JSON.parse(artifacts.text).verified).toBe(true);
    result = {
      ...result,
      success: true,
      session_id: session.id,
      completed,
      completion_document: JSON.parse(artifacts.text),
      workspace: finalWorkspace,
      commands,
      provider_calls: 6,
      paid_provider_calls: 0,
      source_untouched: true,
      human_dirty_work_preserved: true,
      approval_decisions: (await call<any[]>(socket, `/v1/approvals?session=${session.id}`)).map(
        (a) => ({ id: a.id, operation_digest: a.operation_digest, decision: a.decision }),
      ),
      stderr,
    };
    const exit = once(child!, 'exit');
    await call(socket, '/v1/shutdown', {});
    await exit;
  } catch (error) {
    result.error = (error as Error).message;
    result.stderr = stderr;
    throw error;
  } finally {
    await terminal?.close();
    await kill();
    if (existsSync(join(state, 'journal.sqlite'))) {
      const db = new DatabaseSync(join(state, 'journal.sqlite'), { readOnly: true });
      const runs = db.prepare('SELECT id,profile_digest FROM command_runs').all();
      db.close();
      const backend = new DockerCodingExecutor(engineRequest(engineSocket));
      for (const row of runs) {
        backend.profileDigest = String(row.profile_digest);
        await backend.cleanup(String(row.id));
      }
      const rows = engineJson(
        await engineRequest(engineSocket)('GET', '/containers/json?all=1'),
      ) as any[];
      expect(
        rows.filter((r) => runs.some((run) => r.Labels?.['salaam.command.run'] === run.id)),
      ).toHaveLength(0);
      result.cleanup_confirmed = true;
    }
    writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n');
    if (result.cleanup_confirmed) {
      rmSync(state, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});
