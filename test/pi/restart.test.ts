import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fixture, create, ready, until } from '../helpers.js';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import { ROOT } from '../../src/config.js';
import type { Session } from '../../src/protocol.js';

test('an explicitly resumed worker reuses the recorded Pi transcript', async () => {
  const f = await fixture();
  let resumed: SalaamService | undefined;
  try {
    const created = await create(f.service, f.dir);
    const original = await ready(f.service, created.id);
    await call(f.service.socket, `/v1/sessions/${created.id}/probe`, {});
    const count = f.service.store.db
      .prepare(
        "SELECT count(*) AS n FROM pi_entries WHERE json_extract(payload,'$.message.role')='user'",
      )
      .get();
    await f.service.close();
    resumed = await SalaamService.open({ stateDir: f.dir });
    await resumed.supervisor.start(created.id);
    const current = await ready(resumed, created.id);
    expect(current.pi_session_file).toBe(original.pi_session_file);
    expect(current.epoch).toBe(2);
    // Resuming does not submit a prompt or repeat a completed diagnostic.
    expect(
      resumed.store.db
        .prepare(
          "SELECT count(*) AS n FROM pi_entries WHERE json_extract(payload,'$.message.role')='user'",
        )
        .get(),
    ).toEqual(count);
    expect(
      resumed.store.events(created.id, 0).filter((x) => x.kind === 'model.admitted'),
    ).toHaveLength(2);
    expect(await resumed.supervisor.probe(created.id)).toEqual({
      text: 'Salaam readiness probe complete.',
    });
  } finally {
    await resumed?.close();
    await f.close();
  }
});

test('the state lock and worker fencing recover after abrupt service death', async () => {
  const dir = mkdtempSync('/tmp/sal-crash-');
  const child = spawn(
    process.execPath,
    [join(ROOT, 'dist/src/cli.js'), 'service', 'start', '--foreground', '--state', dir],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let replacement: SalaamService | undefined;
  try {
    await once(child.stdout, 'data');
    const socket = join(dir, 'operator.sock');
    const session = await call<Session>(socket, '/v1/sessions', {
      request_id: 'crash-create',
      cwd: dir,
    });
    await until(
      () => call<Session>(socket, `/v1/sessions/${session.id}`),
      (x) => x.state === 'ready',
    );
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    replacement = await SalaamService.open({ stateDir: dir });
    expect(replacement.supervisor.inspect(session.id).state).toBe('exited');
    expect(replacement.store.events(session.id, 0).some((x) => x.kind === 'model.admitted')).toBe(
      false,
    );
    // An empty Pi session has no file yet; resume must preserve its explicit ID.
    await replacement.supervisor.start(session.id);
    expect((await ready(replacement, session.id)).pi_session_id).toBe(session.id);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
    await replacement?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
