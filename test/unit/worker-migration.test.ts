import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { ChildWork } from '../../src/children.js';
import { Artifacts } from '../../src/artifacts.js';
import type { Supervisor } from '../../src/supervisor.js';
import { OFFLINE_ROUTE } from '../../src/provider-route.js';

test('v11 child migration preserves ownership, results, acknowledgements, usage and cached responses byte for byte', async () => {
  const dir = mkdtempSync('/tmp/sal-wm-'),
    path = join(dir, 'journal.sqlite');
  let store = new Store(path);
  const supervisor = {
    assertActive() {},
    assertSessionProviderSupported() {},
    async start(id: string) {
      store.allocate(id, 'boot');
    },
  } as unknown as Supervisor;
  let children = new ChildWork(store, new Artifacts(join(dir, 'artifacts'), store), supervisor);
  try {
    const parent = store.create(dir, 'parent'),
      epoch = store.allocate(parent.id, 'boot');
    store.state(parent.id, epoch, 'ready');
    store.bindRoute(parent.id, OFFLINE_ROUTE);
    const attempt = store.accept(
      parent.id,
      'prompt',
      store.session(parent.id).revision,
      'parent',
    ).attempt_id;
    store.claim(parent.id, epoch);
    store.running(attempt);
    const completed = children.spawn(parent.id, epoch, attempt, 'done', 'probe', 2, [
      'salaam_probe',
    ]);
    store.state(completed.child_session, 1, 'ready');
    store.claim(completed.child_session, 1);
    store.running(completed.child_attempt);
    store.usage.admit(
      completed.child_session,
      completed.child_attempt,
      'one',
      'salaam-proof',
      'scripted',
    );
    store.finish(completed.child_attempt, 'completed', 'answer', null);
    const result = children.inspect(parent.id, completed.id).result_id!;
    const receipt = children.acknowledge(parent.id, completed.id, result, 'ack');
    children.spawn(parent.id, epoch, attempt, 'pending', 'probe', 2, ['salaam_probe']);
    await children.close();
    const before = {
      children: store.db.prepare('SELECT * FROM child_tasks').all(),
      requests: store.db.prepare('SELECT * FROM requests').all(),
      usage: store.db.prepare('SELECT * FROM usage_observations').all(),
      events: store.db.prepare('SELECT * FROM events').all(),
    };
    store.db.exec(
      'DROP TABLE local_calls; DROP TABLE station_units; DROP TABLE station_calls; DROP TABLE toolkit_resolution_controls; DROP TABLE toolkit_resolutions; DROP TABLE toolkit_cleanup_profiles; DROP TABLE toolkit_calls; DROP TABLE toolkit_owners; DROP TABLE toolkit_resources; DROP TABLE mcp_calls; DROP TABLE mcp_assignments; DROP TABLE turn_cancellations; ALTER TABLE attempts DROP COLUMN outcome; DROP TABLE agentpod_admissions; DROP TABLE agentpod_station_epochs; DROP TABLE session_revocations; DROP TABLE a2a_inbound; DROP TABLE external_model_requests; DROP TABLE task_invocations; DROP TABLE external_runs; DROP TABLE external_assignments; DROP TABLE team_rejections; DROP TABLE worker_integrations; DROP TABLE team_messages; DROP TABLE team_assignments; DROP TABLE specialist_reports; DROP TABLE agent_grants; DROP TABLE child_workers; DROP TABLE worker_profiles; PRAGMA user_version=11;',
    );
    store.close();
    store = new Store(path);
    children = new ChildWork(store, new Artifacts(join(dir, 'artifacts'), store), supervisor);
    expect(store.db.prepare('SELECT * FROM child_tasks').all()).toEqual(before.children);
    expect(store.db.prepare('SELECT * FROM requests').all()).toEqual(before.requests);
    expect(store.db.prepare('SELECT * FROM usage_observations').all()).toEqual(before.usage);
    expect(store.db.prepare('SELECT * FROM events').all()).toEqual(before.events);
    for (const child of children.list(parent.id)) {
      expect(child.worker!.binding).toMatchObject({
        legacy: true,
        owner_session: parent.id,
        tools: ['salaam_probe'],
        input_artifact: null,
      });
      expect(child.worker!.generation).toBe(0);
      expect(child.worker!.dispatch_state).toBe(
        child.state === 'accepted' ? 'interrupted' : 'terminal',
      );
    }
    expect(children.acknowledge(parent.id, completed.id, result, 'ack')).toEqual(receipt);
    expect(children.consume(parent.id, completed.id, result)).toMatchObject({
      acknowledged: true,
      result: { text: 'answer' },
    });
    children.recover();
    expect(children.list(parent.id).filter((c) => c.state === 'interrupted')).toHaveLength(1);
    await children.close();
    store.close();
    store = new Store(path);
    expect(store.db.prepare('SELECT count(*) AS n FROM child_workers').get()).toMatchObject({
      n: 2,
    });
  } finally {
    await children.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
