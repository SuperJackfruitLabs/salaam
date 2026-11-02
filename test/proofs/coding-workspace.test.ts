import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SalaamService } from '../../src/service/service.js';
import { call } from '../../src/core/transport.js';
import { ready, control, until, fake } from '../helpers.js';
import { readTree } from '../../src/coding/workspaces.js';
import { digest, type Session, type SessionSnapshot } from '../../src/core/protocol.js';

test('real Pi earns file readiness, reads and patches the owned copy through the bridge', async () => {
  const dir = mkdtempSync('/tmp/sal-coding-'),
    source = join(dir, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'app.js'), 'export const value = 1;\n');
  const service = await SalaamService.open({
    stateDir: join(dir, 'state'),
    codingRoot: join(dir, 'owned'),
  });
  try {
    const session = await call<Session>(service.socket, '/v1/sessions', {
      request_id: 'create',
      cwd: source,
      coding: true,
    });
    expect((await ready(service, session.id)).capabilities).toContain('workspace-files');
    expect(service.supervisor.inspect(session.id).capabilities).not.toContain('command-execution');
    const controller = await control(service, session.id);
    const submit = async (request: string, args: unknown) => {
      const snapshot = service.store.session(session.id);
      const accepted = await call<{ attempt_id: string }>(
        service.socket,
        `/v1/sessions/${session.id}/submissions`,
        {
          ...controller,
          request_id: request,
          expected_revision: snapshot.revision,
          text: '[files] ' + JSON.stringify(args),
        },
      );
      return until(
        () => call<SessionSnapshot>(service.socket, `/v1/sessions/${session.id}/snapshot`),
        (x) =>
          x.attempts.some(
            (attempt) =>
              attempt.id === accepted.attempt_id && ['completed', 'failed'].includes(attempt.state),
          ),
      );
    };
    await submit('read', { action: 'read', path: 'app.js' });
    const w = service.workspaces.get(session.id),
      before = readTree(w.root);
    const result = await submit('patch', {
      action: 'patch',
      path: 'app.js',
      expected_revision: 0,
      expected_hash: digest(before['app.js']),
      content: 'export const value = 2;\n',
    });
    expect(result.attempts[0]?.state).toBe('completed');
    expect(service.workspaces.get(session.id).revision).toBe(1);
    expect(readFileSync(join(service.workspaces.get(session.id).root, 'app.js'), 'utf8')).toContain(
      '2',
    );
    expect(readFileSync(join(w.root, 'app.js'), 'utf8')).toContain('1');
    expect(readFileSync(join(source, 'app.js'), 'utf8')).toContain('1');
    const denied = await submit('escape', { action: 'read', path: '../secret' });
    expect(denied.attempts[0]?.state).toBe('failed');
    expect(service.supervisor.inspect(session.id).state).toBe('ready');
    const events = service.store.events(session.id, 0);
    expect(events.some((event) => event.kind === 'workspace.mutation_applied')).toBe(true);
    expect(events.some((event) => event.kind === 'workspace.tool_completed')).toBe(true);
  } finally {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(['missing-coding-binding', 'wrong-coding-profile', 'missing-file-capability'])(
  'coding readiness denies %s before provider/tool admission',
  async (mode) => {
    const dir = mkdtempSync('/tmp/sal-coding-ready-'),
      source = join(dir, 'source');
    mkdirSync(source);
    writeFileSync(join(source, 'a'), 'fixture');
    const service = await SalaamService.open({
      stateDir: join(dir, 'state'),
      codingRoot: join(dir, 'owned'),
      ...fake(mode),
    });
    try {
      const session = service.store.create(source, 'create', true);
      service.workspaces.import(session.id, source);
      void service.supervisor.start(session.id).catch(() => {});
      await until(
        () => service.supervisor.inspect(session.id),
        (x) => x.state === 'unhealthy',
      );
      expect(
        service.store
          .events(session.id, 0)
          .some((x) => ['model.admitted', 'tool.granted'].includes(x.kind)),
      ).toBe(false);
    } finally {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
