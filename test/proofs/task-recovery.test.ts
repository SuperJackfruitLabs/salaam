import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SalaamService } from '../../src/service.js';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';
import { acquireControl } from '../../src/attach.js';
import { until } from '../helpers.js';
import type { Controller, Session, SessionSnapshot } from '../../src/protocol.js';
import type { WorkTask } from '../../src/task-work.js';
import { OperatorClient } from '../../src/tui-client.js';
import { DocumentView } from '../../src/tui-view.js';
import { SalaamTheme } from '../../src/tui-theme.js';

const plan = {
  objective: 'Repair addition once',
  constraints: ['Keep the existing API'],
  steps: [
    { key: 'fix', title: 'Repair', instruction: 'Repair addition once', depends_on: [] },
    { key: 'check', title: 'Check', instruction: 'Check the repair once', depends_on: ['fix'] },
    {
      key: 'report',
      title: 'Report',
      instruction: 'Summarize the inspected result',
      depends_on: ['check'],
    },
  ],
};
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}
async function boot(dir: string, mode = 'active') {
  const child = spawn(
    process.execPath,
    [join(ROOT, 'test/fixtures/task-work-service.mjs'), dir, mode],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await once(child.stdout!, 'data');
  return child;
}
async function controller(socket: string, session: string): Promise<Controller> {
  const client_id = randomUUID(),
    lease = await acquireControl(socket, session, client_id);
  return { client_id, token: lease.token };
}
const task = (socket: string, id: string) => call<WorkTask>(socket, `/v1/tasks/${id}`);
const stepState = (socket: string, id: string, index: number, state: string) =>
  until(
    () => task(socket, id),
    (t) => t.steps[index]?.state === state,
  );
async function createTask(socket: string, session: string, c: Controller, uncapped = false) {
  return call<WorkTask>(socket, '/v1/tasks', {
    ...c,
    request_id: randomUUID(),
    session_id: session,
    expected_revision: 0,
    plan: { ...plan, ...(uncapped ? { limits: { token_units: null } } : {}) },
  });
}
async function run(socket: string, t: WorkTask, index: number, c: Controller, extra = {}) {
  return call<{ attempt_id: string }>(socket, `/v1/tasks/${t.id}/steps/${t.steps[index]!.id}/run`, {
    ...c,
    request_id: randomUUID(),
    expected_revision: t.revision,
    ...extra,
  });
}
const ready = (socket: string, id: string) =>
  until(
    () => call<Session>(socket, `/v1/sessions/${id}`),
    (s) => s.state === 'ready',
  );

for (const uncapped of [false, true])
  for (const boundary of ['worker', 'daemon'] as const)
    test(`${boundary} death preserves corrected plan and explicit continuation (token budget disabled: ${uncapped})`, async () => {
      const dir = mkdtempSync('/tmp/sal-task-recovery-'),
        socket = join(dir, 'operator.sock');
      let child: ChildProcess | undefined,
        service: SalaamService | undefined,
        observer: OperatorClient | undefined;
      try {
        if (boundary === 'daemon') child = await boot(dir);
        else
          service = await SalaamService.open({
            stateDir: dir,
            extensionPath: join(ROOT, 'test/fixtures/task-work-extension.mjs'),
          });
        const session = await call<Session>(socket, '/v1/sessions', {
          request_id: 'session',
          cwd: dir,
        });
        const initial = await ready(socket, session.id);
        let c = await controller(socket, session.id),
          t = await createTask(socket, session.id, c, uncapped);
        writeFileSync(join(dir, 'release-probe'), 'go');
        const first = await run(socket, t, 0, c);
        t = await stepState(socket, t.id, 0, 'awaiting_review');
        expect(t.state).toBe('blocked');
        t = await call<WorkTask>(socket, `/v1/tasks/${t.id}/steps/${t.steps[0]!.id}/complete`, {
          ...c,
          request_id: 'review-first',
          expected_revision: t.revision,
          review: 'Operator reviewed first result; verification remains pending',
        });
        const corrected = {
          ...plan,
          ...(uncapped ? { limits: { token_units: null } } : {}),
          objective: 'Repair addition once and preserve exports',
          constraints: ['Keep the existing API', 'Use the full offline suite'],
          steps: [
            plan.steps[0],
            { ...plan.steps[1], instruction: 'Run the full offline suite once' },
            plan.steps[2],
          ],
        };
        t = await call<WorkTask>(socket, `/v1/tasks/${t.id}/revise`, {
          ...c,
          request_id: 'correction',
          expected_revision: t.revision,
          plan: corrected,
        });
        const ids = t.steps.map((s) => s.id),
          taskId = t.id;
        unlinkSync(join(dir, 'release-probe'));
        unlinkSync(join(dir, 'probe-entered'));
        const second = await run(socket, t, 1, c);
        await until(() => existsSync(join(dir, 'probe-entered')), Boolean);
        if (boundary === 'daemon') {
          await kill(child!);
          service = await SalaamService.open({ stateDir: dir });
          c = await controller(socket, session.id);
        } else {
          const worker = service!.store.db
            .prepare('SELECT pid FROM workers WHERE session_id=? AND epoch=?')
            .get(session.id, initial.epoch) as { pid: number };
          process.kill(-worker.pid, 'SIGKILL');
        }
        t = await stepState(socket, taskId, 1, 'interrupted');
        expect(t.limits.token_units).toBe(uncapped ? null : 16777216);
        expect(t).toMatchObject({
          id: taskId,
          objective: corrected.objective,
          constraints: corrected.constraints,
          plan_revision: 2,
          state: 'blocked',
          steps: [
            { state: 'completed', attempt_id: first.attempt_id },
            {
              state: 'interrupted',
              attempt_id: second.attempt_id,
              instruction: corrected.steps[1]!.instruction,
            },
            { state: 'pending', attempt_id: null },
          ],
        });
        expect(t.steps.map((s) => s.id)).toEqual(ids);
        writeFileSync(join(dir, 'release-probe'), 'go');
        await call(socket, `/v1/sessions/${session.id}/resume`, c);
        const resumed = await ready(socket, session.id);
        expect(resumed.epoch).toBeGreaterThan(initial.epoch);
        expect(resumed.pi_session_file).toBe(initial.pi_session_file);
        expect(await service!.supervisor.dispatchNext(session.id)).toBe(false);
        expect(service!.store.attempt(second.attempt_id).state).toBe('interrupted');
        await expect(run(socket, t, 1, c)).rejects.toThrow('exact attempt');
        const continued = await run(socket, t, 1, c, {
          continues_attempt_id: second.attempt_id,
          instruction: 'Inspect the interrupted result and continue only the check',
        });
        t = await stepState(socket, taskId, 1, 'awaiting_review');
        expect(t.steps[0]!.state).toBe('completed');
        expect(t.steps[2]!.attempt_id).toBeNull();
        expect(service!.store.attempt(second.attempt_id)).toMatchObject({
          state: 'interrupted',
          resolved_by: continued.attempt_id,
        });
        const dispatches = service!.store
          .events(session.id, 0)
          .filter((e) => e.kind === 'attempt.dispatching')
          .map((e) => (e.payload as { attempt_id: string }).attempt_id);
        expect(dispatches).toEqual([first.attempt_id, second.attempt_id, continued.attempt_id]);
        const history = await call<{ plans: unknown[]; attempts: unknown[] }>(
          socket,
          `/v1/tasks/${taskId}/history`,
        );
        expect(history.plans).toHaveLength(2);
        expect(history.attempts).toHaveLength(3);
        observer = new OperatorClient(dir);
        await observer.open(session.id, { observe: true });
        expect(observer.snapshot?.work_task).toEqual(t);
        const rendered = new DocumentView({
          client: observer,
          theme: new SalaamTheme('night', false),
          tab: 'context',
          rows: () => 40,
          bodyRows: () => 30,
          diffOffset: 0,
          busy: false,
        })
          .render(100)
          .join('\n');
        expect(rendered).toContain('DURABLE TASK');
        expect(rendered).toContain('Run the full offline suite once');
        expect(rendered).toContain('completed');
        expect(service!.tasks.frame(session.id, 'binding')).toContain(corrected.objective);
        const payloads = readFileSync(join(dir, 'work-payloads.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(
          payloads.some(
            (payload) =>
              JSON.stringify(payload).includes(corrected.objective) &&
              JSON.stringify(payload).includes(ids[0]!) &&
              JSON.stringify(payload).includes('completed'),
          ),
        ).toBe(true);
      } finally {
        await observer?.close();
        if (child) await kill(child);
        await service?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

test('daemon death after acceptance preserves a single queued step and cached response, then dispatches once', async () => {
  const dir = mkdtempSync('/tmp/sal-task-queued-'),
    socket = join(dir, 'operator.sock');
  let child: ChildProcess | undefined, service: SalaamService | undefined;
  try {
    child = await boot(dir, 'queued');
    const session = await call<Session>(socket, '/v1/sessions', {
      request_id: 'session',
      cwd: dir,
    });
    await ready(socket, session.id);
    const c = await controller(socket, session.id),
      t = await createTask(socket, session.id, c);
    const body = { ...c, request_id: 'run-once', expected_revision: t.revision };
    const path = `/v1/tasks/${t.id}/steps/${t.steps[0]!.id}/run`;
    const accepted = await call<{ attempt_id: string }>(socket, path, body);
    expect((await task(socket, t.id)).steps[0]!.state).toBe('queued');
    await kill(child);
    service = await SalaamService.open({ stateDir: dir });
    // Cached admission wins over the revoked controller and stale task revision.
    expect(await call(socket, path, body)).toEqual(accepted);
    const next = await controller(socket, session.id);
    await call(socket, `/v1/sessions/${session.id}/resume`, next);
    await ready(socket, session.id);
    const settled = await stepState(socket, t.id, 0, 'awaiting_review');
    expect(settled.steps[0]!.attempt_id).toBe(accepted.attempt_id);
    expect(settled.steps[1]!.attempt_id).toBeNull();
    expect(service.store.snapshot(session.id).attempts).toHaveLength(1);
    expect(
      service.store.events(session.id, 0).filter((e) => e.kind === 'attempt.dispatching'),
    ).toHaveLength(1);
    await service.close();
    service = await SalaamService.open({ stateDir: dir });
    expect(await task(socket, t.id)).toEqual(settled);
    expect(service.store.snapshot(session.id).attempts).toHaveLength(1);
  } finally {
    if (child) await kill(child);
    await service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI creates, inspects, revises and explicitly reviews tasks from outside the checkout', async () => {
  const dir = mkdtempSync('/tmp/sal-task-cli-');
  const service = await SalaamService.open({ stateDir: dir });
  const exec = promisify(execFile);
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [join(ROOT, 'bin/salaam.mjs'), 'tasks', ...args, '--state', dir],
          { cwd: dir, timeout: 10000 },
        )
      ).stdout,
    );
  try {
    const session = await call<Session>(service.socket, '/v1/sessions', {
      request_id: 'session',
      cwd: dir,
    });
    await ready(service.socket, session.id);
    const file = join(dir, 'plan.json');
    writeFileSync(file, JSON.stringify(plan));
    let t = (await cli(
      'create',
      session.id,
      '--plan',
      file,
      '--revision',
      '0',
      '--request-id',
      'create-task',
    )) as WorkTask;
    expect(
      await cli(
        'create',
        session.id,
        '--plan',
        file,
        '--revision',
        '0',
        '--request-id',
        'create-task',
      ),
    ).toEqual(t);
    expect(await cli('current', session.id)).toEqual(t);
    const corrected = { ...plan, objective: 'Repair with the CLI' };
    writeFileSync(file, JSON.stringify(corrected));
    t = await cli('revise', t.id, '--plan', file, '--revision', String(t.revision));
    await cli('run', t.id, '--step', t.steps[0]!.id, '--revision', String(t.revision));
    t = await stepState(service.socket, t.id, 0, 'awaiting_review');
    t = await cli(
      'complete',
      t.id,
      '--step',
      t.steps[0]!.id,
      '--revision',
      String(t.revision),
      '--review',
      'Inspected offline result',
    );
    expect(t.steps[0]!.state).toBe('completed');
    expect(t.steps[1]!.attempt_id).toBeNull();
    expect((await cli('history', t.id)).plans).toHaveLength(2);
    expect(await cli('inspect', t.id)).toEqual(t);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pi completion before daemon death cannot invent step completion or automatically replay work', async () => {
  const dir = mkdtempSync('/tmp/sal-task-gap-'),
    socket = join(dir, 'operator.sock');
  let child: ChildProcess | undefined, service: SalaamService | undefined;
  try {
    writeFileSync(join(dir, 'release-probe'), 'go');
    child = await boot(dir, 'completion-gap');
    const session = await call<Session>(socket, '/v1/sessions', {
      request_id: 'session',
      cwd: dir,
    });
    await ready(socket, session.id);
    const c = await controller(socket, session.id),
      t = await createTask(socket, session.id, c);
    const accepted = await run(socket, t, 0, c);
    await until(() => existsSync(join(dir, 'completion-pending')), Boolean);
    await kill(child);
    service = await SalaamService.open({ stateDir: dir });
    const recovered = await task(socket, t.id);
    expect(recovered).toMatchObject({
      state: 'blocked',
      steps: [
        { id: t.steps[0]!.id, state: 'interrupted', attempt_id: accepted.attempt_id },
        { state: 'pending' },
        { state: 'pending' },
      ],
    });
    expect(service.store.attempt(accepted.attempt_id)).toMatchObject({
      state: 'interrupted',
      result: null,
    });
    expect(service.store.events(session.id, 0).some((e) => e.kind === 'attempt.completed')).toBe(
      false,
    );
    const next = await controller(socket, session.id);
    await call(socket, `/v1/sessions/${session.id}/resume`, next);
    await ready(socket, session.id);
    expect(await service.supervisor.dispatchNext(session.id)).toBe(false);
    const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${session.id}/snapshot`);
    expect(snapshot.work_task).toEqual(recovered);
    expect(snapshot.attempts).toHaveLength(1);
  } finally {
    if (child) await kill(child);
    await service?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
