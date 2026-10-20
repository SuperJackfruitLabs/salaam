import { test, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fixture, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { call } from '../../src/transport.js';
import { SalaamService } from '../../src/service.js';
import type { Session } from '../../src/protocol.js';

test('local TUI session reads a real workspace through pinned Pi and recovers its admission', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-project-'));
  const client = new OperatorClient(f.dir);
  let replacement: SalaamService | undefined;
  try {
    writeFileSync(join(root, 'README.md'), 'Project BLUEBIRD\n');
    const id = await client.create(root, false);
    await until(
      async () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    expect(f.service.supervisor.inspect(id).capabilities).toContain('local-workspace-read');
    await client.submit('[workspace] {"action":"read","path":"README.md"}');
    await until(
      async () => f.service.store.snapshot(id),
      (s) => s.attempts.some((a) => a.state === 'completed'),
    );
    expect(f.service.store.events(id, 0).some((e) => e.kind === 'workspace.read')).toBe(true);
    expect(
      f.service.store
        .events(id, 0)
        .filter((e) => e.kind === 'policy.allowed')
        .map((e) => (e.payload as { tool: string }).tool),
    ).toContain('salaam_workspace');
    await client.leave();
    await f.service.close();
    replacement = await SalaamService.open({ stateDir: f.dir });
    expect(replacement.store.localWorkspace(id)).toBe(true);
    await replacement.supervisor.start(id);
    expect(replacement.supervisor.inspect(id).state).toBe('ready');
  } finally {
    await client.leave();
    await replacement?.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('a local model selection is durable and does not change other sessions or the default route', async () => {
  const f = await fixture({ anthropicApiKey: 'fixture-never-sent' });
  let replacement: SalaamService | undefined;
  try {
    const selected = { provider: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 2048 };
    const create = {
      request_id: randomUUID(),
      cwd: realpathSync(f.dir),
      local_workspace: true,
      route: selected,
    };
    const session = await call<Session>(f.service.socket, '/v1/sessions', create);
    await until(
      async () => f.service.supervisor.inspect(session.id),
      (s) => s.state === 'ready',
    );
    expect(f.service.store.providerRoute(session.id)).toEqual(selected);
    expect(f.service.supervisor.route.provider).toBe('salaam-proof');
    expect((await call<Session>(f.service.socket, '/v1/sessions', create)).id).toBe(session.id);
    await expect(
      call(f.service.socket, '/v1/sessions', {
        ...create,
        route: { ...selected, model: 'invalid' },
      }),
    ).rejects.toThrow();
    await f.service.close();
    replacement = await SalaamService.open({
      stateDir: f.dir,
      anthropicApiKey: 'fixture-never-sent',
    });
    await replacement.supervisor.start(session.id);
    expect(replacement.supervisor.inspect(session.id)).toMatchObject({
      state: 'ready',
      provider_route: selected,
    });
    expect(replacement.supervisor.route.provider).toBe('salaam-proof');
  } finally {
    await replacement?.close();
    await f.close();
  }
}, 30000);

test('real Pi local coding session uses durable approval and applies a reviewed edit', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-code-proof-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false, undefined, true);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    expect(f.service.supervisor.inspect(id).capabilities).toContain('local-coding-reviewed');
    await client.submit(
      '[local] ' +
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'hello.txt', sha256: null, content: 'Reviewed through Pi' }],
        }),
    );
    const approvals = await until(
      () => f.service.store.approvals(id),
      (a) => a.some((x) => x.state === 'pending'),
    );
    await client.decide(
      approvals.find((a) => a.state === 'pending')!,
      'approve',
    );
    await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts.some((a) => a.state === 'completed'),
    );
    expect(readFileSync(join(root, 'hello.txt'), 'utf8')).toBe('Reviewed through Pi');
    expect(
      f.service.store.db.prepare('SELECT state FROM local_calls WHERE session_id=?').get(id),
    ).toMatchObject({ state: 'succeeded' });
  } finally {
    await client.leave();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('real Pi local command cancellation stops the process and records non-success', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-code-cancel-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false, undefined, true);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    await client.submit('[local] ' + JSON.stringify({ action: 'command', command: 'sleep 20' }));
    const approvals = await until(
      () => f.service.store.approvals(id),
      (a) => a.some((x) => x.state === 'pending'),
    );
    await client.decide(
      approvals.find((a) => a.state === 'pending')!,
      'approve',
    );
    await until(
      () => f.service.store.db.prepare('SELECT state FROM local_calls WHERE session_id=?').get(id),
      (r) => r?.state === 'running',
    );
    const attempt = f.service.store.snapshot(id).attempts[0]!;
    await client.cancel(attempt.id);
    const row = await until(
      () => f.service.store.db.prepare('SELECT state FROM local_calls WHERE session_id=?').get(id),
      (r) => r?.state !== 'running',
    );
    expect(row?.state).toBe('cancelled');
    expect(f.service.store.operations(id)[0]?.state).not.toBe('succeeded');
  } finally {
    await client.leave();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
