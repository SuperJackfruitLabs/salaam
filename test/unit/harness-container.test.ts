import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerHarnessBoundary, HARNESS_IMAGE } from '../../src/harness-container.js';
import type { EngineRequest } from '../../src/execution-boundary.js';

function fixture() {
  const dir = realpathSync(mkdtempSync('/tmp/sal-harness-config-')),
    paths = ['workspace', 'runtime', 'home'].map((p) => join(dir, p));
  for (const p of paths) mkdirSync(p, { mode: 0o700 });
  const containers = new Map<string, any>(),
    calls: { method: string; path: string }[] = [];
  let engineId = 'engine-fixture';
  const engine: EngineRequest = async (method, path, body) => {
    calls.push({ method, path });
    let status = 200,
      value: any = {};
    if (path === '/info')
      value = {
        ID: engineId,
        CgroupVersion: '2',
        SecurityOptions: ['name=seccomp,profile=builtin'],
      };
    else if (path.startsWith('/images/'))
      value = {
        Id: 'sha256:' + 'a'.repeat(64),
        RepoDigests: [HARNESS_IMAGE],
        Config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=26.7.0'] },
      };
    else if (method === 'POST' && path.startsWith('/containers/create')) {
      const id = (containers.size + 1).toString(16).padStart(64, '0'),
        c = structuredClone(body) as any;
      containers.set(id, {
        Id: id,
        Image: 'sha256:' + 'a'.repeat(64),
        Config: c,
        HostConfig: c.HostConfig,
        Mounts: c.HostConfig.Mounts.map((m: any) => ({
          Type: 'bind',
          Source: m.Source,
          Destination: m.Target,
          RW: !m.ReadOnly,
          Propagation: m.BindOptions.Propagation,
        })),
      });
      status = 201;
      value = { Id: id };
    } else {
      const id = path.split('/')[2]!.split('?')[0]!,
        c = containers.get(id);
      if (!c) status = 404;
      else if (method === 'DELETE') {
        containers.delete(id);
        status = 204;
      } else value = c;
    }
    return { status, body: Buffer.from(JSON.stringify(value)) };
  };
  const boundary = new DockerHarnessBoundary(engine, 'engine-fixture', {
    executable: process.execPath,
    digest: 'fixture',
    socket: '/fixture.sock',
  });
  return {
    paths,
    containers,
    calls,
    boundary,
    setEngine(id: string) {
      engineId = id;
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
for (const mutate of [
  'network',
  'memory',
  'cpu',
  'mount',
  'capabilities',
  'user',
  'image',
  'command',
  'environment',
  'owner',
])
  test('fresh dispatch rejects changed harness ' + mutate, async () => {
    const f = fixture();
    try {
      const r = await f.boundary.prepare(randomUUID(), f.paths[0]!, f.paths[1]!, f.paths[2]!, [
        'node',
        '/runtime/agent.js',
      ]);
      const c = f.containers.get(r.harness);
      switch (mutate) {
        case 'network':
          c.HostConfig.NetworkMode = 'host';
          break;
        case 'memory':
          c.HostConfig.Memory = 0;
          break;
        case 'cpu':
          c.HostConfig.NanoCpus = 0;
          break;
        case 'mount':
          c.Mounts[0].Source = '/host';
          break;
        case 'capabilities':
          c.HostConfig.CapAdd = ['SYS_ADMIN'];
          break;
        case 'user':
          c.Config.User = '0:0';
          break;
        case 'image':
          c.Image = 'sha256:' + 'b'.repeat(64);
          break;
        case 'command':
          c.Config.Cmd = ['unsafe'];
          break;
        case 'environment':
          c.Config.Env.push('DOCKER_HOST=unix:///host/socket');
          break;
        case 'owner':
          c.Config.Labels['salaam.harness.run'] = 'unrelated';
          break;
      }
      await expect(f.boundary.assert(r)).rejects.toMatchObject({
        code: 'harness_container_changed',
      });
      expect(f.calls.some((c) => c.path.endsWith('/start'))).toBe(false);
    } finally {
      f.close();
    }
  });
test('engine changes and forbidden inherited credentials fail before creating resources', async () => {
  const f = fixture();
  try {
    f.setEngine('different');
    await expect(
      f.boundary.prepare(randomUUID(), f.paths[0]!, f.paths[1]!, f.paths[2]!, ['node']),
    ).rejects.toMatchObject({ code: 'harness_engine_changed' });
    f.setEngine('engine-fixture');
    await expect(
      f.boundary.prepare(randomUUID(), f.paths[0]!, f.paths[1]!, f.paths[2]!, ['node'], {
        SSH_AUTH_SOCK: '/host/agent',
      }),
    ).rejects.toMatchObject({ code: 'harness_launch_denied' });
    expect(f.containers.size).toBe(0);
  } finally {
    f.close();
  }
});
test('cleanup never deletes a container belonging to an unrelated owner', async () => {
  const f = fixture();
  try {
    const r = await f.boundary.prepare(randomUUID(), f.paths[0]!, f.paths[1]!, f.paths[2]!, [
      'node',
    ]);
    f.containers.get(r.harness).Config.Labels['salaam.harness.run'] = 'someone-else';
    await expect(f.boundary.cleanup(r)).rejects.toMatchObject({
      code: 'harness_container_changed',
    });
    expect(f.containers.size).toBe(2);
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
  } finally {
    f.close();
  }
});
test('engine replacement after preparation prevents both dispatch and cleanup on the wrong engine', async () => {
  const f = fixture();
  try {
    const r = await f.boundary.prepare(randomUUID(), f.paths[0]!, f.paths[1]!, f.paths[2]!, [
      'node',
    ]);
    f.setEngine('replacement');
    await expect(f.boundary.assert(r)).rejects.toMatchObject({ code: 'harness_engine_changed' });
    await expect(f.boundary.cleanup(r)).rejects.toMatchObject({ code: 'harness_engine_changed' });
    expect(f.calls.some((c) => c.method === 'DELETE')).toBe(false);
  } finally {
    f.close();
  }
});
