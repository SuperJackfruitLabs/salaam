import { test, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ready, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { permissionPolicy } from '../../src/autonomy.js';

// Phase 2b in a real terminal: Shift+Tab cycles the modes shown on the status line, leaving plan
// asks first, and full access is its own command with a warning.
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
    await terminal.write('\x1b[Z');
    await until(mode, (m) => m === 'plan');
    await terminal.contains('mode plan');
    // Leaving plan for a mode that can change files asks first; nothing changes until confirmed.
    await terminal.write('\x1b[Z');
    await terminal.contains('Leave plan mode?');
    expect(mode()).toBe('plan');
    // The confirm starts on Cancel: Enter alone keeps plan mode.
    await terminal.write('\r');
    await until(
      () => terminal!.screen(),
      (text) => !text.includes('Leave plan mode?'),
    );
    expect(mode()).toBe('plan');
    await terminal.write('\x1b[Z');
    await terminal.contains('Leave plan mode?');
    await terminal.write('\x1b[C');
    await terminal.contains('› switch mode');
    await terminal.write('\r');
    await until(mode, (m) => m === 'review');
    // Full access: a warning, then a confirm, then the status line says so.
    await terminal.write('\x1b[200~/full-access\x1b[201~\r');
    await terminal.contains('Turn on full access?');
    await terminal.contains('WITHOUT the OS sandbox');
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();
    await terminal.write('\x1b[C');
    await terminal.contains('› turn on full access');
    await terminal.write('\r');
    await until(
      () => permissionPolicy(f.service.store, id).access,
      (a) => a === 'full',
    );
    await terminal.contains('FULL ACCESS');
    await terminal.write('\x1b[200~/exit\x1b[201~\r');
    expect(await terminal.exit()).toMatchObject({ code: 0 });
  } finally {
    await terminal?.close();
    await client.leave();
    await f.close();
  }
}, 60000);

test('in plan mode the model receives the plan note with the instruction', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.open(id);
    const current = await client.permissions();
    await client.setPermissions(id, current.policy.revision, { mode: 'plan', paths: [] });
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
    expect(text.startsWith('[Plan mode')).toBe(true);
    expect(text.endsWith('add a test')).toBe(true);
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
