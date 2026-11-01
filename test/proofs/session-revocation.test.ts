import { expect, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { join } from 'node:path';
import { SalaamService } from '../../src/service/service.js';
import { ROOT } from '../../src/core/config.js';
import type { Session } from '../../src/core/protocol.js';
import type { SessionRevocation } from '../../src/store/execution-authority.js';
import { call } from '../../src/core/transport.js';
import { acquireControl } from '../../src/tui/attach.js';
import { control, create, fixture, ready, until } from '../helpers.js';

test('the installed CLI revokes a session and retrieves the same saved receipt without another controller', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const args = [
      join(ROOT, 'bin/salaam.mjs'),
      'session',
      'revoke',
      session.id,
      '--state',
      f.dir,
      '--reason',
      'Authority withdrawn',
      '--request-id',
      'cli-revoke',
    ];
    const first = await promisify(execFile)(process.execPath, args);
    const receipt = JSON.parse(
      first.stdout.trim().split('\n').slice(1).join('\n'),
    ) as SessionRevocation;
    expect(receipt).toMatchObject({ session_id: session.id, revoked: true });
    const repeated = await promisify(execFile)(process.execPath, args);
    expect(JSON.parse(repeated.stdout)).toEqual(receipt);
    expect(
      f.service.store.events(session.id, 0).filter((e) => e.kind === 'execution.revoked'),
    ).toHaveLength(1);
    const inspected = await promisify(execFile)(process.execPath, [
      join(ROOT, 'bin/salaam.mjs'),
      'session',
      'revocation',
      session.id,
      '--state',
      f.dir,
    ]);
    expect(JSON.parse(inspected.stdout)).toEqual(receipt);
    await expect(
      promisify(execFile)(
        process.execPath,
        args.map((a) => (a === 'Authority withdrawn' ? 'Changed authority' : a)),
      ),
    ).rejects.toThrow(/different reason/i);
  } finally {
    await f.close();
  }
});

test('session revocation fences active and queued work, survives reopening, and cannot be undone by controller takeover', async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const session = await create(service, f.dir);
    await ready(service, session.id);
    const c = await control(service, session.id);
    const acceptedRevision = service.store.session(session.id).revision;
    const active = service.store.accept(
      session.id,
      'active',
      acceptedRevision,
      '[review] target',
      c,
    );
    await until(
      () => service.store.approvals(session.id),
      (xs) => xs.some((x) => x.state === 'pending'),
    );
    const queued = service.store.accept(
      session.id,
      'queued',
      service.store.session(session.id).revision,
      'Must never run',
      c,
    );
    const body = {
      ...c,
      request_id: 'revoke',
      expected_revision: service.store.session(session.id).revision,
      reason: 'Work authority withdrawn',
    };
    const receipt = await until(
      async () => {
        body.expected_revision = service.store.session(session.id).revision;
        try {
          return await call<import('../../src/store/execution-authority.js').SessionRevocation>(
            service.socket,
            `/v1/sessions/${session.id}/revoke`,
            body,
          );
        } catch (error) {
          if ((error as { code?: string }).code === 'revision_conflict') return null;
          throw error;
        }
      },
      (r) => r !== null,
    );
    if (!receipt) throw Error('Missing revocation receipt');
    expect(receipt).toMatchObject({
      session_id: session.id,
      revoked: true,
      stop_confirmation: 'not_reported',
    });
    expect([...receipt.attempt_ids].sort()).toEqual([active.attempt_id, queued.attempt_id].sort());
    expect(service.store.approvals(session.id).every((x) => x.state !== 'pending')).toBe(true);
    await until(
      () => service.store.session(session.id).state,
      (s) => s === 'exited',
    );
    expect(service.store.attempt(queued.attempt_id).state).toBe('cancelled');
    expect(await call(service.socket, `/v1/sessions/${session.id}/revoke`, body)).toEqual(receipt);
    const admitted = service.store
      .events(session.id, 0)
      .filter((e) => e.kind === 'model.admitted').length;
    await service.close();
    service = await SalaamService.open({ stateDir: f.dir });
    const next = await control(service, session.id, true);
    expect(await call(service.socket, `/v1/sessions/${session.id}/revocation`)).toEqual(receipt);
    await expect(call(service.socket, `/v1/sessions/${session.id}/resume`, next)).rejects.toThrow(
      /revoked/i,
    );
    await expect(
      call(service.socket, `/v1/sessions/${session.id}/submissions`, {
        ...next,
        request_id: 'replacement',
        expected_revision: service.store.session(session.id).revision,
        text: 'Must not replace revoked work',
      }),
    ).rejects.toThrow(/revoked/i);
    // Saved acceptance remains a lookup, even after authority and controller changed.
    expect(
      service.store.accept(session.id, 'active', acceptedRevision, '[review] target', c),
    ).toEqual(active);
    expect(
      service.store.events(session.id, 0).filter((e) => e.kind === 'model.admitted'),
    ).toHaveLength(admitted);
    expect(service.store.snapshot(session.id).attempts).toHaveLength(2);
  } finally {
    await service.close();
    await f.close();
  }
});

test('failed revocation recording cannot acknowledge or abort running work', async () => {
  const f = await fixture();
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const c = await control(f.service, session.id);
    const work = f.service.store.accept(
      session.id,
      'active',
      f.service.store.session(session.id).revision,
      '[review] target',
      c,
    );
    await until(
      () => f.service.store.approvals(session.id),
      (xs) => xs.some((x) => x.state === 'pending'),
    );
    f.service.store.db.exec('PRAGMA query_only=ON');
    try {
      await expect(
        call(f.service.socket, `/v1/sessions/${session.id}/revoke`, {
          ...c,
          request_id: 'revoke',
          expected_revision: f.service.store.session(session.id).revision,
          reason: 'Revoke',
        }),
      ).rejects.toThrow();
      expect(f.service.store.execution.revocation(session.id)).toBeNull();
      expect(f.service.store.cancelled(work.attempt_id)).toBe(false);
      expect(f.service.store.session(session.id).state).toBe('ready');
      expect(f.service.store.approvals(session.id).some((x) => x.state === 'pending')).toBe(true);
    } finally {
      f.service.store.db.exec('PRAGMA query_only=OFF');
    }
  } finally {
    await f.close();
  }
});

test('daemon death after revocation commit and before process abort retains the fence and the exact retry receipt', async () => {
  const dir = mkdtempSync('/tmp/sal-revoke-crash-'),
    socket = join(dir, 'operator.sock');
  let daemon: ChildProcess | undefined, replacement: SalaamService | undefined;
  try {
    daemon = spawn(process.execPath, [join(ROOT, 'test/fixtures/revocation-service.mjs'), dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(daemon.stdout!, 'data');
    const session = await call<Session>(socket, '/v1/sessions', { request_id: 'create', cwd: dir });
    await until(
      () => call<Session>(socket, `/v1/sessions/${session.id}`),
      (s) => s.state === 'ready',
    );
    const lease = await acquireControl(socket, session.id, 'operator');
    const c = { client_id: 'operator', token: lease.token };
    await call(socket, `/v1/sessions/${session.id}/submissions`, {
      ...c,
      request_id: 'prompt',
      expected_revision: (await call<Session>(socket, `/v1/sessions/${session.id}`)).revision,
      text: 'Hold this tool',
    });
    await until(() => existsSync(join(dir, 'probe-entered')), Boolean);
    const body = {
      ...c,
      request_id: 'revoke',
      expected_revision: (await call<Session>(socket, `/v1/sessions/${session.id}`)).revision,
      reason: 'Run lease revoked',
    };
    let pending = call(socket, `/v1/sessions/${session.id}/revoke`, body).catch(() => {});
    await until(() => existsSync(join(dir, 'revocation-committed')), Boolean);
    const receipt = JSON.parse(
      readFileSync(join(dir, 'revocation-committed'), 'utf8'),
    ) as SessionRevocation;
    const exited = once(daemon, 'exit');
    daemon.kill('SIGKILL');
    await exited;
    await pending;
    replacement = await SalaamService.open({ stateDir: dir });
    expect(await call(socket, `/v1/sessions/${session.id}/revoke`, body)).toEqual(receipt);
    expect(replacement.store.attempt(receipt.attempt_ids[0]!).state).toBe('cancelled');
    await expect(replacement.supervisor.start(session.id)).rejects.toThrow(/revoked/i);
    expect(() =>
      replacement!.store.usage.admit(session.id, undefined, 'late', 'salaam-proof', 'proof'),
    ).toThrow(/revoked/i);
    expect(replacement.store.snapshot(session.id).attempts).toHaveLength(1);
  } finally {
    if (daemon?.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      daemon.kill('SIGKILL');
      await exited;
    }
    await replacement?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
