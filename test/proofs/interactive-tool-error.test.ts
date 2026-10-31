import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { fixture, until } from '../helpers.js';
import { OperatorClient } from '../../src/tui-client.js';

// At a desk a failed command is feedback: the model sees the exit and carries on, so the turn is
// decided by how it ends, not by the first non-zero exit (step 0, 2026-10-31: every attempt that
// ran a failing command was marked failed even after the model recovered). Board, station, child
// and plain sessions keep failing on a tool error.
const failedTools = (f: Awaited<ReturnType<typeof fixture>>, id: string) =>
  f.service.store.db
    .prepare(
      "SELECT count(*) AS n FROM events WHERE session_id=? AND kind='tool.finished' AND json_extract(payload,'$.failed')=1",
    )
    .get(id)!.n as number;

test('in an interactive coding session a failed command is feedback, not a failed turn', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-desk-fail-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false, undefined, true);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    await client.submit('[local] ' + JSON.stringify({ action: 'command', command: 'exit 3' }));
    const approvals = await until(
      () => f.service.store.approvals(id),
      (a) => a.some((x) => x.state === 'pending'),
    );
    await client.decide(
      approvals.find((a) => a.state === 'pending')!,
      'approve',
    );
    const attempt = await until(
      () => f.service.store.snapshot(id).attempts[0],
      (a) => !!a && ['completed', 'failed', 'interrupted'].includes(a.state),
    );
    expect(failedTools(f, id)).toBeGreaterThan(0);
    expect(attempt!.state).toBe('completed');
  } finally {
    await client.leave();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('outside interactive coding a tool error still fails the attempt', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-plain-fail-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false);
    await until(
      () => f.service.supervisor.inspect(id),
      (s) => s.state === 'ready',
    );
    await client.submit('[workspace] {"action":"read","path":"no-such-file.txt"}');
    const attempt = await until(
      () => f.service.store.snapshot(id).attempts[0],
      (a) => !!a && ['completed', 'failed', 'interrupted'].includes(a.state),
    );
    expect(failedTools(f, id)).toBeGreaterThan(0);
    expect(attempt!.state).toBe('failed');
  } finally {
    await client.leave();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('an AgentPod-admitted coding session is not interactive: its tool errors keep failing it', async () => {
  const f = await fixture();
  const root = realpathSync(mkdtempSync('/tmp/sal-admitted-'));
  const client = new OperatorClient(f.dir);
  try {
    const id = await client.create(root, false, undefined, true);
    const interactive = () =>
      (
        f.service.supervisor as unknown as { interactiveCoding(id: string): boolean }
      ).interactiveCoding(id);
    expect(interactive()).toBe(true);
    f.service.store.db
      .prepare(
        "INSERT INTO agentpod_admissions(id,session_id,hub_session_id,run_key,binding,digest,pins_digest,expires_at) VALUES('adm-1',?,'hub-1','run-1','{}','d','p',0)",
      )
      .run(id);
    expect(interactive()).toBe(false);
  } finally {
    await client.leave();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
