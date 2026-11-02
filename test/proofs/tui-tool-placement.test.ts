import { test, expect } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, until, ready } from '../helpers.js';
import { OperatorClient } from '../../src/tui/client.js';
import { DocumentView } from '../../src/tui/view.js';
import { SalaamTheme } from '../../src/tui/theme.js';

/** One approved local command turn through the real service. */
async function command(
  f: Awaited<ReturnType<typeof fixture>>,
  client: OperatorClient,
  id: string,
  n: number,
  text: string,
) {
  await client.submit('[local] ' + JSON.stringify({ action: 'command', command: `echo ${text}` }));
  const approval = await until(
    () => f.service.store.approvals(id).find((a) => a.state === 'pending'),
    Boolean,
  );
  await client.decide(approval!, 'approve');
  await until(
    () => f.service.store.snapshot(id),
    (s) => s.attempts.length === n && s.attempts.every((a) => a.state === 'completed'),
  );
}

test("each turn's tool calls show before that turn's reply, and the transcript shows text, not JSON", async () => {
  const f = await fixture(),
    client = new OperatorClient(f.dir);
  try {
    const root = join(realpathSync(f.dir), 'project');
    mkdirSync(root);
    const id = await client.create(root, false, undefined, true);
    await ready(f.service, id);
    await command(f, client, id, 1, 'first-output');
    await command(f, client, id, 2, 'second-output');
    await client.refresh();
    const snapshot = f.service.store.snapshot(id);
    const replies = snapshot.messages.filter((m) => m.tool_calls?.length);
    expect(replies).toHaveLength(2);
    expect(snapshot.trailing_tool_calls).toBeUndefined();
    const view = (transcript: boolean) =>
      new DocumentView({
        client,
        theme: new SalaamTheme('night', false),
        tab: 'conversation',
        rows: () => 200,
        bodyRows: () => 190,
        diffOffset: 0,
        busy: false,
        transcript,
      } as ConstructorParameters<typeof DocumentView>[0])
        .render(120)
        .join('\n');
    const compact = view(false);
    const first = compact.indexOf('Bash echo first-output'),
      second = compact.indexOf('Bash echo second-output'),
      users = [...compact.matchAll(/YOU/g)].map((m) => m.index!);
    expect(first).toBeGreaterThan(users[0]!);
    // The first call sits in the first turn, before the second question.
    expect(first).toBeLessThan(users[1]!);
    expect(second).toBeGreaterThan(users[1]!);
    expect(compact).not.toContain('TOOLS · ctrl+x');
    const full = view(true);
    expect(full).toContain('│ first-output');
    expect(full).not.toContain('"exit_code"');
  } finally {
    await client.leave();
    await f.close();
  }
}, 60000);
