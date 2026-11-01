import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SalaamService, type ServiceOptions } from '../src/service/service.js';
import { call } from '../src/core/transport.js';
import type { Session } from '../src/core/protocol.js';
import type { ControlLease } from '../src/core/protocol.js';
import { randomUUID } from 'node:crypto';
import { PiProcess } from '../src/runtime/pi.js';
import { ROOT } from '../src/core/config.js';
import { chooseLocalSandbox } from '../src/local/command-sandbox.js';

/** Tests that run real local commands on a machine with no usable OS sandbox (a CI container where
 * bubblewrap cannot start) run them with the operator opt-in; a machine with bubblewrap or Seatbelt
 * keeps them sandboxed. The refusal itself is tested where it is decided (local-coding tests). */
export const sandboxFallback: Partial<ServiceOptions> =
  chooseLocalSandbox('workspace-write').kind === 'none' ? { unsandboxedCommands: 'allow' } : {};

export async function fixture(options: Partial<ServiceOptions> = {}, prefix = '/tmp/sal-test-') {
  const dir = mkdtempSync(prefix);
  const service = await SalaamService.open({ stateDir: dir, ...sandboxFallback, ...options });
  return {
    service,
    dir,
    async close() {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function fake(mode = 'ready'): Partial<ServiceOptions> {
  return {
    startupTimeout: 1000,
    launch: (launch) =>
      new PiProcess(
        process.execPath,
        [join(ROOT, 'test/fixtures/fake-pi.mjs'), ...launch.args.slice(1)],
        launch.cwd,
        { ...launch.env, SALAAM_TEST_SCENARIO: mode },
      ),
  };
}
export async function create(
  service: SalaamService,
  dir: string,
  request = 'create',
): Promise<Session> {
  return call<Session>(service.socket, '/v1/sessions', { request_id: request, cwd: dir });
}
export async function until<T>(
  fn: () => T | Promise<T>,
  accept: (value: T) => boolean,
  timeout = 10000,
): Promise<T> {
  const start = Date.now();
  let last: T;
  do {
    last = await fn();
    if (accept(last)) return last;
    await new Promise((r) => setTimeout(r, 20));
  } while (Date.now() - start < timeout);
  throw new Error('Condition did not become true: ' + JSON.stringify(last));
}
export async function ready(service: SalaamService, id: string): Promise<Session> {
  const result = await until(
    () => call<Session>(service.socket, `/v1/sessions/${id}`),
    (value) => value.state === 'ready' || value.state === 'unhealthy',
  );
  if (result.state !== 'ready') throw new Error(result.error ?? 'Worker not ready');
  return result;
}
export async function control(service: SalaamService, id: string, takeover = false) {
  const client_id = randomUUID();
  const lease = await call<ControlLease>(service.socket, `/v1/sessions/${id}/control`, {
    request_id: randomUUID(),
    client_id,
    action: takeover ? 'takeover' : 'acquire',
    expected_epoch: service.store.controlView(id).epoch,
  });
  return { client_id, token: lease.token };
}
export async function probe(service: SalaamService, id: string, body: { nested?: boolean } = {}) {
  const controller = await control(service, id, true);
  try {
    return await call(service.socket, `/v1/sessions/${id}/probe`, { ...body, ...controller });
  } finally {
    await call(service.socket, `/v1/sessions/${id}/control`, {
      ...controller,
      request_id: randomUUID(),
      action: 'release',
      expected_epoch: service.store.controlView(id).epoch,
    }).catch(() => {});
  }
}
