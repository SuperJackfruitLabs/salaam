import { expect, test } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOUNDARY_IMAGE,
  BOUNDARY_DIGEST,
  BoundaryBroker,
  boundaryConfig,
  inspectBoundary,
  decodeLogs,
  engineRequest,
  type EngineRequest,
} from '../../src/execution/boundary.js';
import { workerTools, CAPABILITIES } from '../../src/core/protocol.js';
import { ROOT } from '../../src/core/config.js';

const run = '021802ee-966f-4b14-a620-1ed19604d73b';
const id = 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
function inspected(config: any): any {
  return {
    Id: id,
    Image: imageId,
    Config: structuredClone(config),
    HostConfig: structuredClone(config.HostConfig),
    State: { Status: 'created' },
    Mounts: [
      {
        Type: 'bind',
        Source: config.HostConfig.Mounts[0].Source,
        Destination: '/workspace',
        RW: true,
        Propagation: 'rprivate',
      },
    ],
  };
}
function fixture(mutate: (value: any) => void = () => {}): {
  engine: EngineRequest;
  calls: { method: string; path: string; body: any }[];
} {
  const calls: { method: string; path: string; body: any }[] = [];
  let container: any;
  const engine: EngineRequest = async (method, path, body) => {
    calls.push({ method, path, body });
    let result: any = {};
    let status = 200;
    if (path === '/version') result = { Os: 'linux', Arch: 'arm64', Version: 'fixture' };
    else if (path === '/info')
      result = {
        CgroupVersion: '2',
        DefaultRuntime: 'runc',
        SecurityOptions: ['name=seccomp,profile=builtin'],
        Warnings: [],
      };
    else if (path.startsWith('/images/'))
      result = {
        Id: imageId,
        RepoDigests: [BOUNDARY_IMAGE],
        Config: {},
      };
    else if (path.startsWith('/containers/create')) {
      container = inspected(body);
      mutate(container);
      result = { Id: id };
      status = 201;
    } else if (path.startsWith('/containers/json')) result = container ? [{ Id: id }] : [];
    else if (method === 'DELETE') {
      container = undefined;
      status = 204;
    } else if (path.endsWith('/start')) status = 204;
    else if (path.includes('/wait')) result = { StatusCode: 0 };
    else result = container;
    return { status, body: Buffer.from(JSON.stringify(result)) };
  };
  return { engine, calls };
}

test('fixed profile has one nonrecursive mount, no ambient env or networking and no arbitrary commands', () => {
  const config = boundaryConfig('/tmp/workspace', run, 'isolation');
  expect(config.HostConfig.Mounts).toHaveLength(1);
  expect(config.HostConfig.Mounts[0].BindOptions.NonRecursive).toBe(true);
  expect(config.Env.map((x: string) => x.split('=')[0])).toEqual(['HOME', 'PATH']);
  expect(config.HostConfig.NetworkMode).toBe('none');
  expect(() => boundaryConfig('/tmp/workspace', run, 'bash' as any)).toThrow('invalid_probe');
  expect(() => boundaryConfig('/', 'untrusted', 'isolation')).toThrow('invalid_probe');
  expect(() => boundaryConfig('relative', run, 'isolation')).toThrow('invalid_workspace');
  expect(() => boundaryConfig('/tmp/a,b', run, 'isolation')).toThrow('invalid_workspace');
  const good = inspected(config);
  expect(() => inspectBoundary(good, config, imageId)).not.toThrow();
  for (const child of [false, true]) {
    expect(workerTools(true, child).some((tool) => /bash|exec|read_file|patch/.test(tool))).toBe(
      false,
    );
  }
  expect(CAPABILITIES).not.toContain('coding-execution');
});

test('each effective security/profile change denies start and remains reconcilable', async () => {
  const dir = mkdtempSync('/tmp/sal-boundary-');
  const mutations = [
    (x: any) => {
      x.HostConfig.Privileged = true;
    },
    (x: any) => {
      x.HostConfig.NetworkMode = 'host';
    },
    (x: any) => {
      x.HostConfig.ReadonlyRootfs = false;
    },
    (x: any) => {
      x.HostConfig.SecurityOpt = ['seccomp=unconfined'];
    },
    (x: any) => {
      x.HostConfig.PidMode = 'host';
    },
    (x: any) => {
      x.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }];
    },
    (x: any) => {
      x.HostConfig.CapAdd = ['SYS_ADMIN'];
    },
    (x: any) => {
      x.HostConfig.PidsLimit = 0;
    },
    (x: any) => {
      x.HostConfig.Memory = 0;
    },
    (x: any) => {
      x.HostConfig.NanoCpus = 0;
    },
    (x: any) => {
      x.HostConfig.RestartPolicy.Name = 'always';
    },
    (x: any) => {
      x.HostConfig.Mounts[0].BindOptions.NonRecursive = false;
    },
    (x: any) => {
      x.Mounts.push({ Source: '/var/run/docker.sock' });
    },
    (x: any) => {
      x.Config.Env.push('ANTHROPIC_API_KEY=dummy');
    },
    (x: any) => {
      x.Config.User = '0';
    },
    (x: any) => {
      x.Config.Entrypoint = ['evil'];
    },
    (x: any) => {
      x.Config.Volumes = { '/host': {} };
    },
    (x: any) => {
      x.Image = 'wrong';
    },
  ];
  try {
    for (const mutate of mutations) {
      const f = fixture(mutate);
      const broker = new BoundaryBroker(run, f.engine);
      await broker.prepare();
      await expect(broker.create(dir, 'isolation')).rejects.toThrow('profile_mismatch');
      expect(f.calls.some((call) => call.path.endsWith('/start'))).toBe(false);
      expect(await broker.cleanup()).toEqual([id]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing image/backend and degraded daemon deny provisioning; no pull or fallback', async () => {
  for (const unavailable of ['/info', '/images/']) {
    const f = fixture();
    const engine: EngineRequest = (method, path, body) =>
      path.startsWith(unavailable)
        ? Promise.resolve({ status: 404, body: Buffer.from('{}') })
        : f.engine(method, path, body);
    const broker = new BoundaryBroker(run, engine);
    await expect(broker.prepare()).rejects.toThrow('backend_rejected');
    await expect(broker.create('/tmp', 'isolation')).rejects.toThrow('not_prepared');
    expect(f.calls.some((x) => x.method === 'POST')).toBe(false);
  }
  expect(() => engineRequest('/tmp/salaam-missing-socket')).toThrow();
  const f = fixture();
  const engine: EngineRequest = (method, path, body) =>
    path === '/info'
      ? Promise.resolve({
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              CgroupVersion: '2',
              DefaultRuntime: 'runc',
              SecurityOptions: ['name=seccomp,profile=builtin'],
              Warnings: ['No pids limit support'],
            }),
          ),
        })
      : f.engine(method, path, body);
  await expect(new BoundaryBroker(run, engine).prepare()).rejects.toThrow('profile_mismatch');
});

test('ambiguous create response is cleaned by saved run identity, without retry or start', async () => {
  const f = fixture();
  const dir = mkdtempSync('/tmp/sal-boundary-');
  const engine: EngineRequest = async (method, path, body) => {
    const result = await f.engine(method, path, body);
    if (path.startsWith('/containers/create')) throw new Error('response lost');
    return result;
  };
  try {
    const broker = new BoundaryBroker(run, engine);
    await broker.prepare();
    await expect(broker.create(dir, 'isolation')).rejects.toThrow('response lost');
    const replacement = new BoundaryBroker(run, f.engine);
    expect(await replacement.cleanup()).toEqual([id]);
    expect(await replacement.cleanup()).toEqual([]);
    expect(f.calls.filter((call) => call.path.startsWith('/containers/create'))).toHaveLength(1);
    expect(f.calls.some((call) => call.path.endsWith('/start'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanup rejects foreign ownership and unconfirmed removal', async () => {
  const dir = mkdtempSync('/tmp/sal-boundary-');
  try {
    const f = fixture((x) => {
      x.Config.Labels['salaam.boundary.run'] = 'someone-else';
    });
    const broker = new BoundaryBroker(run, f.engine);
    await broker.prepare();
    await expect(broker.create(dir, 'isolation')).rejects.toThrow('profile_mismatch');
    await expect(broker.cleanup()).rejects.toThrow('profile_mismatch');
    expect(f.calls.some((call) => call.method === 'DELETE')).toBe(false);
    const g = fixture();
    const engine: EngineRequest = (method, path, body) =>
      method === 'DELETE'
        ? Promise.resolve({ status: 204, body: Buffer.alloc(0) })
        : g.engine(method, path, body);
    const second = new BoundaryBroker(run, engine);
    await second.prepare();
    await second.create(dir, 'isolation');
    await expect(second.cleanup()).rejects.toThrow('cleanup_unconfirmed');
    expect(BOUNDARY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('start rechecks the original workspace rather than trusting a changed mount', async () => {
  const dir = mkdtempSync('/tmp/sal-boundary-');
  const f = fixture();
  let inspections = 0;
  const engine: EngineRequest = async (method, path, body) => {
    const reply = await f.engine(method, path, body);
    if (path === `/containers/${id}/json` && ++inspections === 2) {
      const value = JSON.parse(reply.body.toString());
      value.Mounts[0].Source = '/host/home';
      value.HostConfig.Mounts[0].Source = '/host/home';
      return { ...reply, body: Buffer.from(JSON.stringify(value)) };
    }
    return reply;
  };
  try {
    const broker = new BoundaryBroker(run, engine);
    await broker.prepare();
    await broker.create(dir, 'isolation');
    await expect(broker.start(id)).rejects.toThrow('profile_mismatch');
    expect(f.calls.some((call) => call.path.endsWith('/start'))).toBe(false);
    await broker.cleanup();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proof CLI fails closed without a backend; an unwritable report prevents engine contact', async () => {
  const dir = mkdtempSync('/tmp/sal-proof-');
  const report = join(dir, 'report.json');
  const socket = join(dir, 'engine.sock');
  let contacts = 0;
  const server = createServer((_req, res) => {
    contacts++;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const exec = promisify(execFile);
  const cli = (...args: string[]) =>
    exec(
      process.execPath,
      [join(ROOT, 'bin/salaam.mjs'), 'execution', 'prove', '--scratch-root', dir, ...args],
      { timeout: 5000, env: {} },
    );
  try {
    await expect(
      cli('--docker-socket', join(dir, 'missing.sock'), '--report', report),
    ).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(readFileSync(report, 'utf8'))).toMatchObject({
      status: 'failed',
      coding_tools_enabled: false,
      checks: [],
    });
    await expect(
      cli('--docker-socket', socket, '--report', '/dev/null/report.json'),
    ).rejects.toMatchObject({ code: 1 });
    expect(contacts).toBe(0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multiplexed output checks frame lengths and caps retained bytes', () => {
  const frame = (text: string) => {
    const data = Buffer.from(text);
    const header = Buffer.alloc(8);
    header[0] = 1;
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  expect(decodeLogs(Buffer.concat([frame('hello'), frame('🌍')]))).toBe('hello🌍');
  expect(() => decodeLogs(frame('x'.repeat(65537)))).toThrow('output_limit');
  expect(() => decodeLogs(frame('hello').subarray(0, 10))).toThrow('invalid_logs');
  expect(() => decodeLogs(Buffer.from('not a frame'))).toThrow('invalid_logs');
});

test('Unix engine transport bounds response bytes and wall time; ignores Docker env', async () => {
  const dir = mkdtempSync('/tmp/sal-engine-');
  const socket = join(dir, 'engine.sock');
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/hang')) return;
    res.end('x'.repeat(200));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const engine = engineRequest(socket);
    await expect(engine('GET', '/large', undefined, 1000, 10)).rejects.toThrow('output_limit');
    await expect(engine('GET', '/hang', undefined, 20)).rejects.toThrow('backend_timeout');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
