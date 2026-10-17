import { expect, test } from 'vitest';
import { request } from 'node:http';
import { fixture, fake, create, ready, until, control, probe } from '../helpers.js';
import { call } from '../../src/transport.js';
import { SalaamService } from '../../src/service.js';
import type { DurableEvent, Session } from '../../src/protocol.js';

test('create is idempotent; a second service cannot own its state', async () => {
  const f = await fixture(fake());
  try {
    const a = await create(f.service, f.dir, 'C1');
    const b = await create(f.service, f.dir, 'C1');
    expect(b).toEqual(a);
    await ready(f.service, a.id);
    expect(f.service.store.db.prepare('SELECT count(*) AS n FROM workers').get()).toMatchObject({
      n: 1,
    });
    await expect(
      call(f.service.socket, '/v1/sessions', { request_id: 'C1', cwd: '/tmp' }),
    ).rejects.toThrow('different input');
    await expect(SalaamService.open({ stateDir: f.dir })).rejects.toThrow('Another Salaam service');
    f.service.dispatcher.pause();
    const controller = await control(f.service, a.id);
    await expect(
      call(f.service.socket, `/v1/sessions/${a.id}/probe`, {
        client_id: 'observer',
        token: 'invalid',
      }),
    ).rejects.toThrow('controller lease');
    const before = await call<Session>(f.service.socket, `/v1/sessions/${a.id}`);
    const command = {
      ...controller,
      request_id: 'R1',
      text: 'Queued for dispatch',
      expected_revision: before.revision,
    };
    const accepted = await call(f.service.socket, `/v1/sessions/${a.id}/submissions`, command);
    expect(await call(f.service.socket, `/v1/sessions/${a.id}/submissions`, command)).toEqual(
      accepted,
    );
    expect(f.service.store.events(a.id, 0).some((x) => x.kind === 'model.admitted')).toBe(false);
  } finally {
    await f.close();
  }
});

test('an SSE record larger than the socket high-water mark is delivered and replayable', async () => {
  const f = await fixture(fake());
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const before = f.service.store.session(session.id).seq;
    const payload = { text: '🌍'.repeat(65536) };
    f.service.store.transaction(() => f.service.store.event(session.id, 'large.record', payload));
    const connection = stream(f.service.socket, session.id, before, 1);
    expect((await connection.result)[0]?.payload).toEqual(payload);
    const replay = stream(f.service.socket, session.id, before, 1);
    expect((await replay.result)[0]?.seq).toBe(before + 1);
  } finally {
    await f.close();
  }
});

function stream(
  socketPath: string,
  id: string,
  after: number,
  count: number,
): { result: Promise<DurableEvent[]>; close: () => void } {
  let req: ReturnType<typeof request>;
  const result = new Promise<DurableEvent[]>((resolve, reject) => {
    req = request({ socketPath, path: `/v1/sessions/${id}/events?after=${after}` }, (res) => {
      let buffer = '';
      const events: DurableEvent[] = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n\n')) !== -1) {
          const packet = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = packet.split('\n').find((x) => x.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)) as DurableEvent);
          if (events.length >= count) {
            resolve(events);
            req.destroy();
            return;
          }
        }
      });
      res.on('error', (error) => {
        if (events.length < count) reject(error);
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { result, close: () => req?.destroy() };
}

test('snapshot cursor plus replay/live events has no subscribe gap', async () => {
  const f = await fixture(fake());
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const snapshot = await call<Session>(f.service.socket, `/v1/sessions/${session.id}`);
    f.service.store.transaction(() =>
      f.service.store.event(session.id, 'between.snapshot.and.subscribe', {}),
    );
    const connection = stream(f.service.socket, session.id, snapshot.seq, 2);
    f.service.store.transaction(() => f.service.store.event(session.id, 'during.subscribe', {}));
    const events = await connection.result;
    expect(events.map((x) => x.seq)).toEqual([snapshot.seq + 1, snapshot.seq + 2]);
    expect(events.map((x) => x.kind)).toEqual([
      'between.snapshot.and.subscribe',
      'during.subscribe',
    ]);
    const reconnect = stream(f.service.socket, session.id, events[0]!.seq, 1);
    expect((await reconnect.result)[0]?.event_id).toBe(events[1]!.event_id);
    await until(
      () => f.service.store.changes.listenerCount('event'),
      (n) => n === 2,
    );
  } finally {
    await f.close();
  }
});

test('accepted state and events remain inspectable after service restart', async () => {
  const f = await fixture(fake());
  let reopened: SalaamService | undefined;
  try {
    const created = await create(f.service, f.dir);
    await ready(f.service, created.id);
    const snapshot = f.service.store.session(created.id);
    const accepted = f.service.store.accept(created.id, 'R1', snapshot.revision, 'Keep this work');
    await f.service.close();
    reopened = await SalaamService.open({ stateDir: f.dir, ...fake() });
    expect(reopened.store.accept(created.id, 'R1', snapshot.revision, 'Keep this work')).toEqual(
      accepted,
    );
    expect(reopened.store.events(created.id, 0).some((x) => x.kind === 'submission.accepted')).toBe(
      true,
    );
    expect(reopened.supervisor.inspect(created.id).state).toBe('exited');
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('shutdown releases workers, sockets and the state lock even if journal writes fail', async () => {
  const f = await fixture(fake());
  let replacement: SalaamService | undefined;
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    f.service.store.db.exec('PRAGMA query_only=ON');
    await expect(f.service.close()).rejects.toThrow('could not persist');
    replacement = await SalaamService.open({ stateDir: f.dir, ...fake() });
    expect(replacement.supervisor.inspect(session.id).state).toBe('exited');
  } finally {
    await replacement?.close();
    await f.close();
  }
});

test('a stale persisted ready row cannot advertise a missing worker', async () => {
  const f = await fixture(fake());
  try {
    const session = f.service.store.create(f.dir, 'stale');
    f.service.store.db
      .prepare("UPDATE sessions SET state='ready',capabilities='[\"managed-policy\"]' WHERE id=?")
      .run(session.id);
    expect(await call(f.service.socket, `/v1/sessions/${session.id}`)).toMatchObject({
      state: 'unhealthy',
      capabilities: [],
    });
    await expect(probe(f.service, session.id, {})).rejects.toThrow('not passed readiness');
  } finally {
    await f.close();
  }
});
