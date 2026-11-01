import { expect, test } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture, create, ready, until } from '../helpers.js';
import { submit } from '../managed-helpers.js';
import { ROOT } from '../../src/config.js';
import { PiProcess } from '../../src/pi.js';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import { digest, type Session } from '../../src/protocol.js';
import { assertModelRequestBoundary } from '../../src/worker-boundary.js';
import { NATIVE_CAPABILITIES } from '../../src/worker-binding.js';
import { PtyClient } from '../terminal-helpers.js';

const extensionPath = join(ROOT, 'test/fixtures/child-extension.mjs');
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function activeChild() {
  let credentials: { token: string; epoch: number } | undefined;
  const f = await fixture({
    extensionPath,
    launch(launch) {
      const config = JSON.parse(launch.env.SALAAM_WORKER_CONFIG!);
      if (config.child) credentials = { token: config.token, epoch: config.epoch };
      return new PiProcess(launch.command, launch.args, launch.cwd, launch.env);
    },
  });
  const parent = await create(f.service, f.dir);
  await ready(f.service, parent.id);
  const attempt = await submit(f.service, parent.id, '[children] boundary');
  const child = await until(
    () => f.service.children.list(parent.id)[0],
    (x) => !!x,
  );
  await until(() => existsSync(join(f.dir, 'child-' + child!.child_session)), Boolean);
  return { ...f, parent, attempt, child: child!, credentials: credentials! };
}

test('native worker admission freezes identity, input and authority; a lost reply resolves before a fresh invocation check', async () => {
  const f = await activeChild();
  try {
    const child = f.service.children.inspect(f.parent.id, f.child.id);
    const binding = child.worker!.binding;
    expect(binding).toMatchObject({
      schema_version: 1,
      runtime: 'native-pi',
      owner_session: f.parent.id,
      parent_attempt: f.attempt.attempt_id,
      session_id: child.child_session,
      attempt_id: child.child_attempt,
      step_key: child.step_key,
      tools: ['salaam_probe'],
      bounds: { scope: 'model-requests', requests: child.budget },
      capabilities: { files: false, commands: false, model_requests: true },
    });
    expect(binding.worker_id).not.toBe(child.child_session);
    expect(child.worker!.binding_digest).toBe(digest(binding));
    const prompt = f.service.store.db
      .prepare('SELECT text FROM submissions WHERE attempt_id=?')
      .get(child.child_attempt)!.text;
    expect(f.service.artifacts.read(binding.input_artifact!)).toBe(prompt);
    expect(child.worker).toMatchObject({ generation: 1, dispatch_state: 'accepted' });
    const replay = f.service.children.spawn(
      f.parent.id,
      -1,
      'expired-attempt',
      child.step_key,
      String(prompt),
      child.budget,
      ['salaam_probe'],
    );
    expect(replay.id).toBe(child.id);
    expect(f.service.children.list(f.parent.id)).toHaveLength(1);
    expect(() => f.service.children.inspect(randomUUID(), child.id)).toThrow('not found');
    expect(() =>
      f.service.store.workerBoundary.assert(
        { ...child, parent_session: randomUUID() },
        child.worker!.worker_epoch!,
        f.service.supervisor.route,
      ),
    ).toThrow('Frozen');
    expect(() =>
      f.service.store.workerBoundary.claim(
        child,
        child.worker!.worker_epoch!,
        f.service.supervisor.route,
      ),
    ).toThrow('replayed');
    expect(() =>
      f.service.store.workerBoundary.assert(
        child,
        child.worker!.worker_epoch! + 1,
        f.service.supervisor.route,
      ),
    ).toThrow('epoch');
    expect(f.service.store.snapshot(f.parent.id).children[0]!.worker!.binding.worker_id).toBe(
      binding.worker_id,
    );
  } finally {
    await f.close();
  }
});

test.each(['revoked-profile', 'changed-capabilities', 'changed-route', 'stale-generation'])(
  '%s fences the current worker and new grants without granting specialist tools',
  async (fault) => {
    const f = await activeChild();
    try {
      const before = f.service.store.workerBoundary.view(f.child.id);
      if (fault === 'revoked-profile')
        f.service.store.db.prepare('UPDATE worker_profiles SET revoked=1').run();
      else if (fault === 'stale-generation')
        f.service.store.db
          .prepare('UPDATE child_workers SET generation=generation+1 WHERE child_id=?')
          .run(f.child.id);
      else {
        const b = structuredClone(before.binding);
        if (fault === 'changed-route') b.route!.model = 'retargeted';
        else (b.capabilities as { files: boolean }).files = true;
        f.service.store.db
          .prepare('UPDATE child_workers SET binding=?,binding_digest=? WHERE child_id=?')
          .run(JSON.stringify(b), digest(b), f.child.id);
      }
      const grants = f.service.store.db
        .prepare(
          "SELECT count(*) AS n FROM events WHERE session_id=? AND kind IN ('tool.granted','model.admitted')",
        )
        .get(f.child.child_session);
      await expect(
        f.service.supervisor.bridge(f.child.child_session, 'tool', f.credentials.token, {
          epoch: f.credentials.epoch,
          tool: 'salaam_probe',
        }),
      ).rejects.toThrow('Required control unavailable');
      await until(
        () => f.service.children.inspect(f.parent.id, f.child.id),
        (x) => x.state === 'interrupted',
      );
      expect(f.service.supervisor.inspect(f.child.child_session).state).not.toBe('ready');
      expect(f.service.store.attempt(f.child.child_attempt).state).toBe('interrupted');
      expect(
        f.service.store.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE session_id=? AND kind IN ('tool.granted','model.admitted')",
          )
          .get(f.child.child_session),
      ).toEqual(grants);
      const events = f.service.store.db
        .prepare("SELECT payload FROM events WHERE session_id=? AND kind='tool.granted'")
        .all(f.child.child_session);
      expect(events.every((e) => JSON.parse(String(e.payload)).tool === 'salaam_probe')).toBe(true);
      expect(() =>
        f.service.store.workerBoundary.assert(
          f.child,
          before.worker_epoch!,
          f.service.supervisor.route,
        ),
      ).toThrow();
    } finally {
      await f.close();
    }
  },
);

test.each(['owner_session', 'generation', 'profile', 'missing'])(
  'readiness rejects an adapter fixture with forged %s',
  async (field) => {
    const f = await fixture({
      extensionPath,
      launch(launch) {
        const c = JSON.parse(launch.env.SALAAM_WORKER_CONFIG!);
        if (c.child) {
          if (field === 'missing') delete c.worker_binding;
          else if (field === 'generation') c.worker_binding.generation++;
          else if (field === 'profile') c.worker_binding.binding.profile.tools.push('salaam_files');
          else c.worker_binding.binding.owner_session = randomUUID();
        }
        return new PiProcess(launch.command, launch.args, launch.cwd, {
          ...launch.env,
          SALAAM_WORKER_CONFIG: JSON.stringify(c),
        });
      },
    });
    try {
      const parent = await create(f.service, f.dir);
      await ready(f.service, parent.id);
      await submit(f.service, parent.id, '[children] forged');
      const child = await until(
        () => f.service.children.list(parent.id)[0],
        (x) => x?.state === 'interrupted',
      );
      expect(
        f.service.store.db
          .prepare("SELECT count(*) AS n FROM events WHERE session_id=? AND kind='model.admitted'")
          .get(child!.child_session),
      ).toMatchObject({ n: 0 });
      expect(child!.worker!.dispatch_state).toBe('interrupted');
    } finally {
      await f.close();
    }
  },
);

test.each(['before-intent', 'after-intent', 'after-dispatch', 'after-acceptance'])(
  'daemon death %s never redelivers a child dispatch',
  async (fault) => {
    const dir = mkdtempSync('/tmp/sal-wb-');
    const daemon = spawn(
      process.execPath,
      [join(ROOT, 'test/fixtures/worker-boundary-service.mjs'), dir, fault],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let service: SalaamService | undefined;
    try {
      await once(daemon.stdout!, 'data');
      const socket = join(dir, 'operator.sock');
      const parent = await call<Session>(socket, '/v1/sessions', {
        request_id: 'parent',
        cwd: dir,
      });
      await until(
        () => call<Session>(socket, `/v1/sessions/${parent.id}`),
        (s) => s.state === 'ready',
      );
      const lease = await call<{ token: string }>(socket, `/v1/sessions/${parent.id}/control`, {
        request_id: 'control',
        client_id: 'test',
        action: 'acquire',
        expected_epoch: 0,
      });
      const current = await call<Session>(socket, `/v1/sessions/${parent.id}`);
      await call(socket, `/v1/sessions/${parent.id}/submissions`, {
        request_id: 'spawn',
        client_id: 'test',
        token: lease.token,
        expected_revision: current.revision,
        text: '[children] crash',
      });
      await until(() => existsSync(join(dir, 'boundary-pending')), Boolean);
      expect(readFileSync(join(dir, 'boundary-pending'), 'utf8')).toBe(fault);
      const before = new DatabaseSync(join(dir, 'journal.sqlite'));
      const rows = before.prepare('SELECT * FROM child_workers').all();
      before.close();
      expect(rows).toHaveLength(fault === 'before-intent' ? 0 : 1);
      const binding = rows[0]?.binding;
      await stop(daemon);
      service = await SalaamService.open({ stateDir: dir, extensionPath });
      const children = service.children.list(parent.id);
      expect(children).toHaveLength(fault === 'before-intent' ? 0 : 1);
      if (children[0]) {
        expect(children[0].state).toBe('interrupted');
        expect(JSON.parse(String(binding))).toEqual(children[0].worker!.binding);
        expect(children[0].worker!.dispatch_state).toBe('interrupted');
        expect(
          service.store.db
            .prepare(
              "SELECT count(*) AS n FROM events WHERE session_id=? AND kind='model.admitted'",
            )
            .get(children[0].child_session),
        ).toMatchObject({ n: 0 });
        await expect(service.supervisor.start(children[0].child_session)).rejects.toThrow();
      }
    } finally {
      await stop(daemon);
      await service?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('a refused station call records its method, action and refusal code, and nothing else', async () => {
  const f = await activeChild();
  try {
    await expect(
      f.service.supervisor.bridge(f.child.child_session, 'station.prepare', f.credentials.token, {
        epoch: f.credentials.epoch,
        tool_call_id: 'refused-call',
        args: {
          action: 'check',
          command: 'secret-command',
          path: '/etc/secret-path',
          content: 'secret-content',
        },
      }),
    ).rejects.toThrow();
    const rows = f.service.store.db
      .prepare("SELECT payload FROM events WHERE session_id=? AND kind='station.call_refused'")
      .all(f.child.child_session)
      .map((r) => JSON.parse(String(r.payload)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'station.prepare',
      action: 'check',
      code: 'station_disabled',
    });
    expect(JSON.stringify(rows)).not.toContain('secret');
  } finally {
    await f.close();
  }
});

test('opaque adapter capability fixture cannot satisfy model-request bounds even with no token budget', () => {
  assertModelRequestBoundary(NATIVE_CAPABILITIES);
  expect(() => assertModelRequestBoundary({ schema_version: 1, model_requests: false })).toThrow(
    'opaque workers need explicit invocation bounds',
  );
  expect(() => assertModelRequestBoundary({ schema_version: 99, model_requests: true })).toThrow(
    'Unsupported worker capability version',
  );
});

test('CLI and real PTY inspect the same native worker record after observer reconnect', async () => {
  const f = await activeChild();
  let terminal: PtyClient | undefined;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(ROOT, 'bin/salaam.mjs'),
      'children',
      'inspect',
      f.child.id,
      '--state',
      f.dir,
    ]);
    const view = JSON.parse(stdout);
    expect(view.worker.binding.worker_id).toBe(
      f.service.store.workerBoundary.view(f.child.id).binding.worker_id,
    );
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        f.parent.id,
        '--observe',
        '--state',
        f.dir,
      ],
      { state: f.dir, columns: 140, rows: 48 },
    );
    await terminal.contains('Observer');
    await terminal.write('\x0b');
    await terminal.contains('Salaam · actions');
    await terminal.write('Session context\r');
    await terminal.contains('salaam/diagnostic');
    await terminal.contains('generation 1');
    await terminal.contains('model requests');
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
    expect(f.service.children.list(f.parent.id)).toHaveLength(1);
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 30000);
