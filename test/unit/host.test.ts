import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostDigests, readHost, hostUnit, type HostManifest } from '../../src/host.js';
import { ROOT } from '../../src/config.js';
import { OFFLINE_ROUTE } from '../../src/provider-route.js';
test('host manifests bind runtime/source/build, require private files and generate native supervision without embedding keys', () => {
  const dir = mkdtempSync('/tmp/sal-host-manifest-'),
    file = join(dir, 'host.json');
  try {
    const m: HostManifest = {
      schema: 1,
      node: process.execPath,
      node_version: process.version,
      repo: ROOT,
      ...hostDigests(),
      state: join(dir, 'state'),
      coding_root: join(dir, 'owned'),
      coding_socket: '/var/run/docker.sock',
      provider: OFFLINE_ROUTE,
      profile_digest: 'reviewed',
      engine_id: 'reviewed',
    };
    writeFileSync(file, JSON.stringify(m), { mode: 0o600 });
    expect(readHost(file).build_digest).toBe(m.build_digest);
    expect(hostUnit(file, 'systemd')).toContain('Restart=on-failure');
    expect(hostUnit(file, 'launchd')).toContain('<key>KeepAlive</key>');
    expect(hostUnit(file, 'systemd')).not.toContain('API_KEY');
    writeFileSync(file, JSON.stringify({ ...m, build_digest: 'changed' }));
    expect(() => readHost(file)).toThrow('build changed');
    writeFileSync(file, JSON.stringify(m));
    chmodSync(file, 0o644);
    expect(() => readHost(file)).toThrow('private');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
