import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PiProcess } from '../../src/pi.js';
import { ROOT } from '../../src/config.js';
import { SalaamService } from '../../src/service.js';
import { providerRoute } from '../../src/provider-config.js';
import { create, ready, until, control } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { call } from '../../src/transport.js';

async function setup(mode = 'tool') {
  const dir = mkdtempSync('/tmp/sal-claude-');
  writeFileSync(join(dir, 'claude-mode'), mode);
  const mock = spawn(process.execPath, [join(ROOT, 'test/fixtures/mock-claude.mjs'), dir]);
  await once(mock.stdout, 'data');
  const stderr: string[] = [];
  const service = await SalaamService.open({
    launch: (launch) => {
      const pi = new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
      pi.child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      return pi;
    },
    stateDir: dir,
    providerRoute: providerRoute('anthropic', undefined, 512, 'workspace_fixture'),
    anthropicApiKey: 'fixture-anthropic-key',
    extensionPath: join(ROOT, 'test/fixtures/claude-extension.mjs'),
  });
  return {
    dir,
    mock,
    service,
    stderr,
    async stats() {
      const port = readFileSync(join(dir, 'claude-port'), 'utf8');
      return (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as {
        count: number;
        bodies: {
          body: Record<string, unknown>;
          authenticated: boolean;
          callback: boolean;
          workspace: string;
        }[];
      };
    },
    async close() {
      await service.close();
      const exit = once(mock, 'exit');
      mock.kill('SIGKILL');
      await exit;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('Claude streams through real Pi, executes a gated tool and accounts each provider request once', async () => {
  const f = await setup();
  try {
    const parent = await create(f.service, f.dir);
    const state = await ready(f.service, parent.id);
    expect(state.provider_route).toEqual(
      providerRoute('anthropic', undefined, 512, 'workspace_fixture'),
    );
    const work = await submit(f.service, parent.id, 'Run the managed probe, then reply.');
    const final = await until(
      () => f.service.store.attempt(work.attempt_id),
      (x) => ['completed', 'failed', 'interrupted'].includes(x.state),
    );
    expect(final).toMatchObject({ state: 'completed', result: 'Claude fixture complete.' });
    const stats = await f.stats();
    expect(stats.count).toBe(2);
    expect(existsSync(join(f.dir, 'callback-response'))).toBe(true);
    expect(existsSync(join(f.dir, 'callback-stream'))).toBe(true);
    expect(
      stats.bodies.every(
        (x) =>
          x.authenticated &&
          x.callback &&
          x.workspace === 'workspace_fixture' &&
          x.body.max_tokens === 512,
      ),
    ).toBe(true);
    expect(
      f.service.store.events(parent.id, 0).filter((x) => x.kind === 'tool.granted'),
    ).toHaveLength(1);
    const usage = f.service.store.usage.summary(parent.id);
    expect(usage).toMatchObject({
      observations: 2,
      unknown_observations: 0,
      estimated_observations: 2,
      known_output: 16,
    });
    const entries = f.service.store.db
      .prepare('SELECT payload FROM pi_entries WHERE session_id=?')
      .all(parent.id)
      .map((row) => JSON.parse(String(row.payload)));
    f.service.store.importEntries(
      parent.id,
      state.epoch,
      entries,
      f.service.store.session(parent.id).pi_leaf,
    );
    expect(f.service.store.usage.summary(parent.id)).toEqual(usage);
    expect(JSON.stringify(f.service.store.snapshot(parent.id))).not.toContain(
      'fixture-anthropic-key',
    );
  } finally {
    await f.close();
  }
});
test.each(['401', '429', 'drop'])(
  'Claude %s does not retry or leak provider error bodies',
  async (mode) => {
    const f = await setup(mode);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      const work = await submit(f.service, session.id, 'Say salaam');
      const final = await until(
        () => f.service.store.attempt(work.attempt_id),
        (x) => ['completed', 'failed', 'interrupted'].includes(x.state),
      );
      expect(final.state).toBe('failed');
      expect((await f.stats()).count).toBe(1);
      expect(f.service.store.usage.summary(session.id)).toMatchObject({
        observations: 1,
        unknown_observations: 1,
      });
      const transcript = readFileSync(f.service.store.session(session.id).pi_session_file!, 'utf8');
      expect(f.stderr.join('')).not.toContain('fixture-anthropic-key');
      expect(transcript).not.toContain('fixture-anthropic-key');
      expect(transcript).not.toContain('SECRET');
      expect(JSON.stringify(f.service.store.snapshot(session.id))).not.toContain(
        'fixture-anthropic-key',
      );
    } finally {
      await f.close();
    }
  },
);
test.each(['context-fault', 'payload-fault'])(
  '%s denies Claude before any HTTP request or model admission',
  async (mode) => {
    const f = await setup(mode);
    try {
      const session = await create(f.service, f.dir);
      await ready(f.service, session.id);
      await submit(f.service, session.id, 'Must not dispatch');
      await until(
        () => f.service.supervisor.inspect(session.id),
        (x) => x.state === 'unhealthy',
      );
      expect((await f.stats()).count).toBe(0);
      expect(
        f.service.store.events(session.id, 0).filter((x) => x.kind === 'model.admitted'),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);
test('cancelling an active Claude stream preserves unknown usage and keeps unrelated workers ready', async () => {
  const f = await setup('hold');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const other = await create(f.service, f.dir, 'other');
    await ready(f.service, other.id);
    const work = await submit(f.service, session.id, 'Wait for cancellation');
    await until(() => existsSync(join(f.dir, 'claude-entered')), Boolean);
    const controller = await control(f.service, session.id, true);
    await call(f.service.socket, `/v1/attempts/${work.attempt_id}/cancel`, {
      ...controller,
      request_id: 'cancel-claude',
      expected_revision: f.service.store.session(session.id).revision,
    });
    await until(
      () => f.service.store.attempt(work.attempt_id),
      (x) => x.state === 'cancelled',
    );
    expect(f.service.store.usage.summary(session.id)).toMatchObject({ unknown_observations: 1 });
    expect(f.service.supervisor.inspect(other.id).state).toBe('ready');
    expect((await f.stats()).count).toBe(1);
  } finally {
    await f.close();
  }
});

test('Claude child tasks inherit the pinned route and aggregate only their own provider executions', async () => {
  const f = await setup('children');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const work = await submit(f.service, session.id, 'Delegate one read-only greeting');
    await until(
      () => f.service.store.attempt(work.attempt_id),
      (x) => ['completed', 'failed', 'interrupted'].includes(x.state),
    );
    expect(f.service.store.attempt(work.attempt_id).state).toBe('completed');
    const children = f.service.children.list(session.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.state).toBe('completed');
    expect(f.service.supervisor.inspect(children[0]!.child_session).provider_route).toEqual(
      f.service.supervisor.route,
    );
    expect((await f.stats()).count).toBe(3);
    expect(f.service.store.usage.summary(session.id)).toMatchObject({
      observations: 3,
      unknown_observations: 0,
      estimated_observations: 3,
    });
  } finally {
    await f.close();
  }
});
test('Claude service death preserves the route and unknown request without replay; explicit continuation uses the same session', async () => {
  const f = await setup('hold');
  let serviceProcess: ReturnType<typeof spawn> | undefined;
  let replacement: SalaamService | undefined;
  try {
    await f.service.close();
    serviceProcess = spawn(process.execPath, [
      join(ROOT, 'test/fixtures/claude-service.mjs'),
      f.dir,
    ]);
    await once(serviceProcess.stdout!, 'data');
    const socket = join(f.dir, 'operator.sock');
    const session = await call<import('../../src/protocol.js').Session>(socket, '/v1/sessions', {
      request_id: 'create',
      cwd: f.dir,
    });
    await until(
      () => call<import('../../src/protocol.js').Session>(socket, `/v1/sessions/${session.id}`),
      (x) => x.state === 'ready',
    );
    const lease = await call<{ token: string }>(socket, `/v1/sessions/${session.id}/control`, {
      request_id: 'lease',
      client_id: 'test',
      action: 'acquire',
      expected_epoch: 0,
    });
    const current = await call<import('../../src/protocol.js').Session>(
      socket,
      `/v1/sessions/${session.id}`,
    );
    const work = await call<{ attempt_id: string }>(
      socket,
      `/v1/sessions/${session.id}/submissions`,
      {
        request_id: 'submit',
        client_id: 'test',
        token: lease.token,
        expected_revision: current.revision,
        text: 'Hold the stream',
      },
    );
    await until(() => existsSync(join(f.dir, 'claude-entered')), Boolean);
    const exited = once(serviceProcess, 'exit');
    serviceProcess.kill('SIGKILL');
    await exited;
    replacement = await SalaamService.open({
      stateDir: f.dir,
      providerRoute: providerRoute('anthropic', undefined, 512, 'workspace_fixture'),
      anthropicApiKey: 'fixture-anthropic-key',
      extensionPath: join(ROOT, 'test/fixtures/claude-extension.mjs'),
    });
    expect(replacement.store.attempt(work.attempt_id).state).toBe('interrupted');
    expect((await f.stats()).count).toBe(1);
    expect(replacement.store.usage.summary(session.id)).toMatchObject({
      observations: 1,
      unknown_observations: 1,
    });
    await replacement.supervisor.start(session.id);
    const controller = await control(replacement, session.id, true);
    writeFileSync(join(f.dir, 'claude-mode'), 'text');
    const continued = replacement.store.accept(
      session.id,
      'new-continuation',
      replacement.store.session(session.id).revision,
      'Continue with a greeting',
      controller,
      work.attempt_id,
    );
    await until(
      () => replacement!.store.attempt(continued.attempt_id),
      (x) => x.state === 'completed',
    );
    expect((await f.stats()).count).toBe(2);
    expect(replacement.store.usage.summary(session.id)).toMatchObject({
      observations: 2,
      unknown_observations: 1,
      estimated_observations: 1,
    });
    expect(replacement.store.session(session.id).epoch).toBe(2);
  } finally {
    if (serviceProcess && serviceProcess.exitCode === null && serviceProcess.signalCode === null) {
      const exit = once(serviceProcess, 'exit');
      serviceProcess.kill('SIGKILL');
      await exit;
    }
    await replacement?.close();
    await f.close();
  }
});

test('a failed usage-admission commit denies Claude HTTP dispatch and revokes readiness', async () => {
  const f = await setup('text');
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    f.service.store.db.exec(
      "CREATE TRIGGER deny_claude BEFORE INSERT ON usage_observations BEGIN SELECT RAISE(ABORT,'Injected admission failure'); END",
    );
    await submit(f.service, session.id, 'Must fail before dispatch');
    await until(
      () => f.service.supervisor.inspect(session.id),
      (x) => x.state === 'unhealthy',
    );
    expect((await f.stats()).count).toBe(0);
    expect(
      f.service.store.db.prepare('SELECT count(*) AS n FROM usage_observations').get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
