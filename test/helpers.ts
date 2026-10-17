import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SalaamService, type ServiceOptions } from '../src/service.js';
import { call } from '../src/transport.js';
import type { Session } from '../src/protocol.js';
import { PiProcess } from '../src/pi.js';
import { ROOT } from '../src/config.js';

export async function fixture(options: Partial<ServiceOptions> = {}) {
  const dir = mkdtempSync('/tmp/sal-test-');
  const service = await SalaamService.open({ stateDir: dir, ...options });
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
