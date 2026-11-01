import { test, expect } from 'vitest';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, ready, sandboxFallback, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { SalaamService } from '../../src/service/service.js';
import { permissionPolicy } from '../../src/runtime/autonomy.js';
test('real Pi executes only scoped edits automatically and permission policy survives daemon recovery', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let replacement: SalaamService | undefined;
  try {
    mkdirSync(join(f.dir, 'src'));
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.setPermissions(id, 0, { mode: 'scoped-edit', paths: ['src/'] });
    await client.submit(
      '[local] ' +
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'src/ok.txt', sha256: null, content: 'automatic within scope' }],
        }),
    );
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts[0]?.state === 'completed',
    );
    expect(readFileSync(join(f.dir, 'src/ok.txt'), 'utf8')).toBe('automatic within scope');
    expect(f.service.store.approvals(id)[0]?.decided_by).toBe('scoped-policy');
    expect(f.service.store.events(id, 0).some((e) => e.kind === 'permission.auto-approved')).toBe(
      true,
    );
    await client.leave();
    await f.service.close();
    replacement = await SalaamService.open({ stateDir: f.dir, ...sandboxFallback });
    expect(permissionPolicy(replacement.store, id)).toMatchObject({
      revision: 1,
      mode: 'scoped-edit',
      paths: ['src/'],
    });
    await client.open(id);
    await ready(replacement, id);
    await client.submit(
      '[local] ' + JSON.stringify({ action: 'command', command: 'echo needs-review' }),
    );
    const approval = await until(
      () => replacement!.store.approvals(id).find((a) => a.state === 'pending'),
      Boolean,
    );
    expect(approval!.decision).toBeNull();
    await client.decide(approval!, 'deny');
    await until(
      () => replacement!.store.snapshot(id),
      (s) => s.attempts.every((a) => !['accepted', 'running', 'dispatching'].includes(a.state)),
    );
    expect(permissionPolicy(replacement.store, id).revision).toBe(1);
  } finally {
    await client.leave();
    await replacement?.close();
    await f.close();
  }
}, 30000);

test('real terminal configures reviewed permissions separately from manual progression', async () => {
  const { PtyClient } = await import('../terminal-helpers.js');
  const { ROOT } = await import('../../src/core/config.js');
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  let terminal: InstanceType<typeof PtyClient> | undefined;
  try {
    const id = await client.create(realpathSync(f.dir), false, undefined, true);
    await ready(f.service, id);
    await client.leave();
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir, rows: 40, columns: 116 },
    );
    await terminal.contains('You have control');
    await terminal.write('\x1b[200~/permissions\x1b[201~\r');
    await terminal.contains('Permissions · review');
    await terminal.write('Auto-approve scoped edits\r');
    await terminal.contains('Auto-edit scopes');
    await terminal.write('src/\r');
    await terminal.contains('Review permission policy');
    expect(permissionPolicy(f.service.store, id).revision).toBe(0);
    await terminal.write('\r');
    await until(
      () => permissionPolicy(f.service.store, id).revision,
      (r) => r === 1,
    );
    await terminal.write('\x1b[200~/progression\x1b[201~\r');
    await terminal.contains('Progression · does not change permissions');
    await terminal.write('Manual steps\r');
    await terminal.contains('Manual instruction mode');
    expect(permissionPolicy(f.service.store, id)).toMatchObject({
      mode: 'scoped-edit',
      revision: 1,
      paths: ['src/'],
    });
    expect(f.service.store.snapshot(id).attempts).toHaveLength(0);
    expect(f.service.store.db.prepare('PRAGMA user_version').get()).toMatchObject({
      user_version: 28,
    });
    await terminal.write('\x1b[200~/exit\x1b[201~\r');
    expect(await terminal.exit()).toMatchObject({ code: 0 });
  } finally {
    await terminal?.close();
    await client.leave();
    await f.close();
  }
}, 30000);
