import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  boundaryConfig,
  inspectBoundary,
  engineJson,
  decodeLogs,
  type EngineRequest,
} from '../execution/index.js';
import { digest, ServiceError } from '../core/index.js';

export const CODING_IMAGE =
  'docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019';
export const COMMAND_LIMITS = {
  runtimeMs: 30_000,
  outputBytes: 65_536,
  globalConcurrency: 2,
  workBytes: 32 * 1024 * 1024,
} as const;
const BOOT = `const fs=require('node:fs');
fs.cpSync('/source/.','/work',{recursive:true});
function modes(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+item.name;if(item.isDirectory()){fs.chmodSync(p,0o700);modes(p)}else if(item.isFile()){const x=fs.statSync(p).mode&0o111;fs.chmodSync(p,x?0o700:0o600)}}}
modes('/work');console.log('salaam-command-ready');setInterval(()=>{},10000);`;
const READ_LOG = `const fs=require('node:fs');let result={content:'',bytes:0};try{const fd=fs.openSync('/tmp/salaam-command.log',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('unsafe log');const data=Buffer.alloc(Math.min(stat.size,65536));const n=fs.readSync(fd,data,0,data.length,0);result={content:data.subarray(0,n).toString('base64'),bytes:stat.size}}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='ENOENT')process.exit(2)}process.stdout.write(JSON.stringify(result));`;
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export interface ExecutionBackend {
  readonly profileDigest: string;
  readonly engineId: string;
  readonly evidence: Record<string, unknown>;
  create(source: string, run: string): Promise<string>;
  start(container: string, source: string, run: string): Promise<void>;
  ready(container: string, run: string): Promise<void>;
  exec(container: string, run: string, command: string, cwd: string): Promise<string>;
  launch(exec: string): Promise<void>;
  status(
    container: string,
    run: string,
    exec: string,
  ): Promise<{ running: boolean; exit: number | null }>;
  logs(container: string, run: string): Promise<{ content: string; bytes: number }>;
  cleanup(run: string): Promise<void>;
}
export class DockerCodingExecutor implements ExecutionBackend {
  profileDigest = '';
  engineId = '';
  evidence: Record<string, unknown> = {};
  private imageId = '';
  private env: string[] = [];
  constructor(private readonly engine: EngineRequest) {}
  private config(source: string, run: string): any {
    const config = boundaryConfig(source, run, 'timeout');
    config.Image = CODING_IMAGE;
    config.Env = this.env;
    config.Entrypoint = ['/usr/local/bin/node'];
    config.Cmd = ['-e', BOOT];
    config.WorkingDir = '/work';
    config.Labels = { 'salaam.command.run': run, 'salaam.command.profile': this.profileDigest };
    config.HostConfig.Mounts[0].Target = '/source';
    config.HostConfig.Mounts[0].ReadOnly = true;
    config.HostConfig.Memory = 256 * 1024 * 1024;
    config.HostConfig.MemorySwap = config.HostConfig.Memory;
    config.HostConfig.Tmpfs['/work'] =
      'rw,nosuid,nodev,size=32m,nr_inodes=4096,uid=65532,gid=65532,mode=700';
    return config;
  }
  async prepare(scratchRoot: string): Promise<Record<string, unknown>> {
    this.profileDigest = '';
    const version = engineJson(await this.engine('GET', '/version')),
      info = engineJson(await this.engine('GET', '/info'));
    if (
      version.Os !== 'linux' ||
      !['amd64', 'arm64'].includes(version.Arch) ||
      info.CgroupVersion !== '2' ||
      info.DefaultRuntime !== 'runc' ||
      !info.SecurityOptions?.includes('name=seccomp,profile=builtin') ||
      info.Warnings?.length
    )
      throw new ServiceError(
        'executor_unavailable',
        'Required Linux executor controls are unavailable',
        503,
      );
    const image = engineJson(
      await this.engine('GET', `/images/${encodeURIComponent(CODING_IMAGE)}/json`),
    );
    const refs = [
      CODING_IMAGE,
      CODING_IMAGE.replace('docker.io/', ''),
      CODING_IMAGE.replace('docker.io/library/', ''),
    ];
    if (
      !image.RepoDigests?.some((ref: string) => refs.includes(ref)) ||
      !validId(image.Id?.replace(/^sha256:/, '')) ||
      Object.keys(image.Config.Volumes ?? {}).length
    )
      throw new ServiceError('executor_image', 'Pinned coding image is unavailable', 503);
    this.env = ['HOME=/tmp', ...image.Config.Env];
    if (
      this.env.some(
        (value) => !['HOME', 'PATH', 'NODE_VERSION', 'YARN_VERSION'].includes(value.split('=')[0]!),
      ) ||
      !this.env.includes('NODE_VERSION=26.7.0')
    )
      throw new Error('Unexpected pinned image environment');
    this.imageId = image.Id;
    this.engineId = info.ID;
    const template = this.config('/source-snapshot', '00000000-0000-4000-8000-000000000000');
    template.Labels['salaam.command.profile'] = 'profile-digest';
    this.profileDigest = digest({ config: template, limits: COMMAND_LIMITS, log_reader: READ_LOG });
    this.evidence = {
      image: CODING_IMAGE,
      image_id: image.Id,
      profile_digest: this.profileDigest,
      engine_id: info.ID,
      engine_version: version.Version,
      kernel: version.KernelVersion,
      arch: version.Arch,
      node: '26.7.0',
    };
    const dir = mkdtempSync(join(scratchRoot, 'executor-proof-')),
      source = join(dir, 'source'),
      run = randomUUID();
    chmodSync(dir, 0o755);
    mkdirSync(source, { mode: 0o755 });
    writeFileSync(join(source, 'canary'), 'readonly-input', { mode: 0o444 });
    writeFileSync(join(dir, 'credential'), 'dummy-host-key', { mode: 0o444 });
    try {
      const id = await this.create(source, run);
      await this.start(id, source, run);
      await this.ready(id, run);
      const program = `const fs=require('node:fs'),assert=require('node:assert/strict');
assert.equal(process.getuid(),65532);assert.equal(process.version,'v26.7.0');
const status=fs.readFileSync('/proc/self/status','utf8');assert.match(status,/CapEff:\\s+0000000000000000/);assert.match(status,/NoNewPrivs:\\s+1/);assert.match(status,/Seccomp:\\s+2/);
assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'32');assert.equal(fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'268435456');
assert.equal(fs.readFileSync('/source/canary','utf8'),'readonly-input');assert.throws(()=>fs.writeFileSync('/source/canary','bad'));assert.throws(()=>fs.writeFileSync('/root-write','bad'));
assert.throws(()=>fs.readFileSync(${JSON.stringify(join(dir, 'credential'))}));for(const name of ['ANTHROPIC_API_KEY','SALAAM_WORKER_CONFIG','SSH_AUTH_SOCK','DOCKER_HOST'])assert.equal(process.env[name],undefined);
assert.deepEqual(fs.readdirSync('/sys/class/net'),['lo']);assert.throws(()=>fs.statSync('/var/run/docker.sock'));fs.writeFileSync('proof-write','bounded-private-copy');console.log('coding-boundary-ok');`;
      const command = 'node -e ' + "'" + program.replaceAll("'", "'\\''") + "'";
      const exec = await this.exec(id, run, command, '.');
      await this.launch(exec);
      let status = { running: true, exit: null as number | null };
      for (let n = 0; n < 100; n++) {
        status = await this.status(id, run, exec);
        if (!status.running) break;
        await delay(50);
      }
      const logs = await this.logs(id, run);
      if (
        status.running ||
        status.exit !== 0 ||
        !Buffer.from(logs.content, 'base64').toString().includes('coding-boundary-ok')
      )
        throw new Error('Coding boundary proof failed');
      await this.cleanup(run);
      this.evidence = {
        ...this.evidence,
        verified_at: new Date().toISOString(),
        probe: 'passed',
        cleanup_confirmed: true,
      };
      return this.evidence;
    } finally {
      await this.cleanup(run);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  private async owned(id: string, run: string): Promise<any> {
    if (!validId(id)) throw new Error('Invalid executor identity');
    const actual = engineJson(await this.engine('GET', `/containers/${id}/json`));
    if (
      actual.Id !== id ||
      actual.Config.Labels['salaam.command.run'] !== run ||
      actual.Config.Labels['salaam.command.profile'] !== this.profileDigest
    )
      throw new Error('Executor ownership/profile mismatch');
    return actual;
  }
  async create(source: string, run: string): Promise<string> {
    if (!this.profileDigest) throw new Error('Unproven executor');
    const info = engineJson(await this.engine('GET', '/info')),
      version = engineJson(await this.engine('GET', '/version'));
    if (
      info.ID !== this.engineId ||
      version.Version !== this.evidence.engine_version ||
      version.KernelVersion !== this.evidence.kernel ||
      info.CgroupVersion !== '2' ||
      !info.SecurityOptions?.includes('name=seccomp,profile=builtin') ||
      info.Warnings?.length
    )
      throw new ServiceError(
        'executor_changed',
        'Executor changed; restart and prove its boundary before dispatch',
        503,
      );
    const config = this.config(source, run),
      result = engineJson(
        await this.engine('POST', `/containers/create?name=salaam-command-${run}`, config),
        [201],
      );
    if (!validId(result.Id)) throw new Error('Invalid created identity');
    inspectBoundary(await this.owned(result.Id, run), config, this.imageId);
    return result.Id;
  }
  async start(id: string, source: string, run: string): Promise<void> {
    inspectBoundary(await this.owned(id, run), this.config(source, run), this.imageId);
    if ((await this.engine('POST', `/containers/${id}/start`)).status !== 204)
      throw new Error('Executor start failed');
  }
  async ready(id: string, run: string): Promise<void> {
    await this.owned(id, run);
    for (let n = 0; n < 100; n++) {
      const reply = await this.engine('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
      if (reply.status !== 200) throw new Error('Executor boot log unavailable');
      if (decodeLogs(reply.body).includes('salaam-command-ready')) return;
      if (!(await this.owned(id, run)).State.Running) throw new Error('Executor boot failed');
      await delay(50);
    }
    throw new Error('Executor boot deadline exceeded');
  }
  async exec(id: string, run: string, command: string, cwd: string): Promise<string> {
    await this.owned(id, run);
    const result = engineJson(
      await this.engine('POST', `/containers/${id}/exec`, {
        User: '65532:65532',
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        Privileged: false,
        Cmd: [
          '/bin/sh',
          '-c',
          'cd "$1" && exec /bin/sh -c "$2" > /tmp/salaam-command.log 2>&1',
          'salaam',
          '/work' + (cwd === '.' ? '' : '/' + cwd),
          command,
        ],
      }),
      [201],
    );
    if (!validId(result.Id)) throw new Error('Invalid execution identity');
    // Only create the exec here. The caller journals its ID before starting it.
    return result.Id;
  }
  async launch(exec: string): Promise<void> {
    if (
      !validId(exec) ||
      (await this.engine('POST', `/exec/${exec}/start`, { Detach: true, Tty: false })).status !==
        200
    )
      throw new Error('Command launch failed');
  }
  async status(
    id: string,
    run: string,
    exec: string,
  ): Promise<{ running: boolean; exit: number | null }> {
    await this.owned(id, run);
    if (!validId(exec)) throw new Error('Invalid exec identity');
    const actual = engineJson(await this.engine('GET', `/exec/${exec}/json`));
    if (actual.ContainerID !== id || actual.ID !== exec) throw new Error('Execution owner changed');
    return {
      running: actual.Running,
      exit: Number.isSafeInteger(actual.ExitCode) ? actual.ExitCode : null,
    };
  }
  async logs(id: string, run: string): Promise<{ content: string; bytes: number }> {
    await this.owned(id, run);
    const result = engineJson(
      await this.engine('POST', `/containers/${id}/exec`, {
        User: '65532:65532',
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Privileged: false,
        Cmd: ['/usr/local/bin/node', '-e', READ_LOG],
      }),
      [201],
    );
    if (!validId(result.Id)) throw new Error('Invalid log reader identity');
    const reply = await this.engine(
      'POST',
      `/exec/${result.Id}/start`,
      { Detach: false, Tty: false },
      2500,
      128 * 1024,
    );
    if (reply.status !== 200) throw new Error('Command logs unavailable');
    const output = decodeLogs(reply.body, 100_000);
    const status = engineJson(await this.engine('GET', `/exec/${result.Id}/json`));
    if (status.Running || status.ExitCode !== 0) throw new Error('Command log read failed');
    const value = JSON.parse(output);
    if (
      typeof value.content !== 'string' ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      Buffer.from(value.content, 'base64').length > COMMAND_LIMITS.outputBytes
    )
      throw new Error('Invalid command log');
    return value;
  }
  async cleanup(run: string): Promise<void> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`salaam.command.run=${run}`] }));
    const path = `/containers/json?all=1&filters=${filters}`;
    const rows = engineJson(await this.engine('GET', path));
    if (!Array.isArray(rows)) throw new Error('Invalid cleanup inventory');
    for (const row of rows) {
      await this.owned(row.Id, run);
      if ((await this.engine('DELETE', `/containers/${row.Id}?force=1&v=1`)).status !== 204)
        throw new Error('Command cleanup failed');
    }
    if (engineJson(await this.engine('GET', path)).length)
      throw new Error('Command cleanup unconfirmed');
  }
}
