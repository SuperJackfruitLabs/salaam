import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fixture, create, ready, until } from '../helpers.js';
import { client } from '../acp-helpers.js';
import { ROOT } from '../../src/config.js';
import { AcpJournal } from '../../src/acp-journal.js';

const prompt = (text: string, requestId?: string) => ({
  prompt: [{ type: 'text', text }],
  ...(requestId ? { _meta: { 'salaam.dev/requestId': requestId } } : {}),
});

test('ACP v1 negotiates only supported features, shares CLI sessions and deduplicates logical prompts across client restarts', async () => {
  const f = await fixture();
  let a = client(f.dir);
  try {
    await expect(a.request('session/new', { cwd: f.dir, mcpServers: [] })).rejects.toThrow(
      'Initialize',
    );
    const init = await a.initialize();
    expect(init).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      authMethods: [],
    });
    await expect(
      a.request('session/new', { cwd: f.dir, mcpServers: [{ name: 'unsafe' }] }),
    ).rejects.toThrow('no extra MCP');
    const { sessionId } = await a.request('session/new', { cwd: f.dir, mcpServers: [] });
    await ready(f.service, sessionId);
    const logical = randomUUID();
    const result = await a.request('session/prompt', {
      sessionId,
      ...prompt('Salaam through ACP', logical),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(
      a.messages.filter((m) => m.params?.update?.sessionUpdate === 'user_message_chunk'),
    ).toHaveLength(0);
    const output = await promisify(execFile)(process.execPath, [
      join(ROOT, 'bin/salaam.mjs'),
      'session',
      'inspect',
      sessionId,
      '--state',
      f.dir,
    ]);
    const cli = JSON.parse(output.stdout);
    expect(cli.id).toBe(sessionId);
    expect(
      cli.messages.some((m: { text: string }) => m.text === 'Offline reply: Salaam through ACP'),
    ).toBe(true);
    const attempts = f.service.store.snapshot(sessionId).attempts;
    await a.close();
    a = client(f.dir);
    await a.initialize();
    await a.request('session/load', { sessionId, cwd: f.dir, mcpServers: [] });
    expect(
      a.messages.filter((m) => m.params?.update?.sessionUpdate === 'user_message_chunk'),
    ).toHaveLength(1);
    expect(
      a.messages.some(
        (m) => m.params?.update?.content?.text === 'Offline reply: Salaam through ACP',
      ),
    ).toBe(true);
    const repeated = await a.request('session/prompt', {
      sessionId,
      ...prompt('Salaam through ACP', logical),
    });
    expect(repeated._meta['salaam.dev/attemptId']).toBe(result._meta['salaam.dev/attemptId']);
    expect(f.service.store.snapshot(sessionId).attempts).toEqual(attempts);
    await expect(
      a.request('session/prompt', { sessionId, ...prompt('Changed input', logical) }),
    ).rejects.toThrow('another instruction');
    await expect(
      a.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow('Only text');
    expect(a.stderr()).toBe('');
  } finally {
    await a.close();
    await f.close();
  }
});

test('ACP routes concurrent bound permissions in reverse order, survives a disconnected approver and supports explicit cancellation', async () => {
  const f = await fixture();
  let a = client(f.dir);
  try {
    await a.initialize();
    const { sessionId } = await a.request('session/new', { cwd: f.dir, mcpServers: [] });
    await ready(f.service, sessionId);
    const pending = a.request('session/prompt', { sessionId, ...prompt('[review] alpha,beta') });
    // The caller disconnects without turning client loss into an approval or cancellation.
    void pending.catch(() => {});
    await until(
      () => a.messages.filter((m) => m.method === 'session/request_permission'),
      (x) => x.length === 2,
    );
    await a.close();
    const before = f.service.store.approvals(sessionId);
    expect(before.every((x) => x.state === 'pending')).toBe(true);
    a = client(f.dir);
    await a.initialize();
    await a.request('session/load', { sessionId, cwd: f.dir, mcpServers: [] });
    const requests = await until(
      () => a.messages.filter((m) => m.method === 'session/request_permission'),
      (x) => x.length === 2,
    );
    const beta = requests.find((r) => r.params.toolCall.rawInput.target === 'beta')!;
    const alpha = requests.find((r) => r.params.toolCall.rawInput.target === 'alpha')!;
    a.permission(beta.id as string, true);
    a.permission(alpha.id as string, false);
    await until(
      () => f.service.store.snapshot(sessionId).attempts[0]?.state,
      (x) => x === 'completed',
    );
    expect(
      f.service.store
        .approvals(sessionId)
        .map((x) => x.decision)
        .sort(),
    ).toEqual(['approve', 'deny']);
    expect(f.service.store.operations(sessionId).find((x) => x.target === 'beta')?.state).toBe(
      'succeeded',
    );
    expect(f.service.store.operations(sessionId).find((x) => x.target === 'alpha')?.state).toBe(
      'cancelled_before_dispatch',
    );
    const second = a.request('session/prompt', { sessionId, ...prompt('[review] cancel-target') });
    await until(
      () => f.service.store.approvals(sessionId).find((x) => x.state === 'pending'),
      Boolean,
    );
    a.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    expect((await second).stopReason).toBe('cancelled');
    expect(
      f.service.store.operations(sessionId).find((x) => x.target === 'cancel-target')?.state,
    ).toBe('cancelled_before_dispatch');
  } finally {
    await a.close();
    await f.close();
  }
});

test('ACP disconnect during a running tool preserves one attempt; resume omits old history and observes completion', async () => {
  const f = await fixture({ extensionPath: join(ROOT, 'test/fixtures/blocked-extension.mjs') });
  let a = client(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    await a.initialize();
    await a.request('session/resume', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
    void a
      .request('session/prompt', { sessionId: session.id, ...prompt('Keep running') })
      .catch(() => {});
    await until(() => existsSync(join(f.dir, 'probe-entered')), Boolean);
    const attempt = f.service.store.snapshot(session.id).attempts[0]!;
    await until(
      () =>
        a.messages.filter(
          (m) =>
            m.params?.update?.sessionUpdate === 'tool_call' &&
            m.params.update.status === 'in_progress',
        ),
      (messages) => messages.length > 0,
    );
    await a.close();
    expect(f.service.store.attempt(attempt.id).state).toBe('running');
    a = client(f.dir);
    await a.initialize();
    await a.request('session/resume', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
    expect(a.messages.filter((m) => m.method === 'session/update')).toHaveLength(0);
    writeFileSync(join(f.dir, 'release-probe'), 'release');
    await until(
      () =>
        a.messages.find((m) => m.params?.update?.content?.text === 'Offline reply: Keep running'),
      Boolean,
    );
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(1);
    expect(f.service.store.attempt(attempt.id).state).toBe('completed');
  } finally {
    await a.close();
    await f.close();
  }
});

test('an acceptance response lost before journaling is recovered by the next ACP client without another submission', async () => {
  const f = await fixture();
  let a = client(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const accept = f.service.store.accept.bind(f.service.store);
    let lost = true;
    f.service.store.accept = (...args) => {
      const result = accept(...args);
      if (lost) {
        lost = false;
        throw new Error('lost acceptance');
      }
      return result;
    };
    await a.initialize();
    await a.request('session/resume', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
    const logical = randomUUID();
    await expect(
      a.request('session/prompt', {
        sessionId: session.id,
        ...prompt('Recover acceptance', logical),
      }),
    ).rejects.toThrow('Service operation failed');
    expect(new AcpJournal(f.dir).pending(session.id)).toHaveLength(1);
    await a.close();
    a = client(f.dir);
    await a.initialize();
    await a.request('session/load', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
    expect(new AcpJournal(f.dir).pending(session.id)).toHaveLength(0);
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(1);
    const result = await a.request('session/prompt', {
      sessionId: session.id,
      ...prompt('Recover acceptance', logical),
    });
    expect(result.stopReason).toBe('end_turn');
    expect(f.service.store.snapshot(session.id).attempts).toHaveLength(1);
  } finally {
    await a.close();
    await f.close();
  }
});

test('ACP load replays the entire active branch beyond the terminal snapshot limit', async () => {
  const f = await fixture();
  const a = client(f.dir);
  try {
    const session = await create(f.service, f.dir);
    await ready(f.service, session.id);
    const entries = Array.from({ length: 140 }, (_, index) => ({
      id: 'history-' + index,
      type: 'message',
      parentId: index ? 'history-' + (index - 1) : null,
      message: {
        role: index % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: 'Replay history entry ' + index }],
      },
    }));
    f.service.store.importEntries(session.id, 1, entries, entries.at(-1)!.id);
    expect(f.service.store.snapshot(session.id).messages).toHaveLength(100);
    await a.initialize();
    await a.request('session/load', { sessionId: session.id, cwd: f.dir, mcpServers: [] });
    const messages = a.messages.filter((m) =>
      ['user_message_chunk', 'agent_message_chunk'].includes(m.params?.update?.sessionUpdate),
    );
    expect(messages).toHaveLength(140);
    expect(messages[0]!.params.update.content.text).toBe('Replay history entry 0');
    expect(messages.at(-1)!.params.update.content.text).toBe('Replay history entry 139');
  } finally {
    await a.close();
    await f.close();
  }
});
