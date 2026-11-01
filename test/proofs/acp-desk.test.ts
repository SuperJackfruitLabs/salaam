import { test, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { call } from '../../src/core/transport.js';
import { ROOT } from '../../src/core/config.js';
import { deskRoute } from '../../src/acp/desk.js';
import { OFFLINE_ROUTE } from '../../src/core/provider-route.js';
import { join } from 'node:path';
import { fixture, until, ready } from '../helpers.js';
import { client } from '../acp-helpers.js';
import { permissionPolicy } from '../../src/runtime/autonomy.js';
import { localHash } from '../../src/local/edits.js';

type Message = Record<string, any>;
const updates = (messages: Message[], kind: string) =>
  messages.filter((m) => m.params?.update?.sessionUpdate === kind).map((m) => m.params.update);

/** Zed (or any ACP editor) on your desk session in the project folder: modes, approvals with
 * diffs and a session rule, finished edits as diffs, and /rewind for files. */
test('an editor drives the desk session: modes, diffs, session rules and rewind', async () => {
  const f = await fixture(),
    a = client(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    await a.initialize();
    const created = await a.request('session/new', {
      cwd: root,
      mcpServers: [],
      _meta: { 'salaam.dev/local': true },
    });
    const id = created.sessionId as string;
    await ready(f.service, id);
    expect(f.service.store.localCoding(id)).toBe(true);
    expect(created.modes.currentModeId).toBe('review');
    expect(created.modes.availableModes.map((m: { id: string }) => m.id)).toEqual([
      'review',
      'accept-edits',
      'auto',
      'full-access',
    ]);
    expect(created.configOptions[0]).toMatchObject({
      id: 'mode',
      category: 'mode',
      currentValue: 'review',
    });
    await until(
      () => updates(a.messages, 'available_commands_update')[0],
      (u) => u?.availableCommands?.[0]?.name === 'rewind',
    );

    // Review mode asks; the prompt shows why and the exact diff, and offers a session rule.
    const edit = (content: string, before: string | null = null) =>
      '[local] ' +
      JSON.stringify({
        action: 'edit',
        edits: [{ path: 'one.txt', sha256: before === null ? null : localHash(before), content }],
      });
    const first = a.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: edit('turn one\n') }],
    });
    const asked = await until(
      () => a.messages.find((m) => m.method === 'session/request_permission'),
      Boolean,
    );
    const call = asked!.params.toolCall;
    expect(call.kind).toBe('edit');
    expect(call.content[0].content.text).toContain('review mode asks');
    expect(call.content[1]).toEqual({
      type: 'diff',
      path: join(root, 'one.txt'),
      oldText: null,
      newText: 'turn one\n',
    });
    expect(asked!.params.options.map((o: { optionId: string }) => o.optionId)).toEqual([
      'allow-once',
      'allow-session',
      'reject-once',
    ]);
    a.send({
      jsonrpc: '2.0',
      id: asked!.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow-session' } },
    });
    expect((await first).stopReason).toBe('end_turn');
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('turn one\n');
    // The finished edit carries its diff too.
    expect(
      updates(a.messages, 'tool_call_update').some((u) =>
        u.content?.some((c: Message) => c.type === 'diff' && c.newText === 'turn one\n'),
      ),
    ).toBe(true);

    // The same file again is covered by the session rule: no second prompt.
    const prompts = () =>
      a.messages.filter((m) => m.method === 'session/request_permission').length;
    await a.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: edit('turn two\n', 'turn one\n') }],
    });
    expect(prompts()).toBe(1);
    expect(readFileSync(join(root, 'one.txt'), 'utf8')).toBe('turn two\n');

    // Modes: set_mode, then the config option; full access confirms first.
    await a.request('session/set_mode', { sessionId: id, modeId: 'accept-edits' });
    expect(permissionPolicy(f.service.store, id).mode).toBe('accept-edits');
    await until(
      () => updates(a.messages, 'current_mode_update').at(-1),
      (u) => u?.currentModeId === 'accept-edits',
    );
    const answerConfirm = async (n: number, optionId: string) => {
      const confirm = await until(
        () => a.messages.filter((m) => m.method === 'session/request_permission')[n],
        Boolean,
      );
      expect(confirm!.params.toolCall.title).toBe('Turn on full access?');
      a.send({
        jsonrpc: '2.0',
        id: confirm!.id,
        result: { outcome: { outcome: 'selected', optionId } },
      });
    };
    const refused = a.request('session/set_config_option', {
      sessionId: id,
      configId: 'mode',
      value: 'full-access',
    });
    await answerConfirm(1, 'cancel');
    expect((await refused).configOptions[0].currentValue).toBe('accept-edits');
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();
    const accepted = a.request('session/set_config_option', {
      sessionId: id,
      configId: 'mode',
      value: 'full-access',
    });
    await answerConfirm(2, 'on');
    expect((await accepted).configOptions[0].currentValue).toBe('full-access');
    expect(permissionPolicy(f.service.store, id)).toMatchObject({ mode: 'auto', access: 'full' });
    await expect(a.request('session/set_mode', { sessionId: id, modeId: 'yolo' })).rejects.toThrow(
      /terminal/,
    );
    await a.request('session/set_mode', { sessionId: id, modeId: 'review' });
    expect(permissionPolicy(f.service.store, id).access).toBeUndefined();

    // /rewind lists turns, then restores one turn's files after a yes. It never reaches the model.
    const attempts = f.service.store.snapshot(id).attempts.length;
    await a.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: '/rewind' }],
    });
    expect(
      updates(a.messages, 'agent_message_chunk').some((u) => u.content.text?.includes('Turn 2')),
    ).toBe(true);
    const back = a.request('session/prompt', {
      sessionId: id,
      prompt: [{ type: 'text', text: '/rewind 1' }],
    });
    const confirm = await until(
      () => a.messages.filter((m) => m.method === 'session/request_permission')[3],
      Boolean,
    );
    expect(confirm!.params.toolCall.title).toBe('Rewind files to before turn 1');
    expect(confirm!.params.toolCall.content[0].content.text).toContain('one.txt');
    a.send({
      jsonrpc: '2.0',
      id: confirm!.id,
      result: { outcome: { outcome: 'selected', optionId: 'files' } },
    });
    expect((await back).stopReason).toBe('end_turn');
    expect(existsSync(join(root, 'one.txt'))).toBe(false);
    expect(f.service.store.snapshot(id).attempts).toHaveLength(attempts);
  } finally {
    await a.close();
    await f.close();
  }
}, 90000);

test('a session opened without --local keeps its old behaviour: no modes or commands', async () => {
  const f = await fixture(),
    a = client(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'plain');
    mkdirSync(root);
    await a.initialize();
    const created = await a.request('session/new', { cwd: root, mcpServers: [] });
    await ready(f.service, created.sessionId);
    expect(created.modes).toBeUndefined();
    await expect(
      a.request('session/set_mode', { sessionId: created.sessionId, modeId: 'auto' }),
    ).rejects.toThrow(/local coding/);
    expect(updates(a.messages, 'available_commands_update')).toEqual([]);
  } finally {
    await a.close();
    await f.close();
  }
}, 60000);

test("the desk session ignores the editor's own MCP servers; other sessions still refuse them", async () => {
  const f = await fixture(),
    a = client(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'mcp');
    mkdirSync(root);
    await a.initialize();
    // What Zed forwards from the user's context_servers.
    const zed = [{ name: 'swiggy-food', command: '/usr/local/bin/swiggy', args: [], env: [] }];
    const created = await a.request('session/new', {
      cwd: root,
      mcpServers: zed,
      _meta: { 'salaam.dev/local': true },
    });
    await ready(f.service, created.sessionId);
    expect(created.modes.currentModeId).toBe('review');
    expect(a.stderr()).toContain("does not use the editor's MCP servers; ignored 1");
    await expect(a.request('session/new', { cwd: root, mcpServers: zed })).rejects.toThrow(
      'must match the private node assignment',
    );
  } finally {
    await a.close();
    await f.close();
  }
}, 60000);

test('Zed can start the desk session with no service running: the adapter starts it', async () => {
  const dir = realpathSync(mkdtempSync('/tmp/sal-acp-start-')),
    state = join(dir, 'state'),
    root = join(dir, 'project');
  mkdirSync(root);
  // An empty home: no saved provider key is read, so the session stays on the offline model.
  const a = client(state, { HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') }, ['--local']);
  try {
    await a.initialize();
    const created = await a.request('session/new', { cwd: root, mcpServers: [] });
    expect(created.modes.currentModeId).toBe('review');
    const health = await call<{ ok?: boolean }>(join(state, 'operator.sock'), '/v1/health');
    expect(health).toBeTruthy();
    expect(
      (
        await call<{ provider_route: { provider: string } }>(
          join(state, 'operator.sock'),
          `/v1/sessions/${created.sessionId}/snapshot`,
        )
      ).provider_route.provider,
    ).toBe(OFFLINE_ROUTE.provider);
  } finally {
    await a.close();
    await promisify(execFile)(process.execPath, [
      join(ROOT, 'bin/salaam.mjs'),
      'service',
      'stop',
      '--state',
      state,
    ]).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);

test('a new desk session uses Anthropic, as the terminal does, when you saved a key and the service runs offline', () => {
  expect(deskRoute(OFFLINE_ROUTE.provider, true)).toMatchObject({ provider: 'anthropic' });
  expect(deskRoute(OFFLINE_ROUTE.provider, false)).toBeUndefined();
  expect(deskRoute('openai-codex', true)).toBeUndefined();
});
