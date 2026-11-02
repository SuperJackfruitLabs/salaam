import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../src/core/config.js';
import { call } from '../src/core/transport.js';
import { SocketEffectConnector } from '../src/execution/effect-connector.js';
import type { SalaamService } from '../src/service/service.js';
import type { Approval } from '../src/core/protocol.js';
import { control } from './helpers.js';

export async function effectFixture(opaque = false) {
  const dir = mkdtempSync('/tmp/sal-external-');
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [
    join(ROOT, 'test/fixtures/mock-effect.mjs'),
    dir,
    ...(opaque ? ['--opaque'] : []),
  ]);
  await once(child.stdout, 'data');
  return {
    dir,
    child,
    socket: join(dir, 'effects.sock'),
    connector: new SocketEffectConnector(join(dir, 'effects.sock'), { opaque, timeoutMs: 10000 }),
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export async function submit(service: SalaamService, session: string, text: string) {
  const controller = await control(service, session, true);
  const accepted = service.store.accept(
    session,
    randomUUID(),
    service.store.session(session).revision,
    text,
    controller,
  );
  return { ...accepted, controller };
}
export async function decide(
  service: SalaamService,
  approval: Approval,
  decision: 'approve' | 'deny',
  request: string = randomUUID(),
) {
  return call<Approval>(service.socket, `/v1/approvals/${approval.id}/decision`, {
    request_id: request,
    expected_revision: approval.revision,
    operation_digest: approval.operation_digest,
    decision,
  });
}
