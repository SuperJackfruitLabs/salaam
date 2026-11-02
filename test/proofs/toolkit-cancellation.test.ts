import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture, create, ready, control, until } from '../helpers.js';
import { digest, canonical } from '../../src/core/protocol.js';
import { SalaamService } from '../../src/service/service.js';

/** Seed a private recovery record; no native tool or effect is executed. */
function resource(service: SalaamService, session: string) {
  service.store.db
    .prepare(
      "INSERT INTO toolkit_resources(id,session_id,root_digest,profile_digest,state_dir,input_digest,spec,owner_boot,state) VALUES(?,?,?,?,?,?,?,?,'prepared')",
    )
    .run(
      'recovery-resource',
      session,
      'a'.repeat(64),
      'b'.repeat(64),
      service.stateDir + '/fixture-native-state',
      'c'.repeat(64),
      '{}',
      service.toolkitResources.boot,
    );
}

test('an uncertain native read remains an unknown cancellation after process stop and actual daemon reopen', async () => {
  const f = await fixture();
  let reopened: SalaamService | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const actor = await control(f.service, session.id, true),
      target = randomUUID(),
      requestId = randomUUID();
    const work = f.service.store.accept(
      session.id,
      target,
      f.service.store.session(session.id).revision,
      '[review] keep-worker-running',
      actor,
    );
    await until(
      () => f.service.store.approvals(session.id).some((a) => a.state === 'pending'),
      Boolean,
    );
    resource(f.service, session.id);
    await f.service.toolkitResources.stop('recovery-resource');
    const request = {
      version: 1,
      root_digest: 'a'.repeat(64),
      profile_digest: 'b'.repeat(64),
      invocation_id: 'recovery-read',
      service: 'fixture',
      action: 'read',
      args: {},
      approval: false,
      expires_at_ms: Date.now() + 60000,
    };
    const id = digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]);
    f.service.store.db
      .prepare(
        "INSERT INTO toolkit_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,resource_id,request_json,request_digest,context_digest,action_pin,operation_id,state) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'outcome_unknown')",
      )
      .run(
        id,
        session.id,
        f.service.store.session(session.id).epoch,
        work.attempt_id,
        'native-read',
        'recovery-resource',
        canonical(request),
        digest(request),
        'd'.repeat(64),
        canonical({ kind: 'read', policy: 'agent', digest: 'e'.repeat(64) }),
      );
    expect(f.service.store.hasUnknown(session.id)).toBe(true);
    const initial = f.service.cancellations.begin(session.id, requestId, target, actor);
    expect(initial.state).toBe('unknown');
    const final = await until(
      () => f.service.cancellations.get(session.id, requestId),
      (r) => !r.activeAttemptIds.length,
    );
    expect(final).toMatchObject({ state: 'unknown', unconfirmedResources: ['toolkit-call:' + id] });
    await f.service.close();
    reopened = await SalaamService.open({ stateDir: f.dir });
    expect(reopened.cancellations.get(session.id, requestId)).toMatchObject({
      state: 'unknown',
      unconfirmedResources: ['toolkit-call:' + id],
    });
    expect(() => reopened!.store.execution.assert(session.id)).toThrowError(
      expect.objectContaining({ code: 'toolkit_resources_unconfirmed' }),
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('native stop failure still attempts actual worker cancellation', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const actor = await control(f.service, session.id, true),
      target = randomUUID(),
      requestId = randomUUID();
    const work = f.service.store.accept(
      session.id,
      target,
      f.service.store.session(session.id).revision,
      '[review] keep-worker-running',
      actor,
    );
    await until(
      () => f.service.store.approvals(session.id).some((a) => a.state === 'pending'),
      Boolean,
    );
    resource(f.service, session.id);
    f.service.store.db
      .prepare(
        "INSERT INTO toolkit_calls(id,session_id,worker_epoch,attempt_id,tool_call_id,resource_id,request_json,request_digest,context_digest,action_pin,operation_id,state) VALUES(?,?,?,?,?,'recovery-resource','{}',?,?,?,NULL,'prepared')",
      )
      .run(
        'prepared-native-call',
        session.id,
        f.service.store.session(session.id).epoch,
        work.attempt_id,
        'prepared-native-tool',
        'd'.repeat(64),
        'e'.repeat(64),
        '{}',
      );
    f.service.toolkitResources.stopAttempt = async () => {
      throw Error('injected native resource stop failure');
    };
    const cancel = f.service.supervisor.cancelAttempt.bind(f.service.supervisor);
    let attempts = 0;
    f.service.supervisor.cancelAttempt = async (id) => {
      attempts++;
      await cancel(id);
    };
    f.service.cancellations.begin(session.id, requestId, target, actor);
    await until(
      () => attempts,
      (n) => n > 0,
    );
    await until(
      () => f.service.store.attempt(work.attempt_id).state,
      (s) => s === 'cancelled',
    );
    expect(f.service.cancellations.get(session.id, requestId)).toMatchObject({
      state: 'unknown',
      unconfirmedResources: ['managed-toolkit:' + session.id],
    });
  } finally {
    await f.close();
  }
});
