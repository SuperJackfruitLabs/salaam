import { expect, test } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ToolkitAdmission } from '../../src/toolkit-admission.js';
import { digest } from '../../src/protocol.js';
import type { AgentPodBinding } from '../../src/agentpod-protocol.js';
import { mcpServiceFixture } from '../mcp-service-helpers.js';

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
async function fixture() {
  const base = realpathSync(mkdtempSync('/tmp/stka-')),
    root = join(base, 'private'),
    workspace = join(base, 'workspace');
  for (const p of [root, workspace, join(root, 'store'), join(root, 'state')])
    mkdirSync(p, { mode: 0o700 });
  const binding: AgentPodBinding = {
    version: 1,
    organization_id: 'org_00000000000000000001',
    principal_id: 'prn_00000000000000000002',
    node_id: 'node_fixture',
    station_id: 'station_fixture',
    station_key: 'salaam:0000000000000001',
    occupancy_epoch: 1,
    hub_session_id: 'hub_fixture',
    workspace,
    run: { source: 'agentpod', id: 'run_fixture', epoch: 1 },
  };
  const command = join(root, 'stk'),
    policy = join(root, 'policy'),
    pass = join(root, 'pass'),
    manifestPath = join(root, 'manifest.json'),
    profilePath = join(root, 'profile.json'),
    socket = join(root, 'owner.sock');
  writeFileSync(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  writeFileSync(policy, 'version: 1\n', { mode: 0o600 });
  writeFileSync(pass, 'synthetic-passphrase\n', { mode: 0o600 });
  const server = createServer();
  server.listen(socket);
  await once(server, 'listening');
  chmodSync(socket, 0o600);
  const manifest = {
    version: 1,
    root_digest: digest(binding),
    profile_digest: digest({
      version: 1,
      kind: 'stk-native-managed-v1',
      protocol: '2025-06-18',
      policy_sha256: sha(policy),
      profile: '',
    }),
    workspace,
    policy_path: policy,
    policy_sha256: sha(policy),
    profile: '',
    store_dir: join(root, 'store'),
    passphrase_file: pass,
    state_dir: join(root, 'state'),
    owner_socket: socket,
    owner_key: 'a'.repeat(64),
  };
  const profile = {
    version: 1,
    kind: 'stk-native-managed-v1',
    private_dir: root,
    credential_delegation: {
      organization_id: binding.organization_id,
      principal_id: binding.principal_id,
      binding_digest: digest(binding),
    },
    executable: { path: command, sha256: sha(command) },
    manifest: { path: manifestPath, sha256: '' },
    passphrase_sha256: sha(pass),
    limits: { request_bytes: 65536, response_bytes: 131072, stderr_bytes: 4096, timeout_ms: 10000 },
  };
  const save = () => {
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
    profile.manifest.sha256 = sha(manifestPath);
    writeFileSync(profilePath, JSON.stringify(profile), { mode: 0o600 });
    return new ToolkitAdmission(profilePath, sha(profilePath));
  };
  const admission = save();
  return {
    base,
    root,
    workspace,
    binding,
    command,
    policy,
    pass,
    manifestPath,
    profilePath,
    socket,
    manifest,
    profile,
    admission,
    save,
    close: async () => {
      server.close();
      await once(server, 'close');
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('private launch pins the versioned entry and exact credential delegation without exposing private owner data', async () => {
  const f = await fixture();
  try {
    const admitted = f.admission.launch(f.binding);
    expect(admitted.launch.args).toEqual([
      'managed-mcp-v1',
      '--manifest',
      f.manifestPath,
      '--sha256',
      sha(f.manifestPath),
    ]);
    expect(admitted.launch.env).toEqual({ HOME: f.root });
    expect(admitted.launch.cwd).toBe(f.workspace);
    expect(admitted.profile_digest).toBe(f.manifest.profile_digest);
    expect(JSON.stringify(admitted)).not.toContain(f.manifest.owner_key);
    // This fixture script is never run; hash admission is not broker compatibility or authority.
  } finally {
    await f.close();
  }
});

test('actual service resource creation uses the reviewed profile and rejects changed policy before OS spawn', async () => {
  const f = await fixture(),
    service = await mcpServiceFixture();
  try {
    await service.renew();
    f.manifest.workspace = service.binding.workspace;
    f.manifest.root_digest = digest(service.binding);
    f.profile.credential_delegation = {
      organization_id: service.binding.organization_id,
      principal_id: service.binding.principal_id,
      binding_digest: digest(service.binding),
    };
    const admission = f.save();
    const resources = service.service.toolkitResources;
    const transport = admission.transport(
      resources,
      service.admitted.session_id,
      'admitted-resource',
    );
    expect(resources.get('admitted-resource')).toMatchObject({
      state: 'prepared',
      root_digest: digest(service.binding),
      profile_digest: f.manifest.profile_digest,
    });
    writeFileSync(f.policy, 'changed private policy');
    await expect(transport.start()).rejects.toThrow();
    expect(resources.get('admitted-resource')).toMatchObject({
      state: 'prepared',
      pid: null,
      identity: null,
    });
    expect(service.service.agentpod!.inspect(service.binding).authorized).toBe(false);
    await resources.stop('admitted-resource');
    expect(resources.stopProof('admitted-resource').method).toBe('not_started');
  } finally {
    await service.close();
    await f.close();
  }
});

for (const kind of ['principal', 'organization', 'occupant', 'run', 'station'] as const)
  test(`a different ${kind} cannot inherit the private credential delegation`, async () => {
    const f = await fixture();
    try {
      const b = structuredClone(f.binding);
      if (kind === 'principal') b.principal_id = 'prn_00000000000000000003';
      if (kind === 'organization') b.organization_id = 'org_00000000000000000003';
      if (kind === 'occupant') b.occupancy_epoch++;
      if (kind === 'run') b.run.epoch++;
      if (kind === 'station') b.station_id = 'station_other';
      expect(() => f.admission.launch(b)).toThrowError(
        expect.objectContaining({ code: 'toolkit_profile_changed' }),
      );
    } finally {
      await f.close();
    }
  });

for (const kind of ['binary', 'policy', 'passphrase', 'manifest', 'profile'] as const)
  test(`changed ${kind} bytes invalidate reviewed admission`, async () => {
    const f = await fixture();
    try {
      const p = {
        binary: f.command,
        policy: f.policy,
        passphrase: f.pass,
        manifest: f.manifestPath,
        profile: f.profilePath,
      }[kind];
      writeFileSync(p, readFileSync(p, 'utf8') + ' ');
      expect(() => f.admission.launch(f.binding)).toThrowError(
        expect.objectContaining({ code: 'toolkit_profile_changed' }),
      );
    } finally {
      await f.close();
    }
  });

for (const kind of [
  'world-file',
  'writable-parent',
  'hardlink',
  'symlink',
  'workspace-store',
  'wrong-root',
  'wrong-policy-fingerprint',
  'wrong-protocol-shape',
  'unknown-limit',
  'socket-mode',
] as const)
  test(`rejects ${kind} even when profile bytes are pinned`, async () => {
    const f = await fixture();
    try {
      if (kind === 'world-file') chmodSync(f.pass, 0o644);
      if (kind === 'writable-parent') chmodSync(f.base, 0o777);
      if (kind === 'hardlink') linkSync(f.pass, join(f.workspace, 'leak'));
      if (kind === 'symlink') {
        const p = join(f.root, 'linked-pass');
        symlinkSync(f.pass, p);
        f.manifest.passphrase_file = p;
      }
      if (kind === 'workspace-store') f.manifest.store_dir = f.workspace;
      if (kind === 'wrong-root') f.manifest.root_digest = 'b'.repeat(64);
      if (kind === 'wrong-policy-fingerprint') f.manifest.profile_digest = 'b'.repeat(64);
      if (kind === 'wrong-protocol-shape')
        (f.profile as unknown as Record<string, unknown>).allow_ambient_credentials = true;
      if (kind === 'unknown-limit')
        (f.profile.limits as unknown as Record<string, unknown>).unbounded = true;
      if (kind === 'socket-mode') chmodSync(f.socket, 0o666);
      const admission = f.save();
      expect(() => admission.launch(f.binding)).toThrowError(
        expect.objectContaining({ code: 'toolkit_profile_changed' }),
      );
    } finally {
      await f.close();
    }
  });
