import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { call as request } from '../../src/core/transport.js';
import { toolkitServiceFixture } from '../toolkit-service-helpers.js';
import { ready, until } from '../helpers.js';

test('actual Pi startup waits for owned native catalogue readiness and receives only its safe fingerprint', async () => {
  const f = await toolkitServiceFixture();
  try {
    const [a, b] = await Promise.all([
      f.service.toolkit!.ready(f.session),
      f.service.toolkit!.ready(f.session),
    ]);
    expect(a).toEqual(b);
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    expect(f.service.supervisor.inspect(f.session).capabilities).toContain('managed-toolkit-v1');
    expect(JSON.stringify(f.configs.at(-1)?.toolkit)).not.toContain(f.config.profile_path);
    expect(JSON.stringify(f.configs.at(-1)?.toolkit)).not.toContain('a'.repeat(64));
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_resources').get()!.n).toBe(
      1,
    );
    const work = await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'read',
      arguments: {},
    });
    await until(
      () => f.service.store.attempt(work.attempt_id).state,
      (s) => s === 'completed',
    );
    const row = f.service.store.db.prepare('SELECT * FROM toolkit_calls').get()!;
    expect(row.state).toBe('returned');
    expect(f.lines('effects.jsonl')).toHaveLength(1);
    expect(f.lines('phases.jsonl')).toEqual([
      { phase: 'admit', decision: 'allowed' },
      { phase: 'dispatch', decision: 'allowed' },
    ]);
    expect(
      JSON.stringify(
        f.service.store.db
          .prepare('SELECT payload FROM pi_entries WHERE session_id=?')
          .all(f.session),
      ),
    ).toContain('Synthetic native station response');
    const launch = JSON.parse(readFileSync(f.profilePath, 'utf8'));
    expect(JSON.stringify(f.service.store.events(f.session, 0))).not.toContain(
      launch.passphrase_sha256,
    );
  } finally {
    await f.close();
  }
});

for (const decision of ['approve', 'deny'] as const)
  test(
    'actual Pi native write binds its human ' + decision + ' decision before any effect grant',
    async () => {
      const f = await toolkitServiceFixture();
      try {
        await f.service.supervisor.start(f.session);
        await ready(f.service, f.session);
        const work = await f.submit({
          action: 'call',
          category: 'fixture',
          name: 'write',
          arguments: { title: 'Synthetic' },
        });
        const approval = await until(
          () => f.service.store.approvals(f.session).find((a) => a.state === 'pending'),
          Boolean,
        );
        expect(f.lines('effects.jsonl')).toEqual([]);
        const op = f.service.managed.operation(approval!.operation_id);
        const original = f.service.store.db
          .prepare('SELECT * FROM toolkit_calls WHERE operation_id=?')
          .get(op.id)!;
        const request = JSON.parse(String(original.request_json));
        expect(request.expires_at_ms).toBeLessThanOrEqual(
          f.service.agentpod!.bySession(f.session).expires_at,
        );
        f.service.managed.decide(
          approval!.id,
          randomUUID(),
          approval!.revision,
          op.operation_digest,
          decision,
        );
        await until(
          () =>
            f.service.store.db
              .prepare('SELECT state FROM toolkit_calls WHERE id=?')
              .get(original.id!)!.state,
          (s) => s === (decision === 'approve' ? 'outcome_unknown' : 'cancelled'),
        );
        expect(f.lines('effects.jsonl')).toHaveLength(decision === 'approve' ? 1 : 0);
        expect(f.service.store.hasUnknown(f.session)).toBe(decision === 'approve');
        if (decision === 'approve') {
          const count = f.lines('effects.jsonl').length;
          await f.reopen();
          const saved = f.service.toolkit!.prepare(
            f.session,
            Number(original.worker_epoch),
            String(original.attempt_id),
            String(original.tool_call_id),
            { category: 'fixture', action: 'write', arguments: { title: 'Synthetic' } },
          );
          expect(saved.state).toBe('outcome_unknown');
          expect(
            f.service.toolkit!.start(saved.id, f.session, saved.worker_epoch, saved.attempt_id)
              .state,
          ).toBe('outcome_unknown');
          expect(f.lines('effects.jsonl')).toHaveLength(count);
          await expect(f.service.toolkit!.ready(f.session)).rejects.toMatchObject({
            code: 'toolkit_readiness_failed',
          });
        } else
          await until(
            () => f.service.store.attempt(work.attempt_id).state,
            (s) => s === 'failed',
          );
      } finally {
        await f.close();
      }
    },
  );

test('invalid native arguments remain a tool failure and a subsequent admitted read still works', async () => {
  const f = await toolkitServiceFixture();
  try {
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    const bad = await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'write',
      arguments: {},
    });
    await until(
      () => f.service.store.attempt(bad.attempt_id).state,
      (s) => s === 'failed',
    );
    expect(f.service.supervisor.inspect(f.session).state).toBe('ready');
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_calls').get()!.n).toBe(0);
    expect(f.lines('effects.jsonl')).toEqual([]);
    const good = await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'read',
      arguments: {},
    });
    await until(
      () => f.service.store.attempt(good.attempt_id).state,
      (s) => s === 'completed',
    );
    expect(f.lines('effects.jsonl')).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('native catalogue drift prevents Pi readiness before any model or effect call', async () => {
  const f = await toolkitServiceFixture('catalog-drift');
  try {
    await expect(f.service.supervisor.start(f.session)).rejects.toThrow();
    expect(f.service.supervisor.inspect(f.session).state).not.toBe('ready');
    expect(f.lines('effects.jsonl')).toEqual([]);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM toolkit_calls').get()!.n).toBe(0);
    expect(f.service.toolkitResources.stopped(f.session)).toBe(true);
  } finally {
    await f.close();
  }
});

test('an inconsistent nested native result invalidates actual worker readiness and preserves its dispatched uncertainty', async () => {
  const f = await toolkitServiceFixture('nested-lie');
  try {
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    await f.submit({ action: 'call', category: 'fixture', name: 'read', arguments: {} });
    await until(() => f.service.store.hasUnknown(f.session), Boolean);
    await until(
      () => f.service.supervisor.inspect(f.session).state,
      (s) => s !== 'ready',
    );
    expect(f.lines('effects.jsonl')).toHaveLength(1);
    expect(f.service.store.db.prepare('SELECT state FROM toolkit_calls').get()!.state).toBe(
      'outcome_unknown',
    );
    await expect(f.service.toolkit!.ready(f.session)).rejects.toMatchObject({
      code: 'toolkit_readiness_failed',
    });
  } finally {
    await f.close();
  }
});

test('a native read HTTP error is a failed actual Pi attempt and leaves the controller available', async () => {
  const f = await toolkitServiceFixture('http-error');
  try {
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    const work = await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'read',
      arguments: {},
    });
    await until(
      () => f.service.store.attempt(work.attempt_id).state,
      (s) => s === 'failed',
    );
    expect(f.service.supervisor.inspect(f.session).state).toBe('ready');
    expect(f.service.store.hasUnknown(f.session)).toBe(false);
    const row = f.service.store.db.prepare('SELECT * FROM toolkit_calls').get()!;
    expect(row.state).toBe('returned');
    expect(f.service.toolkit!.view(String(row.id))).toMatchObject({
      result: { is_error: true, structured_content: { status: 503 } },
    });
  } finally {
    await f.close();
  }
});

for (const reason of ['lease', 'root'] as const)
  test(
    'pending native human review cannot dispatch after ' + reason + ' authority loss',
    async () => {
      const f = await toolkitServiceFixture();
      try {
        await f.service.supervisor.start(f.session);
        await ready(f.service, f.session);
        await f.submit({
          action: 'call',
          category: 'fixture',
          name: 'write',
          arguments: { title: 'Synthetic' },
        });
        const approval = await until(
          () => f.service.store.approvals(f.session).find((a) => a.state === 'pending'),
          Boolean,
        );
        const call = f.service.store.db
          .prepare('SELECT * FROM toolkit_calls WHERE operation_id=?')
          .get(approval!.operation_id)!;
        if (reason === 'root')
          await request(f.service.socket, '/v1/agentpod/revoke', {
            binding: f.binding,
            request_id: randomUUID(),
            reason: 'Synthetic root revoked',
          });
        else
          f.service.store.db
            .prepare('UPDATE agentpod_admissions SET expires_at=0 WHERE session_id=?')
            .run(f.session);
        expect(() =>
          f.service.managed.decide(
            approval!.id,
            randomUUID(),
            approval!.revision,
            f.service.managed.operation(approval!.operation_id).operation_digest,
            'approve',
          ),
        ).toThrow();
        await until(() => f.service.toolkitResources.stopped(f.session), Boolean);
        expect(f.lines('effects.jsonl')).toEqual([]);
        expect(
          f.service.store.db.prepare('SELECT state FROM toolkit_calls WHERE id=?').get(call.id!)!
            .state,
        ).toBe('cancelled');
        expect(f.service.store.hasUnknown(f.session)).toBe(false);
      } finally {
        await f.close();
      }
    },
  );

test('renewing a root lease cannot extend a saved native invocation deadline', async () => {
  const f = await toolkitServiceFixture();
  try {
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'write',
      arguments: { title: 'Synthetic' },
    });
    const approval = await until(
      () => f.service.store.approvals(f.session).find((a) => a.state === 'pending'),
      Boolean,
    );
    const row = f.service.store.db
        .prepare('SELECT * FROM toolkit_calls WHERE operation_id=?')
        .get(approval!.operation_id)!,
      deadline = JSON.parse(String(row.request_json)).expires_at_ms;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1000);
    try {
      f.service.agentpod!.renew(f.binding, randomUUID(), 2);
      clock.mockReturnValue(deadline + 1);
      const op = f.service.managed.operation(approval!.operation_id);
      expect(() =>
        f.service.managed.decide(
          approval!.id,
          randomUUID(),
          approval!.revision,
          op.operation_digest,
          'approve',
        ),
      ).toThrow();
      const stopped = f.service.toolkit!.start(
        String(row.id),
        f.session,
        Number(row.worker_epoch),
        String(row.attempt_id),
      );
      expect(stopped.state).toBe('cancelled');
      expect(stopped.request_json).toBe(row.request_json);
      expect(f.service.store.hasUnknown(f.session)).toBe(false);
      expect(f.lines('effects.jsonl')).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.close();
  }
});

test('worker control loss atomically cancels an undispatched native review and a fresh worker gets a new owned broker', async () => {
  const f = await toolkitServiceFixture();
  try {
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    await f.submit({
      action: 'call',
      category: 'fixture',
      name: 'write',
      arguments: { title: 'Synthetic' },
    });
    const approval = await until(
      () => f.service.store.approvals(f.session).find((a) => a.state === 'pending'),
      Boolean,
    );
    const original = f.service.store.db
      .prepare('SELECT * FROM toolkit_calls WHERE operation_id=?')
      .get(approval!.operation_id)!;
    f.service.supervisor.failControl(f.session, new Error('Synthetic required bridge failure'));
    await until(() => f.service.toolkitResources.stopped(f.session), Boolean);
    expect(
      f.service.store.db.prepare('SELECT state FROM toolkit_calls WHERE id=?').get(original.id!)!
        .state,
    ).toBe('cancelled');
    expect(f.service.store.hasUnknown(f.session)).toBe(false);
    expect(f.lines('effects.jsonl')).toEqual([]);
    await f.service.supervisor.stopSession(f.session);
    await f.service.supervisor.start(f.session);
    await ready(f.service, f.session);
    const next = await f.submit(
      {
        action: 'call',
        category: 'fixture',
        name: 'read',
        arguments: {},
      },
      String(original.attempt_id),
    );
    await until(
      () => f.service.store.attempt(next.attempt_id).state,
      (s) => s === 'completed',
    );
    const latest = f.service.store.db
      .prepare('SELECT resource_id FROM toolkit_calls WHERE attempt_id=?')
      .get(next.attempt_id)!;
    expect(latest.resource_id).not.toBe(original.resource_id);
    expect(f.lines('effects.jsonl')).toHaveLength(1);
  } finally {
    await f.close();
  }
});
