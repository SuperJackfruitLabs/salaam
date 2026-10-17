import { mkdtempSync, rmSync } from 'node:fs';
import { SalaamService } from '../dist/src/service.js';
import { call } from '../dist/src/transport.js';

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
  console.log(
    JSON.stringify(
      {
        probe: await call(service.socket, `/v1/sessions/${created.id}/probe`, {}, undefined, 15000),
      },
      null,
      2,
    ),
  );
  const events = service.store.events(created.id, 0);
  console.log(JSON.stringify({ events: events.map((event) => event.kind) }, null, 2));
  const id = service.artifacts.put(created.id, 'Verified Salaam M0–M2 offline demonstration.\n');
  console.log(JSON.stringify({ artifact: id, contents: service.artifacts.read(id) }, null, 2));
} finally {
  await service?.close();
  rmSync(state, { recursive: true, force: true });
}
