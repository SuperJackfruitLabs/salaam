import { test, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PtyClient } from '../terminal-helpers.js';

test.runIf(Boolean(process.env.SALAAM_M18_TERMINAL_CONTEXT))(
  'installed Mac CLI detaches and reattaches to the same real Linux task through SSH',
  async () => {
    const context = JSON.parse(readFileSync(process.env.SALAAM_M18_TERMINAL_CONTEXT!, 'utf8'));
    if (
      context.host !== 'superprocess-remote-dev' ||
      !context.state.startsWith('/home/hermes/.cache/salaam-m10.eByB1aeQ/m18-')
    )
      throw Error('Select the owned acceptance host explicitly');
    const captures = [];
    for (let index = 0; index < 2; index++) {
      const terminal = new PtyClient(
        [
          context.installed_cli,
          'remote',
          context.host,
          '--remote-bin',
          context.remote_bin,
          '--state',
          context.state,
          '--session',
          context.session,
          '--observe',
        ],
        {
          state: context.local,
          env: { HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK },
          columns: 160,
          rows: 90,
        },
      );
      try {
        await terminal.contains('S A L A A M', 30000);
        await terminal.write('\t\t\t');
        await terminal.contains('TEAM BOARD', 30000);
        await terminal.contains('codex', 30000);
        await terminal.contains('mac-reviewer', 30000);
        const path = join(context.local, `remote-team-${index}.svg`);
        await terminal.capture(path);
        captures.push(path);
        await terminal.write('\x03');
        expect((await terminal.exit()).restored).toBe(true);
      } finally {
        await terminal.close();
      }
    }
    writeFileSync(
      join(context.local, 'terminal-evidence.json'),
      JSON.stringify(
        {
          client: process.platform + '/' + process.arch,
          installed: true,
          host: context.host,
          session: context.session,
          attachments: 2,
          terminal_restored: true,
          captures,
        },
        null,
        2,
      ) + '\n',
    );
  },
);
