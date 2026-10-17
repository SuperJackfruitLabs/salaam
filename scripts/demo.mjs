import { mkdtempSync, rmSync } from 'node:fs';
import { SalaamService } from '../dist/src/service.js';
import { call } from '../dist/src/transport.js';
import { acquireControl, Outbox } from '../dist/src/attach.js';

const state = mkdtempSync('/tmp/sal-demo-');
let service;
try {
  service = await SalaamService.open({ stateDir: state });
  const created = await call(service.socket, '/v1/sessions', {
    request_id: 'demo-create',
    cwd: state,
  });
  let snapshot;
  for (let i = 0; i < 150; i++) {
    snapshot = await call(service.socket, `/v1/sessions/${created.id}`);
    if (snapshot.state === 'ready' || snapshot.state === 'unhealthy') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  console.log(JSON.stringify({ session: snapshot }, null, 2));
  if (snapshot.state !== 'ready') throw new Error(snapshot.error ?? 'Readiness timed out');
  const lease = await acquireControl(service.socket, created.id, 'demo');
  console.log(
    JSON.stringify(
      {
        probe: await call(
          service.socket,
          `/v1/sessions/${created.id}/probe`,
          { client_id: 'demo', token: lease.token },
          undefined,
          15000,
        ),
      },
      null,
      2,
    ),
  );
  const outbox = new Outbox(state, created.id);
  outbox.enqueue('Salaam from a durable submission', service.store.session(created.id).revision);
  await outbox.flush(service.socket, created.id, { client_id: 'demo', token: lease.token });
  let attempt;
  for (let i = 0; i < 150; i++) {
    attempt = service.store.snapshot(created.id).attempts[0];
    if (['completed', 'failed', 'interrupted'].includes(attempt?.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (attempt?.state !== 'completed') throw new Error('Durable prompt did not complete');
  console.log(JSON.stringify({ attempt }, null, 2));
  const events = service.store.events(created.id, 0);
  console.log(JSON.stringify({ events: events.map((event) => event.kind) }, null, 2));
  const id = service.artifacts.put(created.id, 'Verified Salaam M0–M3 offline demonstration.\n');
  console.log(JSON.stringify({ artifact: id, contents: service.artifacts.read(id) }, null, 2));
} finally {
  await service?.close();
  rmSync(state, { recursive: true, force: true });
}
