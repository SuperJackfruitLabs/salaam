import { expect, test } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fixture, ready, until } from '../helpers.js';
import { ROOT } from '../../src/config.js';
import { PtyClient } from '../terminal-helpers.js';
import { OperatorClient } from '../../src/tui-client.js';

// Phase 4b in a real terminal: a repository command expands into the prompt that is sent, and
// /hooks shows an untrusted workspace file without running it.
test('a custom command typed in the TUI sends its expanded prompt; /hooks lists an untrusted file', async () => {
  const f = await fixture();
  const client = new OperatorClient(f.dir);
  let terminal: PtyClient | undefined;
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(join(root, '.salaam', 'commands'), { recursive: true });
    writeFileSync(
      join(root, '.salaam/commands/fix.md'),
      '---\ndescription: Fix an issue\n---\nFix issue $ARGUMENTS and add a test.\n',
    );
    writeFileSync(
      join(root, '.salaam/hooks.json'),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'touch stopped' }] }] },
      }),
    );
    const id = await client.create(root, false, undefined, true);
    await ready(f.service, id);
    await client.leave();
    const config = join(f.dir, 'config');
    mkdirSync(config);
    terminal = new PtyClient(
      [join(ROOT, 'bin/salaam.mjs'), 'tui', '--session', id, '--state', f.dir],
      { state: f.dir, columns: 116, rows: 38, env: { XDG_CONFIG_HOME: config } },
    );
    await terminal.contains('You have control');
    await terminal.write('/fix 12\r');
    const done = await until(
      () => f.service.store.snapshot(id),
      (s) => s.attempts[0]?.state === 'completed',
    );
    expect(done.submissions[0]!.text).toBe('Fix issue 12 and add a test.');
    // Type the next command only once the first send has settled and the composer is clear.
    await terminal.contains('Offline reply: Fix issue 12');
    await new Promise((r) => setTimeout(r, 1000));
    await terminal.write('/hooks\r');
    await terminal.contains('does not run (/hooks trust');
    await terminal.contains('Stop: touch stopped');
    await terminal.write('\x1b');
    await new Promise((r) => setTimeout(r, 500));
    await terminal.leave();
    expect(await terminal.exit()).toMatchObject({ code: 0 });
  } finally {
    await terminal?.close();
    await f.close();
  }
}, 60000);
