import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { engineJson, type EngineRequest } from './execution-boundary.js';
import { digest, ServiceError } from './protocol.js';
import type { HarnessLaunch } from './harness-rpc.js';

const OWNER = 'salaam.harness.run',
  PROFILE = 'salaam.harness.profile';
// Gemini's pinned Linux shell tool invokes Bash. Prepare this image outside model turns.
export const HARNESS_IMAGE =
  'docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32';
export const HARNESS_CONTAINER_PROFILE = {
  version: 2,
  image: HARNESS_IMAGE,
  user: 'daemon-owner-nonroot',
  network: 'gateway-loopback-only',
  read_only: true,
  capabilities: [],
  no_new_privileges: true,
  pids: 96,
  memory: 768 * 1024 * 1024,
  tmp_bytes: 64 * 1024 * 1024,
  deadline_ms: 300000,
  request_bytes: 2 * 1024 * 1024,
  response_bytes: 8 * 1024 * 1024,
} as const;
/** Fixed relay: neither this container nor the harness has an external network. Real keys stay in the host callback. */
const GATEWAY = String.raw`const http=require('node:http'),rl=require('node:readline');let serial=0;const pending=new Map();const server=http.createServer(async(req,res)=>{if(pending.size>=8){res.writeHead(429);res.end();return}let size=0,chunks=[];try{for await(const chunk of req){size+=chunk.length;if(size>2097152)throw Error('body limit');chunks.push(chunk)}const id=++serial;pending.set(id,res);res.on('close',()=>pending.delete(id));const frame=JSON.stringify({id,method:req.method,path:req.url,headers:{'content-type':req.headers['content-type'],'x-api-key':req.headers['x-api-key'],authorization:req.headers.authorization,'anthropic-beta':req.headers['anthropic-beta']},body:Buffer.concat(chunks).toString('base64')})+'\n';if(process.stdout.writableLength+frame.length>4194304)throw Error('relay backpressure');process.stdout.write(frame);}catch{res.destroy()}});rl.createInterface({input:process.stdin}).on('line',line=>{try{if(line.length>4194304)throw Error('frame limit');const m=JSON.parse(line),res=pending.get(m.id);if(!res)return;if(m.status!==undefined)res.writeHead(m.status,{'content-type':m.content_type??'application/json'});if(m.chunk)res.write(Buffer.from(m.chunk,'base64'));if(m.end){res.end();pending.delete(m.id)}}catch{process.exit(2)}}).on('close',()=>{for(const res of pending.values())res.destroy();server.close();process.exit(0)});server.listen(47123,'127.0.0.1',()=>process.stdout.write(JSON.stringify({ready:true})+'\n'));setTimeout(()=>process.exit(3),300000);`;
// PID 1 owns the wall clock and exits with the harness, killing detached descendants.
const BOOT = `const {spawn}=require('node:child_process');const child=spawn(process.argv[1],process.argv.slice(2),{stdio:'inherit',env:process.env});setTimeout(()=>process.exit(124),300000);child.on('error',()=>process.exit(126));child.on('exit',code=>process.exit(code??125));`;
export interface GatewayRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}
export interface GatewayResponse {
  status: number;
  content_type?: string;
  body: AsyncIterable<Uint8Array> | Buffer;
}
export interface HarnessContainers {
  run_id: string;
  gateway: string;
  harness: string;
  profile_digest: string;
  engine_id: string;
  image_id: string;
  gateway_config: string;
  harness_config: string;
}
export class DockerHarnessBoundary {
  readonly user: string;
  readonly profileDigest: string;
  private imageEnv: string[] = [];
  private active = new Map<string, ChildProcessWithoutNullStreams>();
  constructor(
    readonly engine: EngineRequest,
    readonly engineId: string,
    readonly docker: { executable: string; digest: string; socket: string },
  ) {
    const uid = process.getuid?.(),
      gid = process.getgid?.();
    if (!uid || gid === undefined || gid === 0)
      throw new ServiceError('harness_user_unavailable', 'Require a non-root daemon owner');
    this.user = uid + ':' + gid;
    this.profileDigest = digest({
      profile: HARNESS_CONTAINER_PROFILE,
      user: this.user,
      gateway: GATEWAY,
      boot: BOOT,
    });
  }
  private configuration(c: any): string {
    const config = c.Config ?? c,
      host = c.HostConfig;
    const fields = [
      'NetworkMode',
      'ReadonlyRootfs',
      'CapDrop',
      'CapAdd',
      'SecurityOpt',
      'Privileged',
      'PidMode',
      'IpcMode',
      'CgroupnsMode',
      'PidsLimit',
      'Memory',
      'MemorySwap',
      'NanoCpus',
      'ShmSize',
      'Tmpfs',
      'Ulimits',
      'RestartPolicy',
    ];
    const effective = Object.fromEntries(fields.map((k) => [k, host[k] ?? null]));
    effective.CapAdd = host.CapAdd ?? [];
    effective.SecurityOpt = (host.SecurityOpt ?? [])
      .map((v: string) => v.replace(':true', ''))
      .sort();
    effective.RestartPolicy = { Name: host.RestartPolicy?.Name };
    const mounts = c.Mounts
      ? c.Mounts.map((m: any) => ({
          source: m.Source,
          target: m.Destination,
          read_only: !m.RW,
          type: m.Type,
          propagation: m.Propagation,
        }))
      : host.Mounts.map((m: any) => ({
          source: m.Source,
          target: m.Target,
          read_only: m.ReadOnly,
          type: m.Type,
          propagation: m.BindOptions.Propagation,
        }));
    return digest({
      image: config.Image,
      user: config.User,
      env: [...config.Env].sort(),
      entrypoint: config.Entrypoint ?? [],
      args: config.Cmd,
      cwd: config.WorkingDir,
      tty: config.Tty,
      stdin: config.OpenStdin,
      stdin_once: config.StdinOnce,
      labels: config.Labels,
      host: effective,
      mounts: mounts.sort((a: any, b: any) => a.target.localeCompare(b.target)),
      logs: host.LogConfig?.Type,
    });
  }
  private mount(source: string, target: string, readOnly: boolean) {
    if (
      !isAbsolute(source) ||
      /[\0\r\n,]/.test(source) ||
      realpathSync(source) !== source ||
      !lstatSync(source).isDirectory()
    )
      throw new ServiceError('harness_mount_denied', 'Require a canonical prepared directory');
    return {
      Type: 'bind',
      Source: source,
      Target: target,
      ReadOnly: readOnly,
      BindOptions: { Propagation: 'rprivate' },
    };
  }
  private config(
    run: string,
    gateway: boolean,
    mounts: unknown[],
    args: string[],
    env: string[],
    network: string,
  ): any {
    return {
      Image: HARNESS_IMAGE,
      User: this.user,
      Env: [
        ...new Map(
          [
            ...this.imageEnv,
            'HOME=/home/agent',
            'TMPDIR=/tmp',
            'PATH=/usr/local/bin:/usr/bin:/bin',
            ...env,
          ].map((v) => [v.slice(0, v.indexOf('=')), v]),
        ).values(),
      ],
      Entrypoint: ['/usr/local/bin/node'],
      Cmd: gateway ? args : ['-e', BOOT, '--', ...args],
      WorkingDir: gateway ? '/tmp' : '/workspace',
      Hostname: gateway ? 'salaam-harness' : '',
      Tty: false,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Labels: {
        [OWNER]: run,
        [PROFILE]: this.profileDigest,
        'salaam.harness.kind': gateway ? 'gateway' : 'worker',
      },
      HostConfig: {
        NetworkMode: network,
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PidMode: '',
        IpcMode: 'private',
        CgroupnsMode: 'private',
        PidsLimit: HARNESS_CONTAINER_PROFILE.pids,
        Memory: gateway ? 128 * 1024 * 1024 : HARNESS_CONTAINER_PROFILE.memory,
        MemorySwap: gateway ? 128 * 1024 * 1024 : HARNESS_CONTAINER_PROFILE.memory,
        NanoCpus: 1000000000,
        ShmSize: 8 * 1024 * 1024,
        Mounts: mounts,
        Tmpfs: {
          '/tmp': `rw,nosuid,nodev,size=64m,uid=${this.user.split(':')[0]},gid=${this.user.split(':')[1]},mode=700`,
        },
        Ulimits: [
          { Name: 'nofile', Soft: 256, Hard: 256 },
          { Name: 'fsize', Soft: 16 * 1024 * 1024, Hard: 16 * 1024 * 1024 },
        ],
        RestartPolicy: { Name: 'no' },
        LogConfig: { Type: 'none' },
      },
    };
  }
  async prepare(
    run: string,
    workspace: string,
    runtime: string,
    home: string,
    args: string[],
    env: Record<string, string> = {},
  ): Promise<HarnessContainers> {
    if (
      !/^[0-9a-f-]{36}$/.test(run) ||
      !args.length ||
      args.some((a) => typeof a !== 'string' || a.length > 8192) ||
      Object.keys(env).some(
        (k) =>
          ![
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_API_KEY',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'GEMINI_API_KEY',
            'GOOGLE_GEMINI_BASE_URL',
            'GEMINI_CLI_NO_RELAUNCH',
            'CODEX_HOME',
            'DISABLE_TELEMETRY',
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
            'CLAUDE_CONFIG_DIR',
          ].includes(k),
      )
    )
      throw new ServiceError('harness_launch_denied', 'Unsupported prepared harness launch');
    const info = engineJson(await this.engine('GET', '/info'));
    if (
      info.ID !== this.engineId ||
      info.CgroupVersion !== '2' ||
      !info.SecurityOptions?.includes('name=seccomp,profile=builtin')
    )
      throw new ServiceError('harness_engine_changed', 'Proven engine changed');
    const image = engineJson(
      await this.engine('GET', `/images/${encodeURIComponent(HARNESS_IMAGE)}/json`),
    );
    if (
      !image.RepoDigests?.some((r: string) =>
        [
          HARNESS_IMAGE,
          HARNESS_IMAGE.replace('docker.io/', ''),
          HARNESS_IMAGE.replace('docker.io/library/', ''),
        ].includes(r),
      ) ||
      !/^sha256:[a-f0-9]{64}$/.test(image.Id)
    )
      throw new ServiceError('harness_image_changed', 'Pinned harness image is unavailable');
    this.imageEnv = image.Config.Env;
    const gatewayConfig = this.config(run, true, [], ['-e', GATEWAY], [], 'none');
    const gateway = String(
      engineJson(
        await this.engine(
          'POST',
          '/containers/create?name=salaam-harness-' + run + '-gateway',
          gatewayConfig,
        ),
        [201],
      ).Id,
    );
    let harness: string | undefined;
    try {
      const config = this.config(
        run,
        false,
        [
          this.mount(workspace, '/workspace', false),
          this.mount(runtime, '/runtime', true),
          this.mount(home, '/home/agent', false),
        ],
        args,
        Object.entries(env).map(([k, v]) => k + '=' + v),
        'container:' + gateway,
      );
      harness = String(
        engineJson(
          await this.engine(
            'POST',
            '/containers/create?name=salaam-harness-' + run + '-worker',
            config,
          ),
          [201],
        ).Id,
      );
      const receipt = {
        run_id: run,
        gateway,
        harness,
        profile_digest: this.profileDigest,
        engine_id: this.engineId,
        image_id: image.Id as string,
        gateway_config: this.configuration(gatewayConfig),
        harness_config: this.configuration(config),
      };
      await this.assert(receipt);
      return receipt;
    } catch (error) {
      if (harness) await this.engine('DELETE', `/containers/${harness}?force=true`);
      await this.engine('DELETE', `/containers/${gateway}?force=true`);
      throw error;
    }
  }
  private async owned(id: string, run: string, kind: string): Promise<any> {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new ServiceError('harness_container_changed', 'Invalid container identity');
    const c = engineJson(await this.engine('GET', `/containers/${id}/json`));
    const h = c.HostConfig;
    if (
      c.Config.Labels?.[OWNER] !== run ||
      c.Config.Labels?.[PROFILE] !== this.profileDigest ||
      c.Config.Labels?.['salaam.harness.kind'] !== kind ||
      c.Config.User !== this.user ||
      h.Privileged ||
      !h.ReadonlyRootfs ||
      digest(h.CapDrop) !== digest(['ALL']) ||
      (!h.SecurityOpt?.includes('no-new-privileges') &&
        !h.SecurityOpt?.includes('no-new-privileges:true')) ||
      h.PidsLimit !== HARNESS_CONTAINER_PROFILE.pids ||
      h.RestartPolicy?.Name !== 'no'
    )
      throw new ServiceError('harness_container_changed', 'Owned harness configuration changed');
    return c;
  }
  async assert(receipt: HarnessContainers): Promise<void> {
    const info = engineJson(await this.engine('GET', '/info'));
    if (
      info.ID !== this.engineId ||
      info.CgroupVersion !== '2' ||
      !info.SecurityOptions?.includes('name=seccomp,profile=builtin')
    )
      throw new ServiceError('harness_engine_changed', 'Proven engine changed before dispatch');
    if (receipt.engine_id !== this.engineId || receipt.profile_digest !== this.profileDigest)
      throw new ServiceError('harness_container_changed', 'Boundary receipt changed');
    const [g, h] = await Promise.all([
      this.owned(receipt.gateway, receipt.run_id, 'gateway'),
      this.owned(receipt.harness, receipt.run_id, 'worker'),
    ]);
    if (
      g.Image !== receipt.image_id ||
      h.Image !== receipt.image_id ||
      this.configuration(g) !== receipt.gateway_config ||
      this.configuration(h) !== receipt.harness_config ||
      g.HostConfig.NetworkMode !== 'none' ||
      h.HostConfig.NetworkMode !== 'container:' + receipt.gateway ||
      g.Mounts.length !== 0 ||
      h.Mounts.length !== 3 ||
      h.Mounts.some(
        (m: any) =>
          !['/workspace', '/runtime', '/home/agent'].includes(m.Destination) ||
          m.Type !== 'bind' ||
          (m.Destination === '/runtime' && m.RW),
      )
    )
      throw new ServiceError('harness_container_changed', 'Harness network or mounts changed');
  }
  private launch(id: string, dialect: 'acp' | 'codex'): HarnessLaunch {
    if (
      createHash('sha256').update(readFileSync(this.docker.executable)).digest('hex') !==
      this.docker.digest
    )
      throw new ServiceError('harness_docker_changed', 'Operator Docker executable changed');
    return {
      executable: this.docker.executable,
      args: ['--host', 'unix://' + this.docker.socket, 'start', '--attach', '--interactive', id],
      cwd: '/',
      env: { HOME: '/nonexistent', PATH: '/usr/bin:/bin' },
      dialect,
    };
  }
  async gateway(
    receipt: HarnessContainers,
    handler: (request: GatewayRequest) => Promise<GatewayResponse>,
  ): Promise<void> {
    await this.assert(receipt);
    const launch = this.launch(receipt.gateway, 'acp'),
      process = spawn(launch.executable, launch.args, {
        cwd: launch.cwd,
        env: launch.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    this.active.set(receipt.run_id, process);
    let buffer = '',
      total = 0,
      ready = false,
      inflight = 0;
    const ids = new Set<number>();
    const send = (message: unknown) => {
      const frame = JSON.stringify(message) + '\n';
      if (process.stdin.writableLength + frame.length > 4 * 1024 * 1024)
        throw Error('Gateway backpressure');
      process.stdin.write(frame);
    };
    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error('Gateway start deadline'));
        process.kill('SIGKILL');
      }, 10000);
      process.on('error', reject);
      process.stdin.on('error', () => process.kill('SIGKILL'));
      process.stderr.on('data', (bytes: Buffer) => {
        total += bytes.length;
        if (total > 8 * 1024 * 1024) process.kill('SIGKILL');
      });
      process.stdout.on('data', (bytes: Buffer) => {
        try {
          total += bytes.length;
          if (total > 32 * 1024 * 1024) throw Error('Gateway output bound');
          buffer += bytes.toString();
          let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (line.length > 3 * 1024 * 1024) throw Error('Gateway frame bound');
            const m = JSON.parse(line);
            if (m.ready === true && !ready) {
              ready = true;
              clearTimeout(timer);
              resolve();
              continue;
            }
            if (
              !ready ||
              !Number.isSafeInteger(m.id) ||
              ids.has(m.id) ||
              ids.size >= 256 ||
              inflight >= 8 ||
              typeof m.body !== 'string'
            )
              throw Error('Invalid gateway request');
            ids.add(m.id);
            inflight++;
            void (async () => {
              try {
                const reply = await handler({
                  method: m.method,
                  path: m.path,
                  headers: m.headers,
                  body: Buffer.from(m.body, 'base64'),
                });
                send({ id: m.id, status: reply.status, content_type: reply.content_type });
                let bytes = 0;
                const chunks = Buffer.isBuffer(reply.body) ? [reply.body] : reply.body;
                for await (const chunk of chunks) {
                  bytes += chunk.length;
                  if (bytes > HARNESS_CONTAINER_PROFILE.response_bytes)
                    throw Error('Gateway response bound');
                  send({ id: m.id, chunk: Buffer.from(chunk).toString('base64') });
                }
                send({ id: m.id, end: true });
              } catch {
                send({
                  id: m.id,
                  status: 503,
                  chunk: Buffer.from('{"error":"Gateway request denied"}').toString('base64'),
                  end: true,
                });
              } finally {
                inflight--;
              }
            })().catch(() => process.kill('SIGKILL'));
          }
          if (buffer.length > 3 * 1024 * 1024) throw Error('Gateway frame bound');
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          process.kill('SIGKILL');
        }
      });
      process.on('close', () => {
        clearTimeout(timer);
        this.active.delete(receipt.run_id);
        if (!ready) reject(Error('Gateway exited before readiness'));
      });
    });
    await started;
  }
  async launchHarness(
    receipt: HarnessContainers,
    dialect: 'acp' | 'codex',
  ): Promise<HarnessLaunch> {
    await this.assert(receipt);
    return this.launch(receipt.harness, dialect);
  }
  async cleanup(receipt: HarnessContainers): Promise<void> {
    const info = engineJson(await this.engine('GET', '/info'));
    if (info.ID !== this.engineId)
      throw new ServiceError(
        'harness_engine_changed',
        'Cannot confirm ownership on a changed engine',
      );
    for (const [id, kind] of [
      [receipt.harness, 'worker'],
      [receipt.gateway, 'gateway'],
    ] as const) {
      const found = await this.engine('GET', `/containers/${id}/json`);
      if (found.status === 404) continue;
      await this.owned(id, receipt.run_id, kind);
      const deleted = await this.engine('DELETE', `/containers/${id}?force=true`);
      if (![204, 404].includes(deleted.status)) throw Error('Harness cleanup unconfirmed');
    }
    this.active.get(receipt.run_id)?.kill('SIGKILL');
    this.active.delete(receipt.run_id);
  }
  /** Lost create replies are reconciled by deterministic names and exact owner/profile labels. */
  async cleanupRun(run: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(run)) throw Error('Invalid owned harness run');
    const info = engineJson(await this.engine('GET', '/info'));
    if (info.ID !== this.engineId)
      throw new ServiceError('harness_engine_changed', 'Cannot reconcile on a changed engine');
    for (const kind of ['worker', 'gateway'] as const) {
      const name = 'salaam-harness-' + run + '-' + kind;
      const found = await this.engine('GET', '/containers/' + name + '/json');
      if (found.status === 404) continue;
      const data = engineJson(found);
      await this.owned(String(data.Id), run, kind);
      const removed = await this.engine('DELETE', '/containers/' + data.Id + '?force=true');
      if (![204, 404].includes(removed.status))
        throw Error('Owned harness reconciliation remains uncertain');
    }
    this.active.get(run)?.kill('SIGKILL');
    this.active.delete(run);
  }
}
