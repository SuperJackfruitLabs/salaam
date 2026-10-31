import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SalaamService } from '../../src/service.js';
import { call } from '../../src/transport.js';
import { digest, type Session } from '../../src/protocol.js';
import { ROOT } from '../../src/config.js';
import { readTree } from '../../src/workspaces.js';
import { PtyClient } from '../terminal-helpers.js';
import { client } from '../acp-helpers.js';
import { ready, until } from '../helpers.js';

test('ACP creates a guarded coding session and the TUI reviews the same real file patch', async () => {
  const dir = mkdtempSync('/tmp/sal-operator-coding-'),
    source = join(dir, 'source'),
    state = join(dir, 'state');
  mkdirSync(source);
  writeFileSync(join(source, 'greeting.js'), "export const greeting = 'Hello';\n");
  const service = await SalaamService.open({ stateDir: state, codingRoot: join(dir, 'owned') });
  const a = client(state);
  let terminal: PtyClient | undefined;
  try {
    expect((await a.initialize()).agentInfo.title).toBe('Salaam');
    const { sessionId } = await a.request('session/new', {
      cwd: source,
      mcpServers: [],
      _meta: { 'salaam.dev/coding': true },
    });
    await ready(service, sessionId);
    expect(service.store.session(sessionId).capabilities).toContain('workspace-files');
    const content = "export const greeting = 'Salaam';\n";
    await a.request('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text:
            '[files] ' +
            JSON.stringify({
              action: 'patch',
              path: 'greeting.js',
              expected_revision: 0,
              expected_hash: digest(
                readTree(service.workspaces.get(sessionId).root)['greeting.js'],
              ),
              content,
            }),
        },
      ],
    });
    expect(service.workspaces.get(sessionId).revision).toBe(1);
    expect(readFileSync(join(service.workspaces.get(sessionId).root, 'greeting.js'), 'utf8')).toBe(
      content,
    );
    expect(readFileSync(join(source, 'greeting.js'), 'utf8')).toContain('Hello');
    expect(
      a.messages.some(
        (m) =>
          m.params?.update?.sessionUpdate === 'tool_call_update' &&
          m.params.update.status === 'completed',
      ),
    ).toBe(true);
    // A finished live step carries what the tool returned, so a board does not show result: null.
    expect(
      a.messages.some(
        (m) =>
          m.params?.update?.sessionUpdate === 'tool_call_update' &&
          typeof m.params.update.toolCallId === 'string' &&
          !m.params.update.toolCallId.startsWith('salaam-operation:') &&
          typeof m.params.update.title === 'string' &&
          m.params.update.content?.[0]?.content?.text?.length > 0,
      ),
    ).toBe(true);
    await a.close();
    terminal = new PtyClient(
      [
        join(ROOT, 'bin/salaam.mjs'),
        'tui',
        '--session',
        sessionId,
        '--state',
        state,
        '--theme',
        'paper',
      ],
      { state, columns: 116, rows: 38 },
    );
    await terminal.contains('You have control');
    await terminal.write('\x1bg');
    await terminal.contains("+export const greeting = 'Salaam';");
    expect(await terminal.screen()).toContain('revision 1');
    if (process.env.SALAAM_TUI_CAPTURE_DIR)
      await terminal.capture(join(process.env.SALAAM_TUI_CAPTURE_DIR, 'paper-changes.svg'));
    await terminal.leave();
    expect((await terminal.exit()).restored).toBe(true);
  } finally {
    await terminal?.close();
    await a.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('ACP coding request fails before creating a session when the service has no coding root', async () => {
  const dir = mkdtempSync('/tmp/sal-acp-no-coding-');
  const service = await SalaamService.open({ stateDir: dir });
  const a = client(dir);
  try {
    await a.initialize();
    await expect(
      a.request('session/new', { cwd: dir, mcpServers: [], _meta: { 'salaam.dev/coding': true } }),
    ).rejects.toThrow('--coding-root');
    expect(service.store.sessions()).toHaveLength(0);
  } finally {
    await a.close();
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
