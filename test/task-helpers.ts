import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SalaamService, type ServiceOptions } from '../src/service/service.js';
import type { ExecutionBackend } from '../src/coding/executor.js';
import type { WorkTask } from '../src/core/records.js';
import { call } from '../src/core/transport.js';
import { control, create, ready, until } from './helpers.js';
import { ServiceError } from '../src/core/protocol.js';

import { TaskFixtureBackend } from './fixtures/task-backend.mjs';
export { TaskFixtureBackend };
export const checkedPlan = (steps = 1) => ({
  objective: 'Inspect the fixture task',
  constraints: ['Preserve human changes'],
  steps: Array.from({ length: steps }, (_, i) => ({
    key: 'step-' + i,
    title: 'Step ' + i,
    instruction: 'Inspect fixture step ' + i,
    depends_on: i ? ['step-' + (i - 1)] : [],
    checks: ['tests'],
  })),
  acceptance: [{ key: 'tests', command: 'fixture-pass', cwd: '.' }],
  deliverables: ['app.js'],
});
export async function taskFixture(options: Partial<ServiceOptions> = {}) {
  const dir = mkdtempSync('/tmp/sal-m11-'),
    source = join(dir, 'source'),
    state = join(dir, 'state'),
    root = join(dir, 'owned');
  mkdirSync(source);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(join(source, 'app.js'), 'export const answer = 42;\n');
  writeFileSync(join(source, 'human.txt'), 'pre-existing dirty work\n');
  const backend = new TaskFixtureBackend();
  let service = await SalaamService.open({
    stateDir: state,
    codingRoot: root,
    codingBackend: backend,
    ...options,
  });
  const session = await call<{ id: string }>(service.socket, '/v1/sessions', {
    request_id: 'create',
    cwd: source,
    coding: true,
  });
  await ready(service, session.id);
  let actor = await control(service, session.id);
  const task = async () =>
    call<WorkTask & { runtime: any; verification: any }>(
      service.socket,
      `/v1/tasks?session_id=${session.id}`,
    );
  const action = async <T = any>(verb: string, body: Record<string, unknown> = {}, id?: string) => {
    const request = randomUUID();
    for (let attempt = 0; ; attempt++) {
      const current = await task();
      try {
        return await call<T>(service.socket, `/v1/tasks/${id ?? current.id}/${verb}`, {
          ...actor,
          request_id: request,
          expected_revision: current.revision,
          ...body,
        });
      } catch (error) {
        // Background worker receipts can advance the task between GET and POST.
        // Retry only an explicit pre-mutation revision rejection, never a lost
        // response or a caller-specified revision used by a conflict proof.
        if (
          !(error instanceof ServiceError) ||
          error.code !== 'task_revision_conflict' ||
          Object.hasOwn(body, 'expected_revision') ||
          attempt >= 3
        )
          throw error;
      }
    }
  };
  return {
    dir,
    source,
    state,
    root,
    backend,
    session,
    get service() {
      return service;
    },
    get actor() {
      return actor;
    },
    task,
    action,
    async plan(plan: unknown = checkedPlan()) {
      return call<WorkTask>(service.socket, '/v1/tasks', {
        ...actor,
        request_id: randomUUID(),
        session_id: session.id,
        expected_revision: 0,
        plan,
      });
    },
    async run(index = 0, instruction?: string) {
      const t = await task();
      return action(`steps/${t.steps[index]!.id}/run`, instruction ? { instruction } : {});
    },
    async settled(index = 0) {
      return until(task, (t) => t.steps[index]?.state === 'awaiting_review');
    },
    async review(index = 0) {
      const t = await task();
      return action(`steps/${t.steps[index]!.id}/complete`, {
        review: 'Operator inspected fixture result',
      });
    },
    async verify() {
      const r = await action<{ id: string }>('verify', { check_key: 'tests' });
      await until(
        () => service.taskVerification.get(r.id),
        (r) => ['passed', 'failed'].includes(r.state),
      );
      return service.taskVerification.get(r.id);
    },
    async restart() {
      await service.close();
      service = await SalaamService.open({
        stateDir: state,
        codingRoot: root,
        codingBackend: backend,
        ...options,
      });
      actor = await control(service, session.id);
    },
    async close() {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
