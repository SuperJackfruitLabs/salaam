import { test, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until, ready, control } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { conversationExport } from '../../src/tui/export.js';
import { call } from '../../src/core/transport.js';
import { ROOT } from '../../src/core/config.js';
import { PtyClient } from '../terminal-helpers.js';
import { SalaamService } from '../../src/service/service.js';
import type { Session } from '../../src/core/protocol.js';

test('local naming, native Pi fork, export and branch recovery preserve the source session', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let replacement: SalaamService | undefined;
  try {
    const id = await client.create(realpathSync(f.dir), false);
    await ready(f.service, id);
    await client.submit('Remember BLUEBIRD');
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts[0]?.state === 'completed',
    );
    await client.name('Research notes');
    expect(f.service.store.sessionName(id)).toBe('Research notes');
    await client.refresh();
    const parent = f.service.store.snapshot(id);
    const actor = await control(f.service, id, true);
    const body = {
      ...actor,
      request_id: 'fork-once',
      expected_revision: f.service.store.session(id).revision,
    };
    const branch = await call<Session>(f.service.socket, `/v1/sessions/${id}/fork`, body);
    expect((await call<Session>(f.service.socket, `/v1/sessions/${id}/fork`, body)).id).toBe(
      branch.id,
    );
    await f.service.supervisor.start(branch.id);
    await ready(f.service, branch.id);
    expect(f.service.store.snapshot(id).attempts).toEqual(parent.attempts);
    expect(
      f.service.store.snapshot(branch.id).messages.some((m) => m.text.includes('BLUEBIRD')),
    ).toBe(true);
    expect(await conversationExport(f.service.socket, branch.id)).toContain('BLUEBIRD');
    await client.leave();
    await f.service.close();
    replacement = await SalaamService.open({ stateDir: f.dir });
    expect(replacement.store.sessionName(id)).toBe('Research notes');
    await replacement.supervisor.start(branch.id);
    expect(replacement.supervisor.inspect(branch.id).state).toBe('ready');
  } finally {
    await client.leave();
    await replacement?.close();
    await f.close();
  }
}, 40000);

test('reviewed undo detects intervening edits and reverses actual files once', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.submit(
      '[local] ' +
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'new.txt', sha256: null, content: 'created' }],
        }),
    );
    const approval = await until(
      () => f.service.store.approvals(id).find((a) => a.state === 'pending'),
      Boolean,
    );
    await client.decide(approval!, 'approve');
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts[0]?.state === 'completed',
    );
    const review = await client.undoReview();
    writeFileSync(join(f.dir, 'new.txt'), 'human edit');
    await expect(client.undo(review)).rejects.toThrow();
    expect(readFileSync(join(f.dir, 'new.txt'), 'utf8')).toBe('human edit');
    writeFileSync(join(f.dir, 'new.txt'), 'created');
    const actor = await control(f.service, id, true);
    const body = { ...actor, request_id: 'undo-once', review_digest: review.digest };
    expect(await call(f.service.socket, `/v1/sessions/${id}/undo`, body)).toMatchObject({
      state: 'completed',
    });
    expect(existsSync(join(f.dir, 'new.txt'))).toBe(false);
    expect(await call(f.service.socket, `/v1/sessions/${id}/undo`, body)).toMatchObject({
      state: 'completed',
    });
  } finally {
    await client.leave();
    await f.close();
  }
}, 30000);

test('slash exit restores the terminal, leaves the daemon ready and never submits a model prompt', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let terminal: PtyClient | undefined;
  try {
    const id = await client.create(realpathSync(f.dir), false);
    await ready(f.service, id);
    await client.leave();
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir },
    );
    await terminal.contains('You have control');
    await terminal.write('/exit\r');
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(f.service.supervisor.inspect(id).state).toBe('ready');
    expect(f.service.store.snapshot(id).submissions).toHaveLength(0);
  } finally {
    await terminal?.close();
    await client.leave();
    await f.close();
  }
}, 30000);

test('steering is recorded once while a real Pi turn waits for review, and idle steering is rejected', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await expect(client.steer('idle guidance')).rejects.toThrow('active local');
    await client.submit(
      '[local] ' +
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'steer.txt', sha256: null, content: 'original turn' }],
        }),
    );
    await until(() => f.service.store.approvals(id).find((a) => a.state === 'pending'), Boolean);
    const actor = await control(f.service, id, true);
    const body = {
      ...actor,
      request_id: 'steer-once',
      text: 'Say BLUEBIRD after the current tool finishes.',
    };
    expect(await call(f.service.socket, `/v1/sessions/${id}/steer`, body)).toMatchObject({
      state: 'received',
    });
    expect(await call(f.service.socket, `/v1/sessions/${id}/steer`, body)).toMatchObject({
      state: 'received',
    });
    expect(f.service.store.events(id, 0).filter((e) => e.kind === 'steering.saved')).toHaveLength(
      1,
    );
    expect(f.service.store.snapshot(id).attempts).toHaveLength(1);
    const workers = (
      f.service.supervisor as unknown as {
        workers: Map<string, { pi: { command: (...args: any[]) => Promise<any> } }>;
      }
    ).workers;
    const pi = workers.get(id)!.pi,
      originalCommand = pi.command;
    let deliveries = 0;
    pi.command = async (type: string, ...args: any[]) => {
      if (type === 'steer') {
        deliveries++;
        throw new Error('Simulated lost acknowledgement');
      }
      return originalCommand.call(pi, type, ...args);
    };
    const uncertain = {
      ...body,
      request_id: 'steer-uncertain',
      text: 'Do not replay uncertain guidance.',
    };
    await expect(call(f.service.socket, `/v1/sessions/${id}/steer`, uncertain)).rejects.toThrow(
      'receipt was lost',
    );
    expect(await call(f.service.socket, `/v1/sessions/${id}/steer`, uncertain)).toMatchObject({
      state: 'delivery_unknown',
    });
    expect(deliveries).toBe(1);
    pi.command = originalCommand;
    const approval = f.service.store.approvals(id).find((a) => a.state === 'pending')!;
    await client.leave();
    await client.open(id, { takeover: true });
    await client.decide(approval, 'approve');
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts[0]?.state === 'completed',
    );
    expect(f.service.store.snapshot(id).messages.some((m) => m.text.includes('BLUEBIRD'))).toBe(
      true,
    );
  } finally {
    await client.leave();
    await f.close();
  }
}, 30000);

test('slash quit while waiting for approval preserves the same attempt across terminal reconnect', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let terminal: PtyClient | undefined;
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.submit(
      '[local] ' +
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'busy.txt', sha256: null, content: 'one effect' }],
        }),
    );
    await until(() => f.service.store.approvals(id).find((a) => a.state === 'pending'), Boolean);
    const attempt = f.service.store.snapshot(id).attempts[0]!.id;
    await client.leave();
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir },
    );
    await terminal.contains('You have control');
    await terminal.write('/quit\r');
    expect(await terminal.exit()).toEqual({ code: 0, restored: true });
    expect(f.service.store.attempt(attempt).state).toBe('running');
    await client.open(id);
    await client.decide(
      f.service.store.approvals(id).find((a) => a.state === 'pending')!,
      'approve',
    );
    await until(
      () => f.service.store.attempt(attempt).state,
      (s) => s === 'completed',
    );
    expect(f.service.store.snapshot(id).attempts).toHaveLength(1);
    expect(readFileSync(join(f.dir, 'busy.txt'), 'utf8')).toBe('one effect');
  } finally {
    await terminal?.close();
    await client.leave();
    await f.close();
  }
}, 30000);
