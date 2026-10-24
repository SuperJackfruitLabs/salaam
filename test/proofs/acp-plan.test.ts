import { expect, test } from 'vitest';
import { until } from '../helpers.js';
import { client } from '../acp-helpers.js';
import { checkedPlan, taskFixture } from '../task-helpers.js';

const plans = (a: ReturnType<typeof client>) =>
  a.messages
    .filter((m) => m.params?.update?.sessionUpdate === 'plan')
    .map((m) => m.params.update.entries.map((e: { status: string }) => e.status));

test('ACP shows the durable task plan before work starts and replaces it as steps run', async () => {
  const f = await taskFixture();
  const a = client(f.state);
  try {
    await f.plan(checkedPlan(2));
    await a.initialize();
    await a.request('session/resume', { sessionId: f.session.id, cwd: f.source, mcpServers: [] });
    await until(
      () => plans(a),
      (p) => p.length > 0,
    );
    expect(plans(a)[0]).toEqual(['pending', 'pending']);
    expect(
      a.messages.find((m) => m.params?.update?.sessionUpdate === 'plan')!.params.update.entries[0],
    ).toEqual({ content: 'Step 0', priority: 'medium', status: 'pending' });
    await f.run(0);
    await until(
      () => plans(a),
      (p) => p.some((s) => s[0] !== 'pending'),
    );
    // Each update is the whole plan, and an unchanged plan is not resent.
    const seen = plans(a);
    expect(seen.every((s) => s.length === 2)).toBe(true);
    expect(new Set(seen.map((s) => s.join())).size).toBe(seen.length);
  } finally {
    await a.close();
    await f.close();
  }
});
