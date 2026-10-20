import {
  readFileSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SalaamService } from '../../dist/src/service.js';
import { digest } from '../../dist/src/protocol.js';
import { ToolkitAdmission } from '../../dist/src/toolkit-admission.js';
import { ToolkitCalls } from '../../dist/src/toolkit-calls.js';

const options = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const service = await SalaamService.open({ stateDir: options.state, agentpodConfig: options.pins });
if (options.mode === 'probe') {
  const row = service.toolkitResources.get(options.targetResource ?? 'daemon-broker-resource');
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
if (options.mode === 'control' || options.mode === 'unrecorded-control') {
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
    binary = join(options.state, 'control-peer'),
    policy = join(options.state, 'policy'),
    pass = join(options.state, 'pass'),
    store = join(options.state, 'store'),
    nativeState = join(options.state, 'native-state'),
    manifestPath = join(options.state, 'native-manifest.json'),
    profilePath = join(options.state, 'native-profile.json');
  copyFileSync(options.peer, binary);
  chmodSync(binary, 0o700);
  for (const dir of [store, nativeState]) mkdirSync(dir, { mode: 0o700 });
  writeFileSync(policy, 'services: {}\n', { mode: 0o600 });
  writeFileSync(pass, 'synthetic-only\n', { mode: 0o600 });
  const profileDigest = digest({
    version: 1,
    kind: 'stk-native-managed-v1',
    protocol: '2025-06-18',
    policy_sha256: sha(policy),
    profile: '',
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      root_digest: digest(options.binding),
      profile_digest: profileDigest,
      workspace: options.binding.workspace,
      policy_path: policy,
      policy_sha256: sha(policy),
      profile: '',
      store_dir: store,
      passphrase_file: pass,
      state_dir: nativeState,
      owner_socket: service.socket,
      owner_key: 'a'.repeat(64),
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    profilePath,
    JSON.stringify({
      version: 1,
      kind: 'stk-native-managed-v1',
      private_dir: options.state,
      credential_delegation: {
        organization_id: options.binding.organization_id,
        principal_id: options.binding.principal_id,
        binding_digest: digest(options.binding),
      },
      executable: { path: binary, sha256: sha(binary) },
      manifest: { path: manifestPath, sha256: sha(manifestPath) },
      passphrase_sha256: sha(pass),
      limits: { request_bytes: 4096, response_bytes: 16384, stderr_bytes: 4096, timeout_ms: 3000 },
    }),
    { mode: 0o600 },
  );
  const admission = new ToolkitAdmission(profilePath, sha(profilePath)),
    resources = service.toolkitResources,
    work = admission.transport(resources, admitted.session_id, 'daemon-broker-resource'),
    calls = new ToolkitCalls(service.store, service.managed, {
      authority: service.agentpod,
      resources,
      assertActive: () => {
        throw Error('fixture grants no work');
      },
      action: () => {
        throw Error('fixture has no native actions');
      },
    });
  service.toolkitOwners.register('daemon-broker-resource', calls, admission);
  const client = new Client(
    { name: 'cleanup-crash-work-peer', version: '1' },
    { capabilities: {} },
  );
  await client.connect(work);
  await client.close();
  await resources.stop('daemon-broker-resource');
  const cleanup = service.toolkitOwners.cleanup('daemon-broker-resource').materialize(resources),
    id = 'daemon-control-resource',
    input = {
      version: 1,
      action: 'revoke',
      root_digest: digest(options.binding),
      profile_digest: profileDigest,
      invocation_id: '',
      request_digest: '',
      stop_proof_digest: digest(resources.stopProof('daemon-broker-resource')),
      decision_id: '',
    },
    controlProcess = resources.control(id, cleanup, input);
  service.toolkitOwners.registerControl(id, cleanup);
  if (options.mode === 'unrecorded-control') resources.launching(id);
  else {
    void controlProcess.run().catch(() => {});
    const deadline = Date.now() + 10000;
    while (!existsSync(join(options.state, 'control-input'))) {
      if (Date.now() > deadline) throw Error('control peer did not receive input');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  process.send({ resource: resources.get(id), session_id: admitted.session_id });
  process.once('SIGTERM', () => void service.close());
  await service.closed;
  calls.close();
  process.disconnect?.();
  await new Promise(() => {});
}
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
