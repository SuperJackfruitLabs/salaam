import { test, expect } from 'vitest';
import { join } from 'node:path';
import { fixture, create, ready, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { Outbox } from '../../src/attach.js';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';

test('operator reconnect recovers one journaled prompt after an acceptance response is lost', async () => {
  const f = await fixture();
  let client = new OperatorClient(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await client.open(session.id);
    const accept = f.service.store.accept.bind(f.service.store);
    let lost = true;
    f.service.store.accept = (...args) => {
      const result = accept(...args);
      if (lost) {
        lost = false;
        throw new Error('lost acceptance response');
      }
      return result;
    };
    const id = await client.submit('Recover the same logical instruction');
    expect(new Outbox(f.dir, session.id).records().map((x) => x.request_id)).toEqual([id]);
    await client.close();
    client = new OperatorClient(f.dir);
    await client.open(session.id);
    expect(new Outbox(f.dir, session.id).records()).toEqual([]);
    const final = await until(
      () => f.service.store.snapshot(session.id),
      (snapshot) => snapshot.attempts[0]?.state === 'completed',
    );
    expect(final.attempts).toHaveLength(1);
    expect(final.submissions).toHaveLength(1);
    expect(final.submissions[0]?.text).toBe('Recover the same logical instruction');
  } finally {
    await client.close();
    await f.close();
  }
});

test('tool activity storage failure invalidates readiness and prevents new grants', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  const client = new OperatorClient(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await client.open(session.id);
    const request = f.service.store.request.bind(f.service.store);
    f.service.store.request = (...args) => {
      if (String(args[0]).startsWith('tool-activity:')) throw new Error('simulated storage full');
      return request(...args);
    };
    await client.submit('Try the blocked tool');
    await until(
      () => f.service.supervisor.inspect(session.id).state,
      (state) => state === 'unhealthy',
    );
    const denied = f.service.store.events(session.id, 0).find((e) => e.kind === 'worker.unhealthy');
    expect(denied).toBeDefined();
    const after = f.service.store.events(session.id, denied!.seq);
    expect(after.filter((e) => ['tool.granted', 'model.admitted'].includes(e.kind))).toEqual([]);
  } finally {
    await client.close();
    await f.close();
  }
});

test('activity pages remain bounded in bytes for Unicode inputs', async () => {
  const f = await fixture();
  try {
    const session = f.service.store.create(f.dir, 'activity-fixture');
    f.service.store.transaction(() => {
      for (let i = 0; i < 200; i++)
        f.service.store.event(session.id, 'tool.started', {
          tool_call_id: String(i),
          tool: 'fixture',
          input: '🌿'.repeat(4000),
        });
    });
    const events = await call<unknown[]>(f.service.socket, `/v1/sessions/${session.id}/activity`);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(1024 * 1024);
  } finally {
    await f.close();
  }
});

test('volatile preview disappears on reconnect and committed message identities replace it once', async () => {
  const { existsSync, writeFileSync } = await import('node:fs');
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  let client = new OperatorClient(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await client.open(session.id);
    await client.submit('Keep committed text');
    await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
    const attempt = f.service.store.snapshot(session.id).attempts[0]!;
    await until(
      () => client.snapshot?.attempts[0]?.state,
      (state) => state === 'running',
    );
    f.service.supervisor.emit('preview', {
      session_id: session.id,
      attempt_id: attempt.id,
      text: 'volatile draft',
    });
    await until(
      () => client.preview?.text,
      (text) => text === 'volatile draft',
    );
    await client.close();
    client = new OperatorClient(f.dir);
    await client.open(session.id);
    expect(client.preview).toBeUndefined();
    expect(client.snapshot?.messages.every((m) => !m.text.includes('volatile draft'))).toBe(true);
    writeFileSync(join(f.dir, 'release-probe'), 'go');
    await until(
      () => client.snapshot?.messages,
      (messages) => !!messages?.some((m) => m.text === 'Offline reply: Keep committed text'),
    );
    await client.refresh();
    expect(client.preview).toBeUndefined();
    expect(
      client.snapshot!.messages.filter((m) => m.text === 'Offline reply: Keep committed text'),
    ).toHaveLength(1);
    expect(new Set(client.snapshot!.messages.map((m) => m.entry_id)).size).toBe(
      client.snapshot!.messages.length,
    );
  } finally {
    await client.close();
    await f.close();
  }
});
