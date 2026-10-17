import { describe, expect, test } from 'vitest';
import { fixture, fake, create, ready, until, control, probe } from '../helpers.js';
import { call } from '../../src/transport.js';
import type { Session } from '../../src/protocol.js';
import { PiProcess } from '../../src/pi.js';

const repetitions = Number(process.env.SALAAM_PROOF_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100)
  throw new Error('Invalid proof repetition count');
describe.each(Array.from({ length: repetitions }, (_, index) => index + 1))(
  'S6 readiness admission run %s',
  () => {
    test.each([
      'missing',
      'wrong-version',
      'wrong-bundle',
      'wrong-policy',
      'wrong-session',
      'wrong-tools',
      'missing-context',
      'forged',
      'wrong-state',
    ])('refuses %s before any model request', async (mode) => {
      const f = await fixture(fake(mode));
      try {
        const session = f.service.store.create(f.dir, 'stored-before-start');
        const controller = await control(f.service, session.id);
        const accepted = await call(f.service.socket, `/v1/sessions/${session.id}/submissions`, {
          ...controller,
          request_id: 'queued',
          expected_revision: f.service.store.session(session.id).revision,
          text: 'Do not run before readiness',
        });
        expect(accepted).toMatchObject({ state: 'accepted' });
        void f.service.supervisor.start(session.id).catch(() => {});
        await until(
          () => call<Session>(f.service.socket, `/v1/sessions/${session.id}`),
          (x) => x.state === 'unhealthy',
        );
        await expect(probe(f.service, session.id, {})).rejects.toThrow('not passed readiness');
        const events = f.service.store.events(session.id, 0);
        expect(events.some((x) => x.kind === 'worker.ready')).toBe(false);
        expect(events.some((x) => x.kind === 'model.admitted')).toBe(false);
        expect(f.service.store.db.prepare('SELECT state FROM submissions').get()).toMatchObject({
          state: 'accepted',
        });
      } finally {
        await f.close();
      }
    });
    test('authenticates bridge identity and rejects stale epochs without granting work', async () => {
      let config: Record<string, unknown> = {};
      const launch = fake().launch!;
      const f = await fixture({
        launch: (args) => {
          config = JSON.parse(args.env.SALAAM_WORKER_CONFIG!);
          return launch(args);
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const path = `/worker/${session.id}/tool`;
        await expect(
          call(
            f.service.bridgeSocket,
            path,
            { epoch: config.epoch, tool: 'salaam_probe' },
            'x'.repeat(64),
          ),
        ).rejects.toThrow('credentials');
        await expect(
          call(
            f.service.bridgeSocket,
            path,
            { epoch: Number(config.epoch) - 1, tool: 'salaam_probe' },
            String(config.token),
          ),
        ).rejects.toThrow('epoch');
        expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'tool.granted')).toBe(
          false,
        );
        expect(f.service.supervisor.inspect(session.id).state).toBe('ready');
      } finally {
        await f.close();
      }
    });
    test('persistence failure revokes readiness before granting an effect', async () => {
      let config: Record<string, unknown> = {};
      const launch = fake().launch!;
      const f = await fixture({
        launch: (args) => {
          config = JSON.parse(args.env.SALAAM_WORKER_CONFIG!);
          return launch(args);
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        f.service.store.db.exec('PRAGMA query_only=ON');
        await expect(
          call(
            f.service.bridgeSocket,
            `/worker/${session.id}/tool`,
            { epoch: config.epoch, tool: 'salaam_probe' },
            String(config.token),
          ),
        ).rejects.toThrow('control unavailable');
        expect(f.service.supervisor.inspect(session.id)).toMatchObject({
          state: 'unhealthy',
          capabilities: [],
        });
        expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'tool.granted')).toBe(
          false,
        );
        f.service.store.db.exec('PRAGMA query_only=OFF');
      } finally {
        f.service.store.db.exec('PRAGMA query_only=OFF');
        await f.close();
      }
    });
    test('an unwritable journal prevents worker allocation', async () => {
      const f = await fixture(fake());
      try {
        const session = f.service.store.create(f.dir, 'stored-before-failure');
        f.service.store.db.exec('PRAGMA query_only=ON');
        await expect(f.service.supervisor.start(session.id)).rejects.toThrow();
        expect(f.service.supervisor.inspect(session.id)).toMatchObject({
          state: 'stopped',
          capabilities: [],
        });
        expect(f.service.store.db.prepare('SELECT count(*) AS n FROM workers').get()).toMatchObject(
          { n: 0 },
        );
      } finally {
        f.service.store.db.exec('PRAGMA query_only=OFF');
        await f.close();
      }
    });
    test('a revoked worker epoch cannot obtain another grant', async () => {
      let config: Record<string, unknown> = {};
      const launch = fake().launch!;
      const f = await fixture({
        launch: (args) => {
          config = JSON.parse(args.env.SALAAM_WORKER_CONFIG!);
          return launch(args);
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        f.service.store.transaction(() => {
          f.service.store.db
            .prepare(
              "UPDATE sessions SET epoch=epoch+1,state='unhealthy',capabilities='[]' WHERE id=?",
            )
            .run(session.id);
          f.service.store.event(session.id, 'worker.revoked', {});
        });
        await expect(
          call(
            f.service.bridgeSocket,
            `/worker/${session.id}/tool`,
            { epoch: config.epoch, tool: 'salaam_probe' },
            String(config.token),
          ),
        ).rejects.toThrow('epoch');
        expect(f.service.supervisor.inspect(session.id)).toMatchObject({
          state: 'unhealthy',
          capabilities: [],
        });
        expect(f.service.store.events(session.id, 0).some((x) => x.kind === 'tool.granted')).toBe(
          false,
        );
      } finally {
        await f.close();
      }
    });
    test('lost heartbeats invalidate a previously ready worker', async () => {
      const launch = fake().launch!;
      let child: PiProcess | undefined;
      const f = await fixture({
        heartbeatTimeout: 300,
        launch: (args) => {
          child = launch(args);
          return child;
        },
      });
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        process.kill(child!.child.pid!, 'SIGSTOP');
        const state = await until(
          () => f.service.supervisor.inspect(session.id),
          (x) => x.state === 'unhealthy',
        );
        expect(state.error).toContain('heartbeat');
      } finally {
        if (child?.child.pid)
          try {
            process.kill(child.child.pid, 'SIGCONT');
          } catch {}
        await f.close();
      }
    });
  },
);
