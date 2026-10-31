import { test, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ready, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { permissionPolicy } from '../../src/autonomy.js';

// Phase 2b in a real terminal (operator rulings 2026-10-31): Shift+Tab cycles review → accept edits →
// auto, full access is its own command with a warning, and YOLO needs the word typed.
test('real terminal cycles modes with shift+tab and turns on full access only after a warning', async () => {
  const { PtyClient } = await import('../terminal-helpers.js');
  const { ROOT } = await import('../../src/config.js');
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let terminal: InstanceType<typeof PtyClient> | undefined;
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.leave();
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir, rows: 40, columns: 140 },
    );
    await terminal.contains('You have control');
    await terminal.contains('mode review');
    const mode = () => permissionPolicy(f.service.store, id).mode;
    await terminal.write('\x1b[Z');
    await until(mode, (m) => m === 'accept-edits');
    await terminal.contains('mode accept edits');
    await terminal.write('\x1b[Z');
    await until(mode, (m) => m === 'auto');
    // Plan mode was removed (operator ruling 2026-10-31): auto cycles straight back to review.
    await terminal.write('\x1b[Z');
    await until(mode, (m) => m === 'review');
    await terminal.contains('mode review');
    // Full access: a warning, then a confirm, then the status line says so.
    await terminal.write('\x1b[200~/full-access\x1b[201~\r');
    await terminal.contains('Turn on full access?');
    await terminal.contains('WITHOUT the OS sandbox');
    await terminal.contains('dangerous');
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();
    await terminal.write('\x1b[C');
    await terminal.contains('› turn on full access');
    await terminal.write('\r');
    await until(
      () => permissionPolicy(f.service.store, id).access,
      (a) => a === 'full',
    );
    await terminal.contains('FULL ACCESS');
    await terminal.contains('Commands · full access');
    // YOLO needs the word typed: anything else leaves it off.
    await terminal.write('\x1b[200~/yolo\x1b[201~\r');
    await terminal.contains('Type yolo to confirm');
    await terminal.write('yes\r');
    await terminal.contains('YOLO stays off');
    expect(permissionPolicy(f.service.store, id).access).toBe('full');
    await terminal.write('\x1b[200~/yolo\x1b[201~\r');
    await terminal.contains('Type yolo to confirm');
    await terminal.write('yolo\r');
    await until(
      () => permissionPolicy(f.service.store, id).access,
      (a) => a === 'yolo',
    );
    await terminal.contains('YOLO');
    // Shift+Tab keeps YOLO; /yolo again turns it off.
    await terminal.write('\x1b[Z');
    await until(mode, (m) => m === 'accept-edits');
    expect(permissionPolicy(f.service.store, id).access).toBe('yolo');
    await terminal.write('\x1b[200~/yolo\x1b[201~\r');
    await until(
      () => permissionPolicy(f.service.store, id).access,
      (a) => a === undefined,
    );
    // The status line settles before the next command, so /exit is not typed into a busy prompt.
    await until(
      () => terminal!.screen(),
      (text) => !text.includes('YOLO'),
    );
    await terminal.write('\x1b[200~/exit\x1b[201~\r');
    expect(await terminal.exit()).toMatchObject({ code: 0 });
  } finally {
    await terminal?.close();
    await client.leave();
    await f.close();
  }
}, 60000);

test('an instruction reaches the model as typed: there is no plan note any more', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.open(id);
    await client.submit('add a test');
    await until(
      () => f.service.store.snapshot(id).attempts.length,
      (n) => n > 0,
    );
    const text = String(
      f.service.store.db
        .prepare('SELECT text FROM submissions WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
        .get(id)!.text,
    );
    expect(text).toBe('add a test');
  } finally {
    await client.leave();
    await f.close();
  }
}, 30000);

test('a service that does not allow full access refuses it, and says so', async () => {
  const f = await fixture({ allowFullAccessSessions: false }),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.open(id);
    const current = await client.permissions();
    expect(current.full_access_allowed).toBe(false);
    // Approval rules and auto mode can approve commands in a desk coding session (Phase 2a/2b).
    expect(current.command_auto_approval).toBe(true);
    await expect(
      client.setPermissions(id, current.policy.revision, {
        mode: 'review',
        paths: [],
        access: 'full',
      }),
    ).rejects.toThrow('operator');
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();
  } finally {
    await client.leave();
    await f.close();
  }
}, 30000);

test('a service that does not allow YOLO refuses it, and says so', async () => {
  const f = await fixture({ allowYoloSessions: false }),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.open(id);
    const current = await client.permissions();
    expect(current.yolo_allowed).toBe(false);
    await expect(
      client.setPermissions(id, current.policy.revision, {
        mode: 'review',
        paths: [],
        access: 'yolo',
      }),
    ).rejects.toThrow('operator');
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();
  } finally {
    await client.leave();
    await f.close();
  }
}, 30000);

// Integration report 2026-10-31: a terminal killed while holding control left the next `salaam code`
// as an observer. The client now waits out a lapsing lease once; a renewing one still keeps control.
test('a lease left by a killed terminal is waited out; a live one is not taken', async () => {
  const f = await fixture(),
    first = new OperatorClient(f.dir);
  try {
    const id = await first.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await first.leave();
    // A terminal that took control and then died: its lease is never renewed.
    const epoch = f.service.store.controlView(id).epoch;
    f.service.store.control(id, 'dead-terminal', 'dead-client', 'acquire', epoch, undefined, 3000);
    const next = new OperatorClient(f.dir);
    const started = Date.now();
    await next.open(id);
    expect(f.service.store.controlView(id).client_id).toBe(next.clientId);
    expect(Date.now() - started).toBeGreaterThan(2000);
    expect(next.notice).toContain('previous terminal had stopped');
    await next.leave();
    // A live holder (its lease far from lapsing) keeps control; the newcomer observes and is told how.
    const live = f.service.store.controlView(id).epoch;
    f.service.store.control(id, 'live-terminal', 'live-client', 'acquire', live, undefined, 600000);
    const observer = new OperatorClient(f.dir);
    await observer.open(id);
    expect(f.service.store.controlView(id).client_id).toBe('live-client');
    expect(observer.notice).toContain('Take control');
    await observer.leave();
  } finally {
    await f.close();
  }
}, 30000);
