import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, create, ready, until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';

test('real pinned Pi passes readiness, executes a gated turn, and persists its session', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    const snapshot = await ready(f.service, session.id);
    expect(snapshot.capabilities).toEqual([
      'persistent-session',
      'managed-policy',
      'task-context',
      'provider-admission',
    ]);
    expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'model.admitted')).toBe(
      false,
    );
    expect(
      await call(f.service.socket, `/v1/sessions/${session.id}/probe`, { nested: true }),
    ).toEqual({ text: 'Salaam readiness probe complete.' });
    expect(readFileSync(snapshot.pi_session_file!, 'utf8')).toContain(
      'Run the nested Salaam readiness probe.',
    );
    expect(f.service.store.session(session.id).pi_cursor).toBeTruthy();
    expect(await call(f.service.socket, `/v1/sessions/${session.id}/probe`, {})).toEqual({
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
    await expect(
      call(f.service.socket, `/v1/sessions/${session.id}/probe`, { nested: true }),
    ).rejects.toThrow();
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
    await expect(call(f.service.socket, `/v1/sessions/${session.id}/probe`, {})).rejects.toThrow();
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
