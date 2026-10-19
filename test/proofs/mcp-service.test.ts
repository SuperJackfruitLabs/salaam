import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mcpServiceFixture } from '../mcp-service-helpers.js';
import { client } from '../acp-helpers.js';
import { ready, until } from '../helpers.js';
import { call } from '../../src/transport.js';

const prompt = (sessionId: string, args: unknown, requestId = randomUUID()) => ({
  sessionId,
  prompt: [{ type: 'text', text: '[mcp] ' + JSON.stringify(args) }],
  _meta: { 'salaam.dev/requestId': requestId },
});
async function attach(f: Awaited<ReturnType<typeof mcpServiceFixture>>) {
  const a = client(f.state, {
    SALAAM_AGENTPOD_ADMISSION: f.admitted.admission_id,
    SALAAM_AGENTPOD_TOKEN: f.admitted.token,
  });
  try {
    await a.initialize({ _meta: { 'salaam.dev/features': { promptReceipts: 1, updateIds: 1 } } });
    await a.request('session/new', { cwd: f.workspace, mcpServers: [] });
    return a;
  } catch (error) {
    await a.close();
    throw error;
  }
}
test('actual Pi readiness requires private assignment; ACP reconnect and daemon restart preserve one MCP receipt', async () => {
  const f = await mcpServiceFixture();
  let a: ReturnType<typeof client> | undefined;
  try {
    await f.renew();
    await expect(f.service.supervisor.start(f.admitted.session_id)).rejects.toThrow(/MCP/i);
    expect(f.configs).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    await f.assign();
    a = await attach(f);
    const s = await ready(f.service, f.admitted.session_id);
    expect(s.capabilities).toContain('managed-mcp-v1');
    expect(JSON.stringify(f.configs)).not.toContain('X-Agentpod-Proxy-Key');
    expect(JSON.stringify(f.configs)).not.toContain(f.assignment.servers[0]!.headers[0]!.value);
    expect((f.configs.at(-1) as any).mcp).toMatchObject({
      profile_digest: f.profileDigest,
      credential_generation: 1,
    });
    const instruction = prompt(s.id, {
      action: 'call',
      server: 'superlibrary',
      tool: 'library_search',
      arguments: { query: 'offline scope' },
    });
    const result = await a.request('session/prompt', instruction);
    expect(result.stopReason).toBe('end_turn');
    expect(f.sent).toHaveLength(1);
    const saved = f.service.store.db
      .prepare('SELECT * FROM mcp_calls WHERE session_id=?')
      .all(s.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.state).toBe('returned');
    expect(f.service.artifacts.read(String(saved[0]!.result_artifact))).toContain(
      'Offline station memory 1',
    );
    await a.close();
    a = await attach(f);
    expect((await a.request('session/prompt', instruction))._meta['salaam.dev/attemptId']).toBe(
      result._meta['salaam.dev/attemptId'],
    );
    expect(f.sent).toHaveLength(1);
    await a.close();
    a = undefined;
    await f.reopen();
    await expect(f.service.supervisor.start(s.id)).rejects.toThrow(/authority|lease/i);
    await f.renew(2);
    await f.assign();
    a = await attach(f);
    expect((await a.request('session/prompt', instruction))._meta['salaam.dev/attemptId']).toBe(
      result._meta['salaam.dev/attemptId'],
    );
    expect(f.sent).toHaveLength(1);
    expect(readFileSync(f.service.store.session(s.id).pi_session_file!, 'utf8')).not.toContain(
      f.assignment.servers[0]!.headers[0]!.value,
    );
    expect(f.errors).toEqual([]);
  } finally {
    await a?.close();
    await f.close();
  }
}, 30000);

test('catalog drift fails worker readiness before launching Pi or granting a tool', async () => {
  const f = await mcpServiceFixture();
  try {
    await f.renew();
    await f.assign();
    f.mode.drift = true;
    await expect(f.service.supervisor.start(f.admitted.session_id)).rejects.toThrow(/readiness/i);
    expect(f.configs).toHaveLength(0);
    expect(f.sent).toHaveLength(0);
    expect(f.service.supervisor.inspect(f.admitted.session_id).capabilities).toEqual([]);
    expect(f.service.mcp!.stopped(f.admitted.session_id)).toBe(true);
  } finally {
    await f.close();
  }
});

test('invalid MCP arguments fail the tool without sending a call or invalidating worker readiness', async () => {
  const f = await mcpServiceFixture();
  let a: ReturnType<typeof client> | undefined;
  try {
    await f.renew();
    await f.assign();
    a = await attach(f);
    await ready(f.service, f.admitted.session_id);
    await expect(
      a.request(
        'session/prompt',
        prompt(f.admitted.session_id, {
          action: 'call',
          server: 'superlibrary',
          tool: 'library_search',
          arguments: { unknown: true },
        }),
      ),
    ).rejects.toThrow('Tool execution failed');
    expect(f.sent).toHaveLength(0);
    expect(f.service.supervisor.inspect(f.admitted.session_id).state).toBe('ready');
    expect(f.service.mcp!.status(f.admitted.session_id).control_error).toBeNull();
    await a.request(
      'session/prompt',
      prompt(f.admitted.session_id, {
        action: 'call',
        server: 'superlibrary',
        tool: 'library_search',
        arguments: { query: 'valid after error' },
      }),
    );
    expect(f.sent).toHaveLength(1);
  } finally {
    await a?.close();
    await f.close();
  }
});

test('turn cancellation accounts for MCP cleanup without revoking session authority', async () => {
  const f = await mcpServiceFixture();
  let a: ReturnType<typeof client> | undefined;
  try {
    await f.renew();
    await f.assign();
    a = await attach(f);
    await ready(f.service, f.admitted.session_id);
    f.mode.hold = true;
    const pending = a.request(
      'session/prompt',
      prompt(f.admitted.session_id, {
        action: 'call',
        server: 'superlibrary',
        tool: 'library_search',
        arguments: { query: 'cancel this read' },
      }),
    );
    void pending.catch(() => {});
    await until(
      () => f.sent.length,
      (n) => n === 1,
    );
    await a.request('session/cancel', { sessionId: f.admitted.session_id });
    await until(() => f.mode.disconnected, Boolean);
    const receipts = await until(
      () => f.service.cancellations.list(f.admitted.session_id),
      (r) => r[0]?.state === 'confirmed',
    );
    expect(receipts[0]!.unconfirmedResources).toEqual([]);
    expect(f.service.mcp!.stopped(f.admitted.session_id)).toBe(true);
    expect(f.service.agentpod!.inspect(f.binding).revoked).toBe(false);
    expect(f.sent).toHaveLength(1);
    await pending.catch(() => {});
  } finally {
    await a?.close();
    await f.close();
  }
}, 30000);

test('root revocation closes actual MCP response, stops Pi and retains an approved uncertain effect', async () => {
  const f = await mcpServiceFixture();
  let a: ReturnType<typeof client> | undefined;
  try {
    await f.renew();
    await f.assign();
    a = await attach(f);
    await ready(f.service, f.admitted.session_id);
    f.mode.hold = true;
    const running = a.request(
      'session/prompt',
      prompt(f.admitted.session_id, {
        action: 'call',
        server: 'superlibrary',
        tool: 'fixture_mutate',
        arguments: { query: 'offline approved write' },
      }),
    );
    void running.catch(() => {});
    const permission = await until(
      () => a!.messages.find((m) => m.method === 'session/request_permission'),
      Boolean,
    );
    expect(f.sent).toHaveLength(0);
    a.permission(permission!.id, true);
    await until(
      () => f.sent.length,
      (n) => n === 1,
    );
    await call(f.service.socket, '/v1/agentpod/revoke', {
      request_id: 'stop',
      binding: f.binding,
      reason: 'Offline root revocation proof',
    });
    const status = await until(
      () => call<any>(f.service.socket, '/v1/agentpod/status', { binding: f.binding }),
      (s) => s.owned_execution_stopped,
    );
    expect(status).toMatchObject({ revoked: true, authorized: false });
    expect(status.unresolved_operations).toHaveLength(1);
    await until(() => f.mode.disconnected, Boolean);
    expect(f.service.store.db.prepare('SELECT state FROM mcp_calls').get()!.state).toBe(
      'outcome_unknown',
    );
    expect(f.sent).toHaveLength(1);
    expect(f.errors).toEqual([]);
    await running.catch(() => {});
  } finally {
    await a?.close();
    await f.close();
  }
}, 30000);
