import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, create, ready, control, until } from '../helpers.js';
import { effectFixture, decide } from '../managed-helpers.js';
import { call } from '../../src/transport.js';
import { SalaamService } from '../../src/service.js';
import corpus from '../fixtures/agentpod-acp-v1.json' with { type: 'json' };

test('cancellation before dispatch durably fences only its logical prompt and deduplicates before controller checks', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const actor = await control(f.service, session.id, true),
      target = randomUUID(),
      request = randomUUID();
    const path = `/v1/sessions/${session.id}/cancellations`;
    const receipt = await call<any>(f.service.socket, path, {
      ...actor,
      request_id: request,
      target_request_id: target,
    });
    expect(receipt).toMatchObject({
      version: 1,
      state: 'confirmed',
      requestId: request,
      targetRequestId: target,
      attemptIds: [],
      activeAttemptIds: [],
      unresolvedOperationIds: [],
      unconfirmedResources: [],
    });
    expect(
      await call(f.service.socket, path, {
        client_id: 'expired',
        token: 'expired',
        request_id: request,
        target_request_id: target,
      }),
    ).toEqual(receipt);
    await expect(
      call(f.service.socket, path, {
        ...actor,
        request_id: request,
        target_request_id: randomUUID(),
      }),
    ).rejects.toThrow(/different input/);
    expect(() =>
      f.service.store.accept(
        session.id,
        target,
        f.service.store.session(session.id).revision,
        'Must never dispatch',
        actor,
      ),
    ).toThrow(/cancelled before dispatch/);
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(0);
    const next = f.service.store.accept(
      session.id,
      randomUUID(),
      f.service.store.session(session.id).revision,
      'A distinct instruction',
      actor,
    );
    await until(
      () => f.service.store.attempt(next.attempt_id).state,
      (s) => s === 'completed',
    );
  } finally {
    await f.close();
  }
});

test('active cancellation confirms after settlement and its receipt survives daemon restart', async () => {
  const f = await fixture();
  let reopened: SalaamService | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const actor = await control(f.service, session.id, true),
      target = randomUUID(),
      request = randomUUID();
    const work = f.service.store.accept(
      session.id,
      target,
      f.service.store.session(session.id).revision,
      '[review] pending-cancel',
      actor,
    );
    await until(
      () => f.service.store.approvals(session.id).some((a) => a.state === 'pending'),
      Boolean,
    );
    const path = `/v1/sessions/${session.id}/cancellations`;
    const event = f.service.store.event.bind(f.service.store);
    f.service.store.event = (...args: Parameters<typeof event>) => {
      if (args[1] === 'turn.cancel_requested') throw Error('Injected cancellation record failure');
      return event(...args);
    };
    expect(() => f.service.cancellations.begin(session.id, request, target, actor)).toThrow(
      'Injected cancellation record failure',
    );
    expect(f.service.store.attempt(work.attempt_id).state).toBe('running');
    expect(f.service.store.cancelled(work.attempt_id)).toBe(false);
    expect(
      f.service.store.db.prepare('SELECT COUNT(*) AS n FROM turn_cancellations').get()!.n,
    ).toBe(0);
    f.service.store.event = event;
    const first = await call<any>(f.service.socket, path, {
      ...actor,
      request_id: request,
      target_request_id: target,
    });
    expect(first).toMatchObject({
      state: 'requested',
      attemptIds: [work.attempt_id],
      activeAttemptIds: [work.attempt_id],
    });
    const final = await until(
      () => call<any>(f.service.socket, path + '?request_id=' + request),
      (r) => r.state === 'confirmed',
    );
    const canonical = corpus.cancellations[0]!.value;
    expect({
      ...final,
      sessionId: canonical.sessionId,
      requestId: canonical.requestId,
      targetRequestId: canonical.targetRequestId,
      attemptIds: canonical.attemptIds,
    }).toEqual(canonical);
    expect(f.service.store.attempt(work.attempt_id).state).toBe('cancelled');
    await f.service.close();
    reopened = await SalaamService.open({ stateDir: f.dir });
    expect(await call(reopened.socket, path + '?request_id=' + request)).toEqual(final);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('an uncertain accepted effect never becomes a confirmed cancellation until independent reconciliation', async () => {
  const external = await effectFixture();
  writeFileSync(join(external.dir, 'hold-response'), 'hold');
  writeFileSync(join(external.dir, 'lookup-unavailable'), 'hold');
  const f = await fixture({ effectConnector: external.connector });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const actor = await control(f.service, session.id, true),
      target = randomUUID(),
      request = randomUUID();
    const work = f.service.store.accept(
      session.id,
      target,
      f.service.store.session(session.id).revision,
      '[effect] uncertain-cancel',
      actor,
    );
    const approval = await until(() => f.service.store.approvals(session.id)[0], Boolean);
    await decide(f.service, approval!, 'approve');
    await until(() => existsSync(join(external.dir, 'accepted')), Boolean);
    const path = `/v1/sessions/${session.id}/cancellations`;
    const receipt = await call<any>(f.service.socket, path, {
      ...actor,
      request_id: request,
      target_request_id: target,
    });
    expect(receipt.state).toBe('unknown');
    expect(receipt.unresolvedOperationIds).toEqual([approval!.operation_id]);
    await until(
      () => f.service.store.attempt(work.attempt_id).state,
      (s) => s === 'cancelled',
    );
    expect((await call<any>(f.service.socket, path + '?request_id=' + request)).state).toBe(
      'unknown',
    );
    unlinkSync(join(external.dir, 'lookup-unavailable'));
    await f.service.managed.reconcile(approval!.operation_id);
    await until(
      () => call<any>(f.service.socket, path + '?request_id=' + request),
      (r) => r.state === 'confirmed',
    );
    expect(await call(external.socket, '/stats')).toMatchObject({ count: 1, posts: 1 });
  } finally {
    await f.close();
    await external.close();
  }
});
