import { test, expect } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bindHost } from '../../src/host-bind.js';
import { readHost, hostToolsUser } from '../../src/host.js';
import { readStationConfig } from '../../src/station-config.js';
import { digest } from '../../src/protocol.js';

const root = process.getuid?.() === 0 && process.platform === 'linux';

test.runIf(!root)('host bind refuses to run except as root on Linux', async () => {
  await expect(bindHost({} as never)).rejects.toThrow('root on Linux');
});

test.runIf(root)(
  'host bind writes pins, station config with tools user and a strict launcher manifest, idempotently',
  async () => {
    const dir = realpathSync(mkdtempSync('/tmp/sal-bind-'));
    try {
      const workspace = join(dir, 'work'),
        runtime = join(dir, 'runtime'),
        helper = join(dir, 'files-helper');
      mkdirSync(workspace, { mode: 0o700 });
      mkdirSync(runtime, { mode: 0o755 });
      writeFileSync(helper, '#!/bin/sh\n', { mode: 0o755 });
      const key = 'salaam:' + createHash('sha256').update(workspace).digest('hex').slice(0, 16);
      const input = {
        organization_id: 'org_00000000000000000000',
        node_id: 'node_fixture',
        station_key: key,
        workspace,
        tools_user: 'nobody',
        files: helper,
        systemd_run: helper,
        systemctl: helper,
        runtime_root: runtime,
        runtime_image_digest: 'sha256:' + 'a'.repeat(64),
        operator_group: 'daemon',
        roots: { config: join(dir, 'etc'), state: join(dir, 'var') },
      };
      const first = await bindHost(input);
      const id = key.slice(7);
      expect(first).toMatchObject({
        station_key: key,
        dir: join(dir, 'etc', id),
        state: join(dir, 'var', id, 'state'),
        unit: 'salaam-host@' + id + '.service',
        changed: true,
      });
      const m = readHost(first.manifest);
      expect(digest(m)).toBe(first.manifest_digest);
      expect(m).toMatchObject({
        schema: 6,
        strict_work: { version: 1 },
        workspace,
        operator_access: { group: 'daemon' },
      });
      expect(JSON.parse(readFileSync(join(first.dir, 'agentpod-pins.json'), 'utf8'))).toEqual({
        version: 1,
        organization_id: input.organization_id,
        node_id: input.node_id,
        station_key: key,
        workspace,
      });
      expect(readStationConfig(join(first.dir, 'station-config.json'), workspace)).toMatchObject({
        tools_user: 'nobody',
        files: { path: helper },
      });
      expect(statSync(join(first.state, '..')).mode & 0o777).toBe(0o755);
      expect(hostToolsUser(m)).toBe('nobody');
      const again = await bindHost(input);
      expect(again).toEqual({ ...first, changed: false });
      const moved = await bindHost({ ...input, node_id: 'node_other' });
      expect(moved.changed).toBe(true);
      expect(moved.manifest_digest).not.toBe(first.manifest_digest);
      await expect(bindHost({ ...input, station_key: 'salaam:' + '0'.repeat(16) })).rejects.toThrow(
        'Station key',
      );
      const mcp = join(dir, 'mcp.json');
      const servers = (url: string) =>
        JSON.stringify({ version: 1, servers: [{ name: 'fetch', transport: 'http', url }] });
      writeFileSync(mcp, servers('https://mcp.example.com/a'), { mode: 0o600 });
      const withMcp = await bindHost({ ...input, mcp_config: mcp });
      expect(readHost(withMcp.manifest)).toMatchObject({ operator_mcp: { config: mcp } });
      writeFileSync(mcp, servers('https://mcp.example.com/b'), { mode: 0o600 });
      expect(() => readHost(withMcp.manifest)).toThrow('Operator MCP declarations changed');
      for (const tools_user of ['root', 'no-such-user-x', '../x'])
        await expect(bindHost({ ...input, tools_user })).rejects.toThrow('tools user');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
