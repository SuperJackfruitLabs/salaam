import { describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../../src/config.js';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import { acquireControl, Outbox } from '../../src/attach.js';
import type { Session, SessionSnapshot, Approval, Operation } from '../../src/protocol.js';
import { effectFixture, submit, decide } from '../managed-helpers.js';
import { fixture, create, ready, until } from '../helpers.js';
import { PiProcess } from '../../src/pi.js';

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}
async function remoteSubmit(socket: string, session: string, text: string) {
  const lease = await acquireControl(socket, session, 'remote');
  const controller = { client_id: 'remote', token: lease.token };
  const snapshot = await call<Session>(socket, `/v1/sessions/${session}`);
  return call<{ attempt_id: string }>(socket, `/v1/sessions/${session}/submissions`, {
    ...controller,
    request_id: randomUUID(),
    expected_revision: snapshot.revision,
    text,
  });
}
async function remoteApproval(socket: string, session: string) {
  const rows = await until(
    () => call<Approval[]>(socket, `/v1/approvals?session=${session}`),
    (rows) => rows.length === 1,
  );
  const approval = rows[0]!;
  await call(socket, `/v1/approvals/${approval.id}/decision`, {
    request_id: randomUUID(),
    expected_revision: approval.revision,
    operation_digest: approval.operation_digest,
    decision: 'approve',
  });
  return approval;
}

const repetitions = Number(process.env.SALAAM_MANAGED_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Invalid managed proof repetition count');
describe.each(Array.from({ length: repetitions }, (_, index) => index + 1))(
  'S3 effect run %s',
  () => {
    test.each(['external-acceptance', 'before-receipt-commit'])(
      'S3: service death at %s reconciles one external receipt without resending',
      async (barrier) => {
        const external = await effectFixture();
        const dir = mkdtempSync('/tmp/sal-s3-');
        if (barrier === 'external-acceptance')
          writeFileSync(join(external.dir, 'hold-response'), 'hold');
        const child = spawn(
          process.execPath,
          [
            join(ROOT, 'test/fixtures/managed-service.mjs'),
            dir,
            external.socket,
            ...(barrier === 'before-receipt-commit' ? ['--before-receipt'] : []),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let replacement: SalaamService | undefined;
        try {
          await once(child.stdout!, 'data');
          const socket = join(dir, 'operator.sock');
          const session = await call<Session>(socket, '/v1/sessions', {
            request_id: 'create',
            cwd: dir,
          });
          await until(
            () => call<Session>(socket, `/v1/sessions/${session.id}`),
            (state) => state.state === 'ready',
          );
          const work = await remoteSubmit(socket, session.id, '[effect] target');
          const approval = await remoteApproval(socket, session.id);
          await until(
            () =>
              existsSync(
                join(
                  barrier === 'external-acceptance' ? external.dir : dir,
                  barrier === 'external-acceptance' ? 'accepted' : 'receipt-pending',
                ),
              ),
            Boolean,
          );
          await kill(child);
          replacement = await SalaamService.open({
            stateDir: dir,
            effectConnector: external.connector,
          });
          const op = replacement.managed.operation(approval.operation_id);
          expect(op.state).toBe('succeeded');
          expect(JSON.parse(op.receipt!)).toMatchObject({
            id: op.action_key,
            payload: { target: 'target' },
          });
          expect(replacement.store.attempt(work.attempt_id).state).toBe('interrupted');
          expect(await call(external.socket, '/stats')).toMatchObject({ count: 1, posts: 1 });
          const observation = { request_id: 'reconcile-retry' };
          const observed = await call(
            replacement.socket,
            `/v1/operations/${op.id}/reconcile`,
            observation,
          );
          expect(
            await call(replacement.socket, `/v1/operations/${op.id}/reconcile`, observation),
          ).toEqual(observed);
          expect(await call(external.socket, '/stats')).toMatchObject({ count: 1, posts: 1 });
        } finally {
          await kill(child);
          await replacement?.close();
          await external.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test.each(['unavailable', 'opaque', 'negative-lookup', 'mismatched-receipt'])(
      'unknown effect stays blocked after recovery with %s',
      async (mode) => {
        const external = await effectFixture(mode === 'opaque');
        const dir = mkdtempSync('/tmp/sal-unknown-');
        writeFileSync(
          join(external.dir, mode === 'negative-lookup' ? 'hold-before-accept' : 'hold-response'),
          'hold',
        );
        if (mode === 'unavailable') writeFileSync(join(external.dir, 'lookup-unavailable'), 'hold');
        if (mode === 'mismatched-receipt')
          writeFileSync(join(external.dir, 'tamper-lookup'), 'tamper');
        const child = spawn(
          process.execPath,
          [
            join(ROOT, 'test/fixtures/managed-service.mjs'),
            dir,
            external.socket,
            ...(mode === 'opaque' ? ['--opaque'] : []),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let replacement: SalaamService | undefined;
        try {
          await once(child.stdout!, 'data');
          const socket = join(dir, 'operator.sock');
          const session = await call<Session>(socket, '/v1/sessions', {
            request_id: 'create',
            cwd: dir,
          });
          await until(
            () => call<Session>(socket, `/v1/sessions/${session.id}`),
            (state) => state.state === 'ready',
          );
          await remoteSubmit(socket, session.id, '[effect] unknown-target');
          const approval = await remoteApproval(socket, session.id);
          await until(
            () =>
              existsSync(
                join(external.dir, mode === 'negative-lookup' ? 'before-accept' : 'accepted'),
              ),
            Boolean,
          );
          await kill(child);
          replacement = await SalaamService.open({
            stateDir: dir,
            effectConnector: external.connector,
          });
          let op = replacement.managed.operation(approval.operation_id);
          expect(op.state).toBe('outcome_unknown');
          await replacement.supervisor.start(session.id);
          expect(await replacement.supervisor.dispatchNext(session.id)).toBe(false);
          await replacement.managed.reconcile(op.id);
          expect(replacement.managed.operation(op.id).state).toBe('outcome_unknown');
          expect(await call(external.socket, '/stats')).toMatchObject({
            posts: 1,
            count: mode === 'negative-lookup' ? 0 : 1,
          });
          if (mode === 'opaque') {
            const body = {
              request_id: 'operator-resolution',
              expected_revision: op.revision,
              operation_digest: op.operation_digest,
              outcome: 'succeeded',
              evidence: 'Operator inspected the independent external receipt out of band',
            };
            const resolved = await call<Operation>(
              replacement.socket,
              `/v1/operations/${op.id}/resolution`,
              body,
            );
            expect(resolved.resolution).toContain('operator-attestation');
            expect(
              await call(replacement.socket, `/v1/operations/${op.id}/resolution`, body),
            ).toEqual(resolved);
            expect(await call(external.socket, '/stats')).toMatchObject({ posts: 1, lookups: 0 });
          } else {
            if (mode === 'unavailable') unlinkSync(join(external.dir, 'lookup-unavailable'));
            if (mode === 'mismatched-receipt') unlinkSync(join(external.dir, 'tamper-lookup'));
            if (mode === 'negative-lookup') {
              unlinkSync(join(external.dir, 'hold-before-accept'));
              await call(external.socket, '/release-all', {});
            }
            op = await replacement.managed.reconcile(op.id);
            expect(op.state).toBe('succeeded');
            expect(await call(external.socket, '/stats')).toMatchObject({ posts: 1, count: 1 });
          }
        } finally {
          await kill(child);
          await replacement?.close();
          await external.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );

    test('a version change after human approval is rejected by the external conditional write', async () => {
      const external = await effectFixture();
      // Deliberately stale preflight: only the external If-Match can close this gap.
      const connector = Object.create(external.connector) as typeof external.connector;
      connector.version = async () => '1';
      const f = await fixture({ effectConnector: connector });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] versioned');
        const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        await call(external.socket, '/targets/versioned', { version: 2 });
        await decide(f.service, approval!, 'approve');
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'failed',
        );
        expect(f.service.managed.operation(approval!.operation_id)).toMatchObject({
          state: 'failed_definite',
          error: 'External target version changed',
        });
        expect(await call(external.socket, '/stats')).toMatchObject({ count: 0, posts: 1 });
      } finally {
        await f.close();
        await external.close();
      }
    });

    test('cancellation before dispatch denies the pending operation without external work', async () => {
      const external = await effectFixture();
      const f = await fixture({ effectConnector: external.connector });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] cancel-before');
        const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        const outbox = new Outbox(f.dir, session.id);
        const request = randomUUID();
        outbox.enqueueCancellation(
          work.attempt_id,
          f.service.store.session(session.id).revision,
          request,
        );
        await outbox.flush(f.service.socket, session.id, work.controller);
        await outbox.flush(f.service.socket, session.id, work.controller);
        expect(outbox.records()).toHaveLength(0);
        expect(
          f.service.store.db
            .prepare('SELECT count(*) n FROM cancellations WHERE attempt_id=?')
            .get(work.attempt_id)?.n,
        ).toBe(1);
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'cancelled',
        );
        expect(f.service.managed.operation(approval!.operation_id).state).toBe(
          'cancelled_before_dispatch',
        );
        expect(await call(external.socket, '/stats')).toMatchObject({ count: 0, posts: 0 });
      } finally {
        await f.close();
        await external.close();
      }
    });

    test('cancellation after dispatch preserves an unknown effect until independent reconciliation', async () => {
      const external = await effectFixture();
      writeFileSync(join(external.dir, 'hold-response'), 'hold');
      writeFileSync(join(external.dir, 'lookup-unavailable'), 'unavailable');
      const f = await fixture({ effectConnector: external.connector });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] cancel-after');
        const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
        await decide(f.service, approval!, 'approve');
        await until(() => existsSync(join(external.dir, 'accepted')), Boolean);
        const outbox = new Outbox(f.dir, session.id);
        const request = randomUUID();
        outbox.enqueueCancellation(
          work.attempt_id,
          f.service.store.session(session.id).revision,
          request,
        );
        await outbox.flush(f.service.socket, session.id, work.controller);
        const receipt = JSON.parse(
          (
            f.service.store.db
              .prepare('SELECT response FROM requests WHERE actor=? AND id=?')
              .get('local-operator', request) as { response: string }
          ).response,
        );
        expect(receipt).toMatchObject({ unresolved_operations: [approval!.operation_id] });
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'cancelled',
        );
        await until(
          () => f.service.managed.reconcile(approval!.operation_id).catch(() => null),
          Boolean,
        );
        expect(f.service.managed.operation(approval!.operation_id).state).toBe('outcome_unknown');
        unlinkSync(join(external.dir, 'lookup-unavailable'));
        expect((await f.service.managed.reconcile(approval!.operation_id)).state).toBe('succeeded');
        expect(await call(external.socket, '/stats')).toMatchObject({ count: 1, posts: 1 });
      } finally {
        await f.close();
        await external.close();
      }
    });

    test.each(['after-acceptance', 'after-receipt-commit'])(
      'worker death %s preserves one effect and requires a fresh ready epoch',
      async (barrier) => {
        const external = await effectFixture();
        if (barrier === 'after-acceptance')
          writeFileSync(join(external.dir, 'hold-response'), 'hold');
        let worker: PiProcess | undefined;
        const f = await fixture({
          effectConnector: external.connector,
          extensionPath:
            barrier === 'after-receipt-commit'
              ? join(ROOT, 'test/fixtures/blocked-extension.mjs')
              : undefined,
          launch: (launch) => {
            worker = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
            return worker;
          },
        });
        try {
          const session = await create(f.service, f.dir);
          await ready(f.service, session.id);
          const work = await submit(f.service, session.id, '[effect] worker-death');
          const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
          await decide(f.service, approval!, 'approve');
          await until(
            () =>
              existsSync(
                join(
                  barrier === 'after-acceptance' ? external.dir : f.dir,
                  barrier === 'after-acceptance' ? 'accepted' : 'probe-entered',
                ),
              ),
            Boolean,
          );
          const closed = worker!.closed;
          worker!.child.kill('SIGKILL');
          await closed;
          await until(
            () => f.service.store.attempt(work.attempt_id).state,
            (state) => state === 'interrupted',
          );
          if (barrier === 'after-acceptance') {
            await until(
              () => f.service.managed.reconcile(approval!.operation_id).catch(() => null),
              (op) => op?.state === 'succeeded',
            );
          }
          expect(f.service.managed.operation(approval!.operation_id).state).toBe('succeeded');
          await until(
            () =>
              f.service.store.db
                .prepare('SELECT state FROM workers WHERE session_id=?')
                .get(session.id) as { state: string },
            (row) => row.state === 'exited',
          );
          await f.service.supervisor.start(session.id);
          expect((await ready(f.service, session.id)).epoch).toBe(2);
          expect(await f.service.supervisor.dispatchNext(session.id)).toBe(false);
          expect(await call(external.socket, '/stats')).toMatchObject({ count: 1, posts: 1 });
        } finally {
          await f.close();
          await external.close();
        }
      },
    );

    test('shutdown waits for a pending target preflight before closing its journal', async () => {
      const external = await effectFixture();
      let release!: () => void;
      let entered = false;
      const connector = Object.create(external.connector) as typeof external.connector;
      connector.version = async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return '1';
      };
      let worker: PiProcess | undefined;
      const f = await fixture({
        effectConnector: connector,
        launch: (launch) => {
          worker = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
          return worker;
        },
      });
      let closing: Promise<void> | undefined;
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        await submit(f.service, session.id, '[effect] pending-preflight');
        await until(() => entered, Boolean);
        closing = f.service.close();
        await worker!.closed;
        expect(
          await Promise.race([
            closing.then(() => 'closed'),
            new Promise((resolve) => setTimeout(() => resolve('waiting-for-preflight'), 20)),
          ]),
        ).toBe('waiting-for-preflight');
        release();
        await closing;
        expect(await call(external.socket, '/stats')).toMatchObject({ count: 0, posts: 0 });
      } finally {
        release?.();
        await closing;
        await f.close();
        await external.close();
      }
    });

    test('the default bundle declines an external effect without substituting a read-only operation', async () => {
      const f = await fixture();
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] disabled-target');
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(f.service.store.attempt(work.attempt_id).result).toContain(
          'disabled; no effect was dispatched',
        );
        expect(f.service.store.operations(session.id)).toHaveLength(0);
        expect(f.service.store.approvals(session.id)).toHaveLength(0);
      } finally {
        await f.close();
      }
    });
    test('a required nested policy failure cannot dispatch a managed effect', async () => {
      const external = await effectFixture();
      const f = await fixture({
        effectConnector: external.connector,
        extensionPath: join(ROOT, 'test/fixtures/policy-fault.mjs'),
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const work = await submit(f.service, session.id, '[effect] nested-policy');
        await until(
          () => f.service.store.attempt(work.attempt_id).state,
          (state) => state === 'interrupted',
        );
        expect(f.service.supervisor.inspect(session.id).state).toBe('unhealthy');
        expect(await call(external.socket, '/stats')).toMatchObject({ count: 0, posts: 0 });
        expect(f.service.store.operations(session.id).some((op) => op.state === 'succeeded')).toBe(
          false,
        );
      } finally {
        await f.close();
        await external.close();
      }
    });
  },
);
