import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, create, ready, until, probe } from '../helpers.js';
import { ROOT } from '../../src/core/config.js';
import { call } from '../../src/core/transport.js';
import { verifyReadinessFingerprint } from '../../src/core/readiness-fingerprint.js';

test('real pinned Pi passes readiness, executes a gated turn, and persists its session', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    const snapshot = await ready(f.service, session.id);
    const receipt = f.service.store
      .events(session.id, 0)
      .find((event) => event.kind === 'worker.ready')!.payload as any;
    expect(verifyReadinessFingerprint(receipt.fingerprint)).toMatchObject({
      session_id: session.id,
      worker_epoch: snapshot.epoch,
      harness: 'salaam',
      verification: 'pinned-readiness-handshake',
      provider: 'salaam-proof',
      model: 'scripted',
    });
    expect(snapshot.capabilities).toEqual([
      'persistent-session',
      'managed-policy',
      'task-context',
      'provider-admission',
      'durable-approvals',
      'operation-ledger',
      'child-work',
      'worker-boundary-v1',
      'usage-ledger',
      'durable-task-context',
      'managed-compaction',
    ]);
    expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'model.admitted')).toBe(
      false,
    );
    expect(await probe(f.service, session.id, { nested: true })).toEqual({
      text: 'Salaam readiness probe complete.',
    });
    expect(readFileSync(snapshot.pi_session_file!, 'utf8')).toContain(
      'Run the nested Salaam readiness probe.',
    );
    expect(f.service.store.session(session.id).pi_cursor).toBeTruthy();
    expect(await probe(f.service, session.id, {})).toEqual({
      text: 'Salaam readiness probe complete.',
    });
    expect(
      f.service.store.events(session.id, 0).filter((x) => x.kind === 'tool.granted'),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
test('a nested tool cannot bypass a failed policy hook', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/policy-fault.mjs') });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await expect(probe(f.service, session.id, { nested: true })).rejects.toThrow();
    await until(
      () => f.service.supervisor.inspect(session.id),
      (x) => x.state === 'unhealthy',
    );
    expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'tool.granted')).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});
test('a real Pi extension load failure cannot report readiness', async () => {
  const f = await fixture({
    extensionPath: join(ROOT, 'test/fixtures/does-not-exist.mjs'),
    startupTimeout: 1000,
  });
  try {
    const session = await create(f.service, f.dir);
    await until(
      () => f.service.supervisor.inspect(session.id),
      (x) => x.state === 'unhealthy',
    );
    expect(
      f.service.store
        .events(session.id, 0)
        .some((x) => ['worker.ready', 'model.admitted'].includes(x.kind)),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
test('a context hook that throws cannot forward a request through the guarded provider', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/context-fault.mjs') });
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await expect(probe(f.service, session.id, {})).rejects.toThrow();
    await until(
      () => f.service.supervisor.inspect(session.id),
      (x) => x.state === 'unhealthy',
    );
    expect(
      f.service.store
        .events(session.id, 0)
        .some((x) => ['model.admitted', 'tool.granted'].includes(x.kind)),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
