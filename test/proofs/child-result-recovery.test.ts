import { describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, create, ready, until, control } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { ROOT } from '../../src/config.js';
import { PiProcess } from '../../src/pi.js';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import type { ChildTask, Session } from '../../src/protocol.js';

const extensionPath = join(ROOT, 'test/fixtures/child-extension.mjs');
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}
async function killWorker(service: SalaamService, id: string) {
  const row = service.store.db
    .prepare('SELECT pid FROM workers WHERE session_id=? ORDER BY epoch DESC LIMIT 1')
    .get(id) as { pid: number };
  process.kill(-row.pid, 'SIGKILL');
  await until(
    () =>
      service.store.db
        .prepare('SELECT state FROM workers WHERE session_id=? ORDER BY epoch DESC LIMIT 1')
        .get(id),
    (row) => row?.state === 'exited',
  );
}
async function continueParent(service: SalaamService, id: string, attempt: string, text: string) {
  if (service.supervisor.inspect(id).state !== 'ready') await service.supervisor.start(id);
  const lease = await control(service, id, true);
  return service.store.accept(
    id,
    randomUUID(),
    service.store.session(id).revision,
    text,
    lease,
    attempt,
  );
}

const repetitions = Number(process.env.SALAAM_CHILD_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Invalid child proof repetition count');
describe.each(Array.from({ length: repetitions }, (_, i) => i + 1))('S4 run %s', () => {
  test('S4: parent death preserves independent children and redelivers one stable result until acknowledgment', async () => {
    const f = await fixture({ extensionPath });
    try {
      const parent = await create(f.service, f.dir);
      await ready(f.service, parent.id);
      const work = await submit(f.service, parent.id, '[children] first,second');
      const children = await until(
        () => f.service.children.list(parent.id),
        (rows) => rows.length === 2,
      );
      const [first, second] = children as [ChildTask, ChildTask];
      await until(
        () => children.every((c) => existsSync(join(f.dir, 'child-' + c.child_session))),
        Boolean,
      );
      writeFileSync(join(f.dir, 'release-child-' + first.child_session), 'go');
      const completed = await until(
        () => f.service.children.inspect(parent.id, first.id),
        (x) => x.state === 'completed',
      );
      expect(completed.result_id).toBeTruthy();
      const original = await call(f.service.socket, `/v1/children/${first.id}/result`);
      await killWorker(f.service, parent.id);
      expect(f.service.store.attempt(work.attempt_id).state).toBe('interrupted');
      expect(f.service.supervisor.inspect(second.child_session).state).toBe('ready');
      writeFileSync(join(f.dir, 'release-child-' + second.child_session), 'go');
      await until(
        () => f.service.children.inspect(parent.id, second.id),
        (x) => x.state === 'completed',
      );
      const resumed = await continueParent(f.service, parent.id, work.attempt_id, '[inbox]');
      await until(
        () => f.service.store.attempt(resumed.attempt_id),
        (x) => x.state === 'completed',
      );
      const inboxEntries = f.service.store.db
        .prepare('SELECT payload FROM pi_entries WHERE session_id=?')
        .all(parent.id)
        .map((row) => JSON.parse(String(row.payload)));
      expect(
        inboxEntries.some(
          (entry) =>
            entry.message?.role === 'toolResult' &&
            entry.message.toolName === 'inspect_child' &&
            JSON.stringify(entry).includes(completed.result_id!),
        ),
      ).toBe(true);
      // Same step keys from the replacement worker find the original tasks, with no new sessions.
      const duplicate = await submit(f.service, parent.id, '[children] first,second');
      await until(
        () => f.service.store.attempt(duplicate.attempt_id),
        (x) => x.state === 'completed',
      );
      expect(f.service.children.list(parent.id)).toHaveLength(2);
      const delivery = await submit(
        f.service,
        parent.id,
        `[consume] ${first.id} ${completed.result_id}`,
      );
      await until(() => existsSync(join(f.dir, 'delivered-' + completed.result_id)), Boolean);
      expect(f.service.children.inspect(parent.id, first.id).acknowledged).toBe(0);
      await killWorker(f.service, parent.id);
      expect(await call(f.service.socket, `/v1/children/${first.id}/result`)).toEqual(original);
      const ack = await continueParent(
        f.service,
        parent.id,
        delivery.attempt_id,
        `[consume] ${first.id} ${completed.result_id} ack`,
      );
      await until(
        () => f.service.store.attempt(ack.attempt_id),
        (x) => x.state === 'completed',
      );
      const body = { request_id: 'ack-retry', result_id: completed.result_id };
      const receipt = await call(f.service.socket, `/v1/children/${first.id}/ack`, body);
      expect(await call(f.service.socket, `/v1/children/${first.id}/ack`, body)).toEqual(receipt);
      expect(f.service.children.inspect(parent.id, first.id).result_id).toBe(completed.result_id);
      expect(f.service.store.db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({
        n: 3,
      });
      // Request receipts and Pi entries describe the same leaf execution, not two charges.
      const summary = f.service.store.usage.summary(parent.id);
      for (const child of children) {
        const entries = f.service.store.db
          .prepare('SELECT payload FROM pi_entries WHERE session_id=?')
          .all(child.child_session)
          .map((x) => JSON.parse(String(x.payload)));
        f.service.store.importEntries(
          child.child_session,
          f.service.store.session(child.child_session).epoch,
          entries,
          f.service.store.session(child.child_session).pi_leaf,
        );
      }
      expect(f.service.store.usage.summary(parent.id)).toEqual(summary);
      expect(summary).toMatchObject({ unknown_observations: 0 });
    } finally {
      await f.close();
    }
  });

  test('S4: service death retains completed artifacts and interrupts unfinished children without rerunning', async () => {
    const dir = mkdtempSync('/tmp/sal-s4-');
    const processChild = spawn(
      process.execPath,
      [join(ROOT, 'test/fixtures/child-service.mjs'), dir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let replacement: SalaamService | undefined;
    try {
      await once(processChild.stdout!, 'data');
      const socket = join(dir, 'operator.sock');
      const parent = await call<Session>(socket, '/v1/sessions', {
        request_id: 'parent',
        cwd: dir,
      });
      await until(
        () => call<Session>(socket, `/v1/sessions/${parent.id}`),
        (x) => x.state === 'ready',
      );
      const lease = await call<{ token: string; epoch: number }>(
        socket,
        `/v1/sessions/${parent.id}/control`,
        { request_id: 'control', client_id: 'test', action: 'acquire', expected_epoch: 0 },
      );
      const current = await call<Session>(socket, `/v1/sessions/${parent.id}`);
      await call(socket, `/v1/sessions/${parent.id}/submissions`, {
        request_id: 'spawn',
        client_id: 'test',
        token: lease.token,
        expected_revision: current.revision,
        text: '[children] first,second',
      });
      const children = await until(
        () => call<ChildTask[]>(socket, `/v1/sessions/${parent.id}/children`),
        (rows) => rows.length === 2,
      );
      await until(
        () => children.every((c) => existsSync(join(dir, 'child-' + c.child_session))),
        Boolean,
      );
      writeFileSync(join(dir, 'release-child-' + children[0]!.child_session), 'go');
      const first = await until(
        () => call<ChildTask>(socket, `/v1/children/${children[0]!.id}`),
        (x) => x.state === 'completed',
      );
      const result = await call(socket, `/v1/children/${first.id}/result`);
      await stop(processChild);
      replacement = await SalaamService.open({ stateDir: dir, extensionPath });
      expect(await call(replacement.socket, `/v1/children/${first.id}/result`)).toEqual(result);
      const second = replacement.children.inspect(parent.id, children[1]!.id);
      expect(second.state).toBe('interrupted');
      expect(second.result_id).toBeTruthy();
      expect(replacement.store.session(second.child_session).epoch).toBe(1);
      expect(replacement.store.db.prepare('SELECT count(*) AS n FROM attempts').get()).toEqual({
        n: 3,
      });
      expect(replacement.children.inspect(parent.id, first.id).acknowledged).toBe(0);
    } finally {
      await stop(processChild);
      await replacement?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('S4: cancelling a parent durably cancels owned children and leaves unrelated sessions alive', async () => {
    const f = await fixture({ extensionPath });
    try {
      const parent = await create(f.service, f.dir);
      await ready(f.service, parent.id);
      const other = await create(f.service, f.dir, 'other');
      await ready(f.service, other.id);
      const work = await submit(f.service, parent.id, '[children] first,second');
      const children = await until(
        () => f.service.children.list(parent.id),
        (rows) => rows.length === 2,
      );
      await until(
        () => children.every((c) => existsSync(join(f.dir, 'child-' + c.child_session))),
        Boolean,
      );
      const controller = await control(f.service, parent.id, true);
      await call(f.service.socket, `/v1/attempts/${work.attempt_id}/cancel`, {
        ...controller,
        request_id: 'cancel',
        expected_revision: f.service.store.session(parent.id).revision,
      });
      await until(
        () => f.service.children.list(parent.id),
        (rows) => rows.every((c) => c.state === 'cancelled'),
      );
      await until(
        () => f.service.store.attempt(work.attempt_id),
        (x) => x.state === 'cancelled',
      );
      expect(f.service.supervisor.inspect(other.id).state).toBe('ready');
      expect(children.every((c) => f.service.store.cancelled(c.child_attempt))).toBe(true);
    } finally {
      await f.close();
    }
  });

  test('S4: service death before provider usage receipt leaves an explicit unknown amount', async () => {
    const dir = mkdtempSync('/tmp/sal-s4-usage-');
    const child = spawn(
      process.execPath,
      [join(ROOT, 'test/fixtures/child-service.mjs'), dir, '--before-usage'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let replacement: SalaamService | undefined;
    try {
      await once(child.stdout!, 'data');
      const socket = join(dir, 'operator.sock');
      const parent = await call<Session>(socket, '/v1/sessions', {
        request_id: 'parent',
        cwd: dir,
      });
      await until(
        () => call<Session>(socket, `/v1/sessions/${parent.id}`),
        (x) => x.state === 'ready',
      );
      const lease = await call<{ token: string }>(socket, `/v1/sessions/${parent.id}/control`, {
        request_id: 'lease',
        client_id: 'test',
        action: 'acquire',
        expected_epoch: 0,
      });
      const current = await call<Session>(socket, `/v1/sessions/${parent.id}`);
      await call(socket, `/v1/sessions/${parent.id}/submissions`, {
        request_id: 'spawn',
        client_id: 'test',
        token: lease.token,
        expected_revision: current.revision,
        text: '[children] first,second',
      });
      await until(() => existsSync(join(dir, 'usage-pending')), Boolean);
      await stop(child);
      replacement = await SalaamService.open({ stateDir: dir });
      const summary = replacement.store.usage.summary(parent.id) as {
        unknown_observations: number;
      };
      expect(summary.unknown_observations).toBeGreaterThan(0);
      expect(replacement.children.list(parent.id).every((x) => x.state === 'interrupted')).toBe(
        true,
      );
      const unknown = replacement.store.db
        .prepare("SELECT * FROM usage_observations WHERE status='unknown'")
        .all();
      expect(
        unknown.every((row) => row.input === null && row.output === null && row.cost === null),
      ).toBe(true);
      const before = replacement.store.usage.summary(parent.id);
      await replacement.close();
      replacement = await SalaamService.open({ stateDir: dir });
      expect(replacement.store.usage.summary(parent.id)).toEqual(before);
    } finally {
      await stop(child);
      await replacement?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('S4: a child cannot increase depth or invoke the effect bridge even when its parent has a connector', async () => {
    const configs = new Map<string, Record<string, unknown>>();
    let preflights = 0;
    const f = await fixture({
      extensionPath,
      effectConnector: {
        id: 'unreachable-test-connector',
        replay: 'opaque',
        version: async () => {
          preflights++;
          return 'v1';
        },
        dispatch: async () => {
          throw new Error('No child effect may dispatch');
        },
      },
      launch: (launch) => {
        const config = JSON.parse(launch.env.SALAAM_WORKER_CONFIG!);
        configs.set(config.session, config);
        return new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
      },
    });
    try {
      const parent = await create(f.service, f.dir);
      await ready(f.service, parent.id);
      await submit(f.service, parent.id, '[children] first,second');
      const children = await until(
        () => f.service.children.list(parent.id),
        (rows) => rows.length === 2,
      );
      const child = children[0]!;
      await until(() => existsSync(join(f.dir, 'child-' + child.child_session)), Boolean);
      const config = configs.get(child.child_session)!;
      await expect(
        call(
          f.service.bridgeSocket,
          `/worker/${child.child_session}/child.spawn`,
          {
            epoch: config.epoch,
            step_key: 'grandchild',
            prompt: 'read',
            budget: 1,
            authority: ['salaam_probe'],
          },
          String(config.token),
        ),
      ).rejects.toThrow('depth');
      expect(f.service.supervisor.inspect(child.child_session).state).toBe('ready');
      await expect(
        call(
          f.service.bridgeSocket,
          `/worker/${child.child_session}/operation.prepare`,
          {
            epoch: config.epoch,
            tool_call_id: 'bypass',
            kind: 'effect',
            target: 'forbidden',
            value: 'x',
          },
          String(config.token),
        ),
      ).rejects.toThrow('control unavailable');
      expect(f.service.supervisor.inspect(child.child_session).state).toBe('unhealthy');
      expect(preflights).toBe(0);
      expect(f.service.store.db.prepare('SELECT count(*) AS n FROM operations').get()).toEqual({
        n: 0,
      });
    } finally {
      await f.close();
    }
  });
});
