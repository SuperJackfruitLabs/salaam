import { describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { fixture, create, ready, until, control } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';
import { Outbox, subscribe, acquireControl } from '../../src/attach.js';
import { SalaamService } from '../../src/service.js';
import type { Session, SessionSnapshot } from '../../src/protocol.js';

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  child.kill('SIGKILL');
  await exit;
}
const rows = (service: SalaamService, table: string) =>
  service.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get();

const repetitions = Number(process.env.SALAAM_ATTACH_REPETITIONS ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20)
  throw new Error('Invalid attachment proof repetition count');
describe.each(Array.from({ length: repetitions }, (_, index) => index + 1))(
  'S1 attachment run %s',
  () => {
    test('S1: killing a terminal during a real tool turn and reattaching runs one prompt once', async () => {
      const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
      let terminal: ChildProcess | undefined;
      let observer: ChildProcess | undefined;
      try {
        const session = await create(f.service, f.dir);
        const original = await ready(f.service, session.id);
        terminal = spawn(process.execPath, [
          join(ROOT, 'dist/src/cli.js'),
          'attach',
          session.id,
          '--state',
          f.dir,
        ]);
        let terminalOutput = '';
        terminal.stdout!.on('data', (chunk) => {
          terminalOutput += chunk;
        });
        await until(
          () => terminalOutput,
          (value) => value.includes('Attached to'),
        );
        terminal.stdin!.write('Salaam 🌍\u2028same session\n');
        await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
        const active = f.service.store.snapshot(session.id).attempts[0]!;
        expect(active.state).toBe('running');
        await kill(terminal);
        expect(f.service.supervisor.inspect(session.id)).toMatchObject({
          state: 'ready',
          epoch: original.epoch,
        });
        observer = spawn(process.execPath, [
          join(ROOT, 'dist/src/cli.js'),
          'attach',
          session.id,
          '--observe',
          '--state',
          f.dir,
        ]);
        let observed = '';
        observer.stdout!.on('data', (chunk) => {
          observed += chunk;
        });
        await until(
          () => observed,
          (value) => value.includes('Attached to'),
        );
        writeFileSync(join(f.dir, 'release-probe'), 'go');
        await until(
          () => observed,
          (value) => value.includes('assistant> Offline reply: Salaam 🌍\u2028same session'),
        );
        expect(observed.match(/assistant> Offline reply:/g)).toHaveLength(1);
        expect(rows(f.service, 'submissions')).toMatchObject({ n: 1 });
        expect(rows(f.service, 'attempts')).toMatchObject({ n: 1 });
        const events = f.service.store.events(session.id, 0);
        expect(events.filter((event) => event.kind === 'tool.granted')).toHaveLength(1);
        expect(events.filter((event) => event.kind === 'tool.granted')[0]!.payload).toMatchObject({
          attempt_id: active.id,
        });
        const transcript = readFileSync(original.pi_session_file!, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(transcript.filter((entry) => entry.message?.role === 'user')).toHaveLength(1);
        expect(
          f.service.store
            .snapshot(session.id)
            .messages.filter((message) => message.role === 'user'),
        ).toHaveLength(1);
        // A new controller acquires the same session explicitly; it does not resend.
        const lease = await acquireControl(f.service.socket, session.id, 'replacement', true);
        expect(lease.epoch).toBeGreaterThan(1);
        expect(f.service.store.attempt(active.id).state).toBe('completed');
        expect(f.service.supervisor.inspect(session.id).pi_session_file).toBe(
          original.pi_session_file,
        );
      } finally {
        if (terminal) await kill(terminal);
        if (observer) await kill(observer);
        await f.close();
      }
    });

    test('lost acceptance response survives a fresh outbox and controller with no duplicate work', async () => {
      const f = await fixture();
      let drop = true;
      const proxy = createServer((incoming, outgoing) => {
        const upstream = request(
          {
            socketPath: f.service.socket,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          },
          (response) => {
            if (drop && incoming.url?.endsWith('/submissions')) {
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
        const first = await control(f.service, session.id);
        const outbox = new Outbox(f.dir, session.id);
        const record = outbox.enqueue(
          'Only once despite a lost reply',
          f.service.store.session(session.id).revision,
        );
        const socket = join(f.dir, 'proxy.sock');
        await new Promise<void>((resolve) => proxy.listen(socket, resolve));
        await expect(outbox.flush(socket, session.id, first)).rejects.toThrow();
        expect(new Outbox(f.dir, session.id).records()).toEqual([record]);
        await until(
          () => f.service.store.snapshot(session.id).attempts[0]?.state,
          (state) => state === 'completed',
        );
        const second = await control(f.service, session.id, true);
        // Cached response wins over both the old revision and the revoked lease.
        await new Outbox(f.dir, session.id).flush(f.service.socket, session.id, second);
        expect(outbox.records()).toHaveLength(0);
        expect(rows(f.service, 'submissions')).toMatchObject({ n: 1 });
        expect(rows(f.service, 'attempts')).toMatchObject({ n: 1 });
        expect(
          f.service.store.events(session.id, 0).filter((event) => event.kind === 'tool.granted'),
        ).toHaveLength(1);
        await expect(
          call(f.service.socket, `/v1/sessions/${session.id}/submissions`, { ...record, ...first }),
        ).resolves.toMatchObject({ state: 'accepted' });
        await expect(
          call(f.service.socket, `/v1/sessions/${session.id}/submissions`, {
            ...record,
            ...second,
            text: 'changed',
          }),
        ).rejects.toThrow('different input');
        await expect(
          call(f.service.socket, `/v1/sessions/${session.id}/submissions`, {
            ...record,
            ...first,
            request_id: 'new',
          }),
        ).rejects.toThrow('controller lease');
      } finally {
        proxy.closeAllConnections();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await f.close();
      }
    });

    test('service death during a real prompt interrupts it, fences its worker and requires a new instruction', async () => {
      const dir = mkdtempSync('/tmp/sal-m3-crash-');
      const child = spawn(
        process.execPath,
        [join(ROOT, 'test/fixtures/blocked-service.mjs'), dir],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let replacement: SalaamService | undefined;
      try {
        await once(child.stdout!, 'data');
        const socket = join(dir, 'operator.sock');
        const session = await call<Session>(socket, '/v1/sessions', {
          request_id: 'create',
          cwd: dir,
        });
        const snapshot = await until(
          () => call<Session>(socket, `/v1/sessions/${session.id}`),
          (s) => s.state === 'ready',
        );
        const lease = await acquireControl(socket, session.id, 'before-crash');
        const controller = { client_id: 'before-crash', token: lease.token };
        const submit = async (request_id: string, text: string) => {
          const state = await call<SessionSnapshot>(socket, `/v1/sessions/${session.id}/snapshot`);
          return call<{ attempt_id: string }>(socket, `/v1/sessions/${session.id}/submissions`, {
            ...controller,
            request_id,
            text,
            expected_revision: state.revision,
          });
        };
        const active = await submit('active', 'Do this once');
        await until(() => existsSync(join(dir, 'probe-entered')), Boolean);
        const queued = await submit('queued', 'Later queued work');
        await kill(child);
        replacement = await SalaamService.open({ stateDir: dir });
        expect(replacement.store.attempt(active.attempt_id).state).toBe('interrupted');
        expect(replacement.store.attempt(queued.attempt_id).state).toBe('accepted');
        const resumed = await control(replacement, session.id);
        await call(replacement.socket, `/v1/sessions/${session.id}/resume`, resumed);
        await ready(replacement, session.id);
        expect(replacement.supervisor.inspect(session.id).pi_session_file).toBe(
          snapshot.pi_session_file,
        );
        expect(await replacement.supervisor.dispatchNext(session.id)).toBe(false);
        const previousGrants = replacement.store
          .events(session.id, 0)
          .filter((e) => e.kind === 'tool.granted').length;
        const follow = replacement.store.accept(
          session.id,
          'continue',
          replacement.store.session(session.id).revision,
          'Inspect the interrupted result and continue with this new instruction',
          resumed,
          active.attempt_id,
        );
        await until(
          () => replacement!.store.attempt(follow.attempt_id).state,
          (state) => state === 'completed',
        );
        await until(
          () => replacement!.store.attempt(queued.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(replacement.store.attempt(active.attempt_id)).toMatchObject({
          state: 'interrupted',
          resolved_by: follow.attempt_id,
        });
        const dispatches = replacement.store
          .events(session.id, 0)
          .filter((e) => e.kind === 'attempt.dispatching')
          .map((e) => (e.payload as { attempt_id: string }).attempt_id);
        expect(dispatches).toEqual([active.attempt_id, follow.attempt_id, queued.attempt_id]);
        expect(
          replacement.store.events(session.id, 0).filter((e) => e.kind === 'tool.granted'),
        ).toHaveLength(previousGrants + 2);
        const transcript = readFileSync(snapshot.pi_session_file!, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(transcript.filter((entry) => entry.message?.role === 'user')).toHaveLength(3);
      } finally {
        await kill(child);
        await replacement?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('reconnecting event consumers replay one committed completion from their last cursor', async () => {
      const f = await fixture();
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const controller = await control(f.service, session.id);
        const before = f.service.store.snapshot(session.id);
        const feed = subscribe(f.service.socket, session.id, before.seq, () => {});
        feed.close();
        await feed.done;
        f.service.store.accept(
          session.id,
          'submit',
          before.revision,
          'While disconnected',
          controller,
        );
        await until(
          () => f.service.store.snapshot(session.id).attempts[0]?.state,
          (state) => state === 'completed',
        );
        const received: number[] = [];
        const replay = subscribe(f.service.socket, session.id, before.seq, (event) => {
          if (event.kind === 'attempt.completed') received.push(event.seq);
        });
        await until(
          () => received.length,
          (n) => n === 1,
        );
        replay.close();
        await replay.done;
        const events = f.service.store.events(session.id, received[0]!);
        expect(events.filter((event) => event.kind === 'attempt.completed')).toHaveLength(0);
      } finally {
        await f.close();
      }
    });

    test('a crash after Pi settles but before completion commits never infers success or replays', async () => {
      const dir = mkdtempSync('/tmp/sal-complete-gap-');
      writeFileSync(join(dir, 'release-probe'), 'go');
      const child = spawn(
        process.execPath,
        [join(ROOT, 'test/fixtures/blocked-service.mjs'), dir, 'completion-gap'],
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
        const readyState = await until(
          () => call<Session>(socket, `/v1/sessions/${session.id}`),
          (state) => state.state === 'ready',
        );
        const lease = await acquireControl(socket, session.id, 'client');
        const before = await call<Session>(socket, `/v1/sessions/${session.id}`);
        const accepted = await call<{ attempt_id: string }>(
          socket,
          `/v1/sessions/${session.id}/submissions`,
          {
            request_id: 'submit',
            expected_revision: before.revision,
            text: 'Finish once',
            client_id: 'client',
            token: lease.token,
          },
        );
        await until(() => existsSync(join(dir, 'completion-pending')), Boolean);
        expect(readFileSync(readyState.pi_session_file!, 'utf8')).toContain(
          'Offline reply: Finish once',
        );
        await kill(child);
        replacement = await SalaamService.open({ stateDir: dir });
        expect(replacement.store.attempt(accepted.attempt_id)).toMatchObject({
          state: 'interrupted',
          result: null,
        });
        expect(
          replacement.store
            .events(session.id, 0)
            .some((event) => event.kind === 'attempt.completed'),
        ).toBe(false);
        await replacement.supervisor.start(session.id);
        expect(await replacement.supervisor.dispatchNext(session.id)).toBe(false);
        expect(
          replacement.store.events(session.id, 0).filter((event) => event.kind === 'tool.granted'),
        ).toHaveLength(1);
      } finally {
        await kill(child);
        await replacement?.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('graceful shutdown during a prompt preserves an interruption that can be explicitly continued', async () => {
      const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
      let replacement: SalaamService | undefined;
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const controller = await control(f.service, session.id);
        const active = f.service.store.accept(
          session.id,
          'active',
          f.service.store.session(session.id).revision,
          'Before graceful shutdown',
          controller,
        );
        await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
        await f.service.close();
        replacement = await SalaamService.open({ stateDir: f.dir });
        expect(replacement.supervisor.inspect(session.id).state).toBe('exited');
        expect(replacement.store.attempt(active.attempt_id).state).toBe('interrupted');
        const resumed = await control(replacement, session.id);
        const follow = replacement.store.accept(
          session.id,
          'continue',
          replacement.store.session(session.id).revision,
          'Continue with this new instruction',
          resumed,
          active.attempt_id,
        );
        await call(replacement.socket, `/v1/sessions/${session.id}/resume`, resumed);
        await until(
          () => replacement!.store.attempt(follow.attempt_id).state,
          (state) => state === 'completed',
        );
        expect(replacement.store.attempt(active.attempt_id).state).toBe('interrupted');
      } finally {
        await replacement?.close();
        await f.close();
      }
    });

    test('definitively rejected continuation input is retained separately and does not block later input', async () => {
      const f = await fixture();
      try {
        const session = await create(f.service, f.dir);
        await ready(f.service, session.id);
        const controller = await control(f.service, session.id);
        const outbox = new Outbox(f.dir, session.id);
        const invalid = outbox.enqueue(
          'Invalid continuation',
          f.service.store.session(session.id).revision,
          'missing-attempt',
        );
        await expect(outbox.flush(f.service.socket, session.id, controller)).rejects.toThrow(
          'rejected input saved',
        );
        expect(outbox.records()).toHaveLength(0);
        expect(
          readFileSync(join(outbox.dir, invalid.request_id + '.rejected.json'), 'utf8'),
        ).toContain('Invalid continuation');
        outbox.enqueue('A valid new instruction', f.service.store.session(session.id).revision);
        await outbox.flush(f.service.socket, session.id, controller);
        await until(
          () => f.service.store.snapshot(session.id).attempts[0]?.state,
          (state) => state === 'completed',
        );
        expect(rows(f.service, 'attempts')).toMatchObject({ n: 1 });
      } finally {
        await f.close();
      }
    });
  },
);
