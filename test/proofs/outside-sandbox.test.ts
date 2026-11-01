import { test, expect } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';
import { chooseLocalSandbox } from '../../src/command-sandbox.js';

const sandbox = chooseLocalSandbox('workspace-write').kind;

/** One approved local command turn through the real service; returns the command's output. */
async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  client: OperatorClient,
  id: string,
  n: number,
  args: Record<string, unknown>,
): Promise<string> {
  await client.submit('[local] ' + JSON.stringify({ action: 'command', ...args }));
  const approval = await until(
    () => f.service.store.approvals(id).find((a) => a.state === 'pending'),
    Boolean,
  );
  await client.decide(approval!, 'approve');
  await until(
    () => f.service.store.snapshot(id),
    (s) => s.attempts.length === n && s.attempts.every((a) => a.state === 'completed'),
  );
  const row = f.service.store.db
    .prepare('SELECT result FROM local_calls WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
    .get(id) as { result: string };
  return String(JSON.parse(row.result).output);
}

// Operator ruling 2026-11-01 (option 1): asked from "what apps are open?", which every sandboxed
// method failed. The approved command sees the machine; the same command in the sandbox does not.
test('an approved outside-sandbox command sees other processes; the sandboxed one does not', async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    const id = await client.create(root, false, undefined, true);
    await ready(f.service, id);
    const inside = await run(f, client, id, 1, { command: 'ps -p 1 -o comm=' });
    const outside = await run(f, client, id, 2, {
      command: 'ps -p 1 -o comm=',
      outside_sandbox: 'list the processes that are running',
    });
    const asked = (
      f.service.store.db.prepare('SELECT value FROM operations WHERE session_id=?').all(id) as {
        value: string;
      }[]
    )
      .map((op) => op.value)
      .join('\n');
    if (sandbox === 'none') {
      // No sandbox on this host (opted in for tests): there is nothing to step out of.
      expect(asked).not.toMatch(/Outside the sandbox/);
      expect(outside).toBe(inside);
      return;
    }
    expect(asked).toMatch(/Outside the sandbox: list the processes that are running/);
    if (sandbox === 'seatbelt') expect(inside).toMatch(/Operation not permitted/);
    expect(outside.trim()).not.toBe('');
    expect(outside).not.toMatch(/Operation not permitted/);
    expect(outside).not.toBe(inside);
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);
