import { readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SalaamService } from '../../dist/src/service.js';
import { digest } from '../../dist/src/protocol.js';

const options = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const service = await SalaamService.open({ stateDir: options.state, agentpodConfig: options.pins });
if (options.mode === 'probe') {
  const row = service.toolkitResources.get('daemon-broker-resource');
  let renewError = null,
    executionError = null,
    shutdownFailed = false;
  try {
    service.agentpod.renew(options.binding, 'probe-renew', 2);
  } catch (error) {
    renewError = error.code;
  }
  try {
    service.store.execution.assert(row.session_id);
  } catch (error) {
    executionError = error.code;
  }
  const status = service.agentpod.inspect(options.binding);
  try {
    await service.close();
  } catch {
    shutdownFailed = true;
  }
  process.send({
    resource: row,
    renewError,
    executionError,
    shutdownFailed,
    authorized: status.authorized,
    stopped: status.owned_execution_stopped,
  });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const admitted = service.agentpod.admit(options.binding, 'resource-admit');
service.agentpod.renew(options.binding, 'resource-renew', 1);
const command = realpathSync(process.execPath);
const launch = {
  command,
  executable_digest: createHash('sha256').update(readFileSync(command)).digest('hex'),
  args: [options.peer],
  cwd: options.base,
  env: { HOME: options.base },
  protocol_version: '2025-06-18',
  limits: { request_bytes: 4096, response_bytes: 16384, stderr_bytes: 4096, timeout_ms: 3000 },
};
const stateDir = join(options.state, 'broker-state');
mkdirSync(stateDir, { mode: 0o700 });
const spec = {
  id: 'daemon-broker-resource',
  session_id: admitted.session_id,
  root_digest: digest(options.binding),
  profile_digest: 'b'.repeat(64),
  manifest_digest: 'c'.repeat(64),
  state_dir: stateDir,
  launch_digest: digest(launch),
};
const client = new Client(
  { name: 'owned-daemon-resource-proof', version: '1' },
  { capabilities: {} },
);
const transport = service.toolkitResources.transport(spec, launch);
if (options.mode === 'unrecorded') service.toolkitResources.launching(spec.id);
else await client.connect(transport);
process.send({ resource: service.toolkitResources.get(spec.id), session_id: admitted.session_id });
process.once('SIGTERM', () => void service.close());
await service.closed;
await client.close();
process.disconnect?.();
