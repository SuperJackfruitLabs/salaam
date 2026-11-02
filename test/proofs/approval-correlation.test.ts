import { describe, expect, test } from 'vitest';
import { fixture, create, ready, until } from '../helpers.js';
import { submit, decide, effectFixture } from '../managed-helpers.js';
import { call } from '../../src/core/transport.js';
import type { Approval, SessionSnapshot } from '../../src/core/protocol.js';
import { PiProcess } from '../../src/runtime/pi.js';
import { SalaamService } from '../../src/service/service.js';
import { Outbox } from '../../src/tui/attach.js';
import { createServer, request } from 'node:http';
import { join } from 'node:path';

const repetitions = Number(process.env.SALAAM_MANAGED_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Invalid managed proof repetition count');
describe.each(Array.from({ length: repetitions }, (_, index) => index + 1))(
  'S2 approval run %s',
  () => {
    test('S2: concurrent real-Pi approvals survive client loss and route reverse decisions by exact binding', async () => {
      const external = await effectFixture();
      const f = await fixture({ effectConnector: external.connector });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] alpha,beta');
        const approvals = await until(
          () => f.service.store.approvals(session.id),
          (items) => items.length === 2,
        );
        await until(
          () =>
            f.service.store.db
              .prepare("SELECT count(*) AS n FROM approval_dialogs WHERE state='pending'")
              .get() as { n: number },
          (row) => row.n === 2,
        );
        const snapshot = await call<SessionSnapshot>(
          f.service.socket,
          `/v1/sessions/${session.id}/snapshot`,
        );
        expect(snapshot.approvals.filter((a) => a.state === 'pending')).toHaveLength(2);
        const a = approvals.find(
          (approval) => f.service.managed.operation(approval.operation_id).target === 'alpha',
        )!;
        const b = approvals.find((approval) => approval.id !== a.id)!;
        await expect(
          call(f.service.socket, `/v1/approvals/${a.id}/decision`, {
            request_id: 'wrong-digest',
            expected_revision: a.revision,
            operation_digest: b.operation_digest,
            decision: 'approve',
          }),
        ).rejects.toThrow('bound operation');
        const accepted = await decide(f.service, b, 'approve', 'B');
        expect(await decide(f.service, b, 'approve', 'B')).toEqual(accepted);
        await expect(decide(f.service, b, 'deny', 'B')).rejects.toThrow('different input');
        await expect(decide(f.service, b, 'approve', 'new-B')).rejects.toThrow('no longer pending');
        await decide(f.service, a, 'deny', 'A');
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(f.service.managed.operation(a.operation_id).state).toBe('cancelled_before_dispatch');
        expect(f.service.managed.operation(b.operation_id).state).toBe('succeeded');
        expect(await call(external.socket, '/stats')).toMatchObject({
          count: 1,
          posts: 1,
          effects: [{ payload: { target: 'beta' } }],
        });
        const dialogs = f.service.store.db.prepare('SELECT * FROM approval_dialogs').all();
        expect(new Set(dialogs.map((row) => row.pi_request_id)).size).toBe(2);
      } finally {
        await f.close();
        await external.close();
      }
    });

    test('two sessions keep approval decisions isolated and an expired request cannot dispatch', async () => {
      const f = await fixture({ approvalTtlMs: 1500 });
      try {
        const one = await create(f.service, f.dir, 'one');
        const two = await create(f.service, f.dir, 'two');
        await ready(f.service, one.id);
        await ready(f.service, two.id);
        const first = await submit(f.service, one.id, '[review] same-label');
        const second = await submit(f.service, two.id, '[review] same-label');
        const a = await until(() => f.service.store.approvals(one.id)[0], Boolean);
        const b = await until(() => f.service.store.approvals(two.id)[0], Boolean);
        await decide(f.service, b!, 'approve');
        await until(
          () => f.service.store.attempt(second.attempt_id).state,
          (state) => state === 'completed',
        );
        await until(
          () => f.service.managed.approval(a!.id).state,
          (state) => state === 'expired',
        );
        await expect(decide(f.service, a!, 'approve')).rejects.toThrow('no longer pending');
        await until(
          () => f.service.store.attempt(first.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(f.service.managed.operation(a!.operation_id).state).toBe(
          'cancelled_before_dispatch',
        );
        expect(f.service.managed.operation(b!.operation_id).state).toBe('succeeded');
      } finally {
        await f.close();
      }
    });

    test('real Pi UI compatibility: unsolicited confirm replies cannot authorize the durable operation', async () => {
      const ui: string[] = [];
      const f = await fixture({
        launch: (launch) => {
          const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
          pi.on('record', (record) => {
            if (record.type === 'extension_ui_request' && record.method === 'confirm') {
              ui.push(String(record.id));
              pi.replyUI(String(record.id), true);
            }
          });
          return pi;
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const started = new Set<string>();
        const start = f.service.managed.start.bind(f.service.managed);
        f.service.managed.start = (...args) => {
          started.add(args[0]);
          return start(...args);
        };
        const work = await submit(f.service, session.id, '[review] same,same');
        await until(
          () => started.size,
          (n) => n === 2,
        );
        expect(new Set(ui).size).toBe(2);
        const approvals = f.service.store.approvals(session.id);
        expect(approvals.every((a) => a.state === 'pending')).toBe(true);
        expect(f.service.store.operations(session.id).every((op) => op.state === 'prepared')).toBe(
          true,
        );
        await decide(f.service, approvals[0]!, 'approve');
        await decide(f.service, approvals[1]!, 'deny');
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(
          f.service.store.operations(session.id).filter((op) => op.state === 'succeeded'),
        ).toHaveLength(1);
      } finally {
        await f.close();
      }
    });

    test('worker replacement invalidates old approvals and dialogs; continuation needs a new approval', async () => {
      const f = await fixture();
      let replacement: SalaamService | undefined;
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[review] original');
        const old = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        await f.service.close();
        replacement = await SalaamService.open({ stateDir: f.dir });
        expect(replacement.managed.approval(old!.id).state).toBe('invalidated');
        await expect(decide(replacement, old!, 'approve')).rejects.toThrow('no longer pending');
        const controller = await import('../helpers.js').then((module) =>
          module.control(replacement!, session.id),
        );
        const next = replacement.store.accept(
          session.id,
          'new-instruction',
          replacement.store.session(session.id).revision,
          '[review] original',
          controller,
          work.attempt_id,
        );
        await replacement.supervisor.start(session.id);
        const approval = await until(
          () => replacement!.store.approvals(session.id).find((a) => a.state === 'pending'),
          Boolean,
        );
        expect(approval!.id).not.toBe(old!.id);
        expect(approval!.worker_epoch).toBeGreaterThan(old!.worker_epoch);
        expect(() =>
          replacement!.managed.bindDialog(
            session.id,
            old!.worker_epoch,
            old!.id,
            old!.operation_digest,
            'old-dialog',
          ),
        ).toThrow('owns this invocation');
        await decide(replacement, approval!, 'approve');
        await until(
          () => replacement!.store.attempt(next.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(replacement.managed.operation(old!.operation_id).state).toBe(
          'cancelled_before_dispatch',
        );
      } finally {
        await replacement?.close();
        await f.close();
      }
    });

    test('a changed target cannot reuse the tool invocation or its earlier approval', async () => {
      let config: Record<string, unknown> = {};
      const f = await fixture({
        launch: (launch) => {
          config = JSON.parse(launch.env.SALAAM_WORKER_CONFIG!);
          return new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        await submit(f.service, session.id, '[review] first-target');
        const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        const op = f.service.managed.operation(approval!.operation_id);
        await expect(
          call(
            f.service.bridgeSocket,
            `/worker/${session.id}/operation.prepare`,
            {
              epoch: config.epoch,
              kind: 'review',
              tool_call_id: op.tool_call_id,
              target: 'changed-target',
              value: op.value,
            },
            String(config.token),
          ),
        ).rejects.toThrow('control unavailable');
        expect(f.service.managed.operation(op.id)).toMatchObject({
          target: 'first-target',
          state: 'cancelled_before_dispatch',
        });
        await expect(decide(f.service, approval!, 'approve')).rejects.toThrow('no longer pending');
      } finally {
        await f.close();
      }
    });

    test('a lost decision response is retried from the durable command outbox without another operation', async () => {
      const f = await fixture();
      let drop = true;
      const proxy = createServer((incoming, outgoing) => {
        const upstream = request(
          {
            socketPath: f.service.socket,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
            agent: false,
          },
          (response) => {
            if (drop && incoming.url?.endsWith('/decision')) {
              drop = false;
              response.resume();
              response.on('end', () => outgoing.destroy());
            } else {
              outgoing.writeHead(response.statusCode!);
              response.pipe(outgoing);
            }
          },
        );
        upstream.on('error', () => outgoing.destroy());
        incoming.pipe(upstream);
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[review] durable-decision');
        const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        const outbox = new Outbox(f.dir, session.id);
        const pending = outbox.enqueueDecision(
          approval!.id,
          approval!.operation_digest,
          approval!.revision,
          'approve',
        );
        await new Promise<void>((resolve) => proxy.listen(join(f.dir, 'decision.sock'), resolve));
        await expect(outbox.flush(join(f.dir, 'decision.sock'), session.id)).rejects.toThrow();
        expect(outbox.records()).toEqual([pending]);
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'completed',
        );
        await new Outbox(f.dir, session.id).flush(f.service.socket, session.id);
        expect(outbox.records()).toHaveLength(0);
        expect(f.service.store.operations(session.id)).toHaveLength(1);
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await f.close();
      }
    });
  },
);
