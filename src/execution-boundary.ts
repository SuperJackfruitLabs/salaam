import { request } from 'node:http';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { digest } from './protocol.js';

// M9.1 is an operator-only spike. Nothing in the worker/bridge imports this broker.
export const EXECUTION_STATUS = Object.freeze({
  available: false,
  coding_tools: false,
  reason: 'M9.1 boundary spike; workspace and durable command integration pending',
});
export const BOUNDARY_IMAGE =
  'docker.io/library/busybox@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092';
export const BOUNDARY_API = '/v1.47';
const OWNER = 'salaam.boundary.run';
const PROFILE = 'salaam.boundary.profile';
const ENV = ['HOME=/tmp', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'];
export const BOUNDARY_PROFILE = {
  version: 1,
  image: BOUNDARY_IMAGE,
  api: BOUNDARY_API,
  user: '65532:65532',
  env: ENV,
  network: 'none',
  memory: 128 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pids: 32,
  tmpfs: 'rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=700',
  shm: 8 * 1024 * 1024,
  outputBytes: 64 * 1024,
  wallMs: 10_000,
} as const;
// The digest also binds the complete effective configuration and fixed probe programs below.
const idPattern = /^[a-f0-9]{64}$/;
const runPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Only fixed probes are accepted. An arbitrary command API belongs to M9.3.
export const BOUNDARY_PROBES = {
  isolation: `set -eu
test "$(id -u)" = 65532
test "$HOME" = /tmp
test -z "\${ANTHROPIC_API_KEY-}\${SALAAM_BRIDGE_TOKEN-}\${SSH_AUTH_SOCK-}\${DOCKER_HOST-}\${SALAAM_BOUNDARY_CANARY-}"
for key in $(env | cut -d= -f1); do
  case "$key" in HOME|PATH|PWD|SHLVL|HOSTNAME) ;; *) echo unexpected-env-key:$key; exit 10 ;; esac
done
test "$HOSTNAME" = salaam-boundary
grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
grep -q '^Seccomp:[[:space:]]*2$' /proc/self/status
test "$(cat /sys/fs/cgroup/pids.max)" = 32
test "$(cat /sys/fs/cgroup/memory.max)" = 134217728
test "$(cat /sys/fs/cgroup/cpu.max)" = '50000 100000'
test "$(ulimit -n)" = 64
test "$(ulimit -f)" = 2048
test "$(cat input)" = workspace-canary
echo workspace-write > result
echo scratch > /tmp/scratch
if touch /root-write 2>/dev/null; then exit 11; fi
if mount -t tmpfs tmpfs /tmp 2>/dev/null; then exit 12; fi
if unshare -Ur true 2>/dev/null; then exit 13; fi
for link in escape-absolute escape-relative escape-home escape-socket escape-bridge escape-daemon; do
  test ! -e "$link"
  if cat "$link" >/dev/null 2>&1; then exit 14; fi
done
test ! -e /var/run/docker.sock
test ! -e /run/host-services
test ! -e /host
test ! -e /root/.ssh
test ! -e /proc/1/root/host
test "$(ls /sys/class/net)" = lo
if nc -w 1 169.254.169.254 80 </dev/null 2>/dev/null; then exit 15; fi
if nc -w 1 1.1.1.1 53 </dev/null 2>/dev/null; then exit 16; fi
# Multiple sub-limit files distinguish the tmpfs cap from the per-file fsize cap.
if sh -c 'for n in $(seq 1 20); do dd if=/dev/zero of=/tmp/fill-$n bs=524288 count=2 2>/dev/null || exit 1; done' 2>/dev/null; then exit 17; fi
rm -f /tmp/fill-*
echo isolation-ok`,
  descendants: `set -eu
setsid /bin/sh -c 'echo descendant-started; sleep 3; echo escaped > /workspace/escaped' &
wait`,
  timeout: 'sleep 30',
  output: 'yes bounded-output | head -c 100000',
} as const;
export type BoundaryProbe = keyof typeof BOUNDARY_PROBES;

export interface EngineReply {
  status: number;
  body: Buffer;
}
export type EngineRequest = (
  method: string,
  path: string,
  body?: unknown,
  timeoutMs?: number,
  maxBytes?: number,
) => Promise<EngineReply>;

export class BoundaryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Unix socket only: no TCP daemon, context, credential helper, host shell or env forwarding. */
export function engineRequest(socket: string): EngineRequest {
  if (!isAbsolute(socket) || !statSync(socket).isSocket())
    throw new BoundaryError('execution_backend_unavailable');
  return (method, path, body, timeoutMs = 10_000, maxBytes = 256 * 1024) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          socketPath: socket,
          method,
          path: BOUNDARY_API + path,
          headers: data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              reject(new BoundaryError('execution_output_limit'));
              res.destroy();
              req.destroy();
            } else chunks.push(chunk);
          });
          res.on('error', reject);
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
          );
        },
      );
      const timer = setTimeout(() => {
        reject(new BoundaryError('execution_backend_timeout'));
        req.destroy();
      }, timeoutMs);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(data);
    });
}

function json(reply: EngineReply, statuses = [200]): any {
  if (!statuses.includes(reply.status)) throw new BoundaryError('execution_backend_rejected');
  try {
    return JSON.parse(reply.body.toString());
  } catch {
    throw new BoundaryError('execution_backend_invalid_response');
  }
}
function requireProfile(ok: unknown, field = ''): asserts ok {
  if (!ok) throw new BoundaryError('execution_profile_mismatch' + (field ? ':' + field : ''));
}
function same(a: unknown, b: unknown): boolean {
  return digest(a ?? null) === digest(b ?? null);
}

function fixedConfig(
  workspace: string,
  run: string,
  probe: BoundaryProbe,
  profileDigest: string,
): any {
  if (!runPattern.test(run) || !Object.hasOwn(BOUNDARY_PROBES, probe))
    throw new BoundaryError('execution_invalid_probe');
  // Only the spike's freshly allocated disposable directory is accepted by its caller.
  // Workspaces/metadata protection are deliberately not implemented by this function.
  if (!isAbsolute(workspace) || /[,\n\r\0]/.test(workspace))
    throw new BoundaryError('execution_invalid_workspace');
  return {
    Image: BOUNDARY_IMAGE,
    User: BOUNDARY_PROFILE.user,
    Env: [...ENV],
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', BOUNDARY_PROBES[probe]],
    WorkingDir: '/workspace',
    Hostname: 'salaam-boundary',
    Labels: { [OWNER]: run, [PROFILE]: profileDigest },
    NetworkDisabled: true,
    Tty: false,
    OpenStdin: false,
    Healthcheck: { Test: ['NONE'] },
    HostConfig: {
      Mounts: [
        {
          Type: 'bind',
          Source: workspace,
          Target: '/workspace',
          ReadOnly: false,
          BindOptions: { Propagation: 'rprivate', NonRecursive: true },
        },
      ],
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      NetworkMode: 'none',
      IpcMode: 'private',
      CgroupnsMode: 'private',
      Runtime: 'runc',
      Memory: BOUNDARY_PROFILE.memory,
      MemorySwap: BOUNDARY_PROFILE.memory,
      NanoCpus: BOUNDARY_PROFILE.nanoCpus,
      PidsLimit: BOUNDARY_PROFILE.pids,
      ShmSize: BOUNDARY_PROFILE.shm,
      Tmpfs: { '/tmp': BOUNDARY_PROFILE.tmpfs },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false,
      Ulimits: [
        { Name: 'nofile', Soft: 64, Hard: 64 },
        { Name: 'fsize', Soft: 1024 * 1024, Hard: 1024 * 1024 },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
      LogConfig: {
        Type: 'local',
        Config: { 'max-size': '1m', 'max-file': '1', compress: 'false' },
      },
    },
  };
}

export function boundaryConfig(workspace: string, run: string, probe: BoundaryProbe): any {
  return fixedConfig(workspace, run, probe, BOUNDARY_DIGEST);
}
export const BOUNDARY_DIGEST = digest({
  profile: BOUNDARY_PROFILE,
  probes: BOUNDARY_PROBES,
  config: boundaryConfigForDigest(),
});
function boundaryConfigForDigest(): unknown {
  // Avoid depending on the digest-valued label while computing the digest itself.
  return fixedConfig(
    '/disposable-workspace',
    '00000000-0000-4000-8000-000000000000',
    'isolation',
    'profile-digest',
  );
}

/** Validate the daemon's effective configuration, before starting any payload. */
export function inspectBoundary(actual: any, expected: any, imageId: string): void {
  requireProfile(actual.Image === imageId && actual.State?.Status === 'created', 'image-or-state');
  const c = actual.Config;
  const h = actual.HostConfig;
  requireProfile(c && h);
  for (const key of [
    'User',
    'Entrypoint',
    'Cmd',
    'WorkingDir',
    'Hostname',
    'Labels',
    'NetworkDisabled',
    'Tty',
    'OpenStdin',
    'Healthcheck',
  ])
    requireProfile(same(c[key], expected[key]), 'Config.' + key);
  requireProfile(same([...c.Env].sort(), [...ENV].sort()), 'Config.Env');
  requireProfile(!c.Volumes || Object.keys(c.Volumes).length === 0);
  for (const key of Object.keys(expected.HostConfig)) {
    // Docker omits the false ReadOnly zero value from HostConfig.Mounts.
    const value =
      key === 'Mounts' && Array.isArray(h.Mounts)
        ? h.Mounts.map((mount: any) => ({ ...mount, ReadOnly: mount.ReadOnly ?? false }))
        : h[key];
    requireProfile(same(value, expected.HostConfig[key]), 'HostConfig.' + key);
  }
  for (const key of [
    'Binds',
    'CapAdd',
    'Devices',
    'DeviceRequests',
    'DeviceCgroupRules',
    'VolumesFrom',
    'GroupAdd',
    'Links',
    'ExtraHosts',
    'PortBindings',
  ])
    requireProfile(!h[key] || Object.keys(h[key]).length === 0);
  for (const key of ['PidMode', 'UTSMode', 'UsernsMode', 'CgroupParent']) requireProfile(!h[key]);
  requireProfile(!h.PublishAllPorts && !h.OomKillDisable);
  requireProfile(actual.Mounts?.length === 1);
  requireProfile(actual.Mounts[0].Type === 'bind');
  requireProfile(actual.Mounts[0].Source === expected.HostConfig.Mounts[0].Source);
  requireProfile(actual.Mounts[0].Destination === '/workspace');
  requireProfile(actual.Mounts[0].RW === true && actual.Mounts[0].Propagation === 'rprivate');
}

export function decodeLogs(body: Buffer, limit = BOUNDARY_PROFILE.outputBytes): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  let size = 0;
  while (offset < body.length) {
    if (offset + 8 > body.length || ![1, 2].includes(body[offset]!))
      throw new BoundaryError('execution_invalid_logs');
    const length = body.readUInt32BE(offset + 4);
    offset += 8;
    size += length;
    if (size > limit) throw new BoundaryError('execution_output_limit');
    if (offset + length > body.length) throw new BoundaryError('execution_invalid_logs');
    chunks.push(body.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat(chunks).toString();
}

export class BoundaryBroker {
  private imageId: string | undefined;
  private readonly created = new Map<string, any>();
  constructor(
    readonly run: string,
    private readonly engine: EngineRequest,
  ) {
    if (!runPattern.test(run)) throw new BoundaryError('execution_invalid_run');
  }

  async prepare(): Promise<Record<string, unknown>> {
    this.imageId = undefined;
    this.created.clear();
    const version = json(await this.engine('GET', '/version'));
    const info = json(await this.engine('GET', '/info'));
    requireProfile(version.Os === 'linux' && ['arm64', 'amd64'].includes(version.Arch));
    requireProfile(info.CgroupVersion === '2' && info.DefaultRuntime === 'runc');
    requireProfile(info.SecurityOptions?.includes('name=seccomp,profile=builtin'));
    requireProfile(!info.Warnings?.length);
    const image = json(
      await this.engine('GET', `/images/${encodeURIComponent(BOUNDARY_IMAGE)}/json`),
    );
    const references = [
      BOUNDARY_IMAGE,
      BOUNDARY_IMAGE.replace('docker.io/', ''),
      BOUNDARY_IMAGE.replace('docker.io/library/', ''),
    ];
    requireProfile(image.RepoDigests?.some((reference: string) => references.includes(reference)));
    requireProfile(idPattern.test(image.Id?.replace(/^sha256:/, '')));
    requireProfile(!image.Config?.Volumes || Object.keys(image.Config.Volumes).length === 0);
    this.imageId = image.Id;
    return {
      engine_version: version.Version,
      runtime_versions: version.Components?.map((component: any) => ({
        name: component.Name,
        version: component.Version,
      })),
      api_version: version.ApiVersion,
      kernel: version.KernelVersion,
      os: version.Os,
      arch: version.Arch,
      engine_id: info.ID,
      security_options: info.SecurityOptions,
      image_id: image.Id,
      image: BOUNDARY_IMAGE,
      profile_digest: BOUNDARY_DIGEST,
    };
  }

  async create(workspace: string, probe: BoundaryProbe): Promise<string> {
    if (!this.imageId) throw new BoundaryError('execution_not_prepared');
    const source = realpathSync(workspace);
    if (!statSync(source).isDirectory()) throw new BoundaryError('execution_invalid_workspace');
    const expected = boundaryConfig(source, this.run, probe);
    // A lost create response is ambiguous. The caller's finally block reconciles by run label.
    const result = json(
      await this.engine(
        'POST',
        `/containers/create?name=salaam-boundary-${this.run}-${probe}`,
        expected,
      ),
      [201],
    );
    if (!idPattern.test(result.Id)) throw new BoundaryError('execution_backend_invalid_response');
    inspectBoundary(
      json(await this.engine('GET', `/containers/${result.Id}/json`)),
      expected,
      this.imageId,
    );
    this.created.set(result.Id, expected);
    return result.Id;
  }

  private async owned(id: string, cleanup = false): Promise<any> {
    if (!idPattern.test(id)) throw new BoundaryError('execution_invalid_id');
    const actual = json(await this.engine('GET', `/containers/${id}/json`));
    requireProfile(
      actual.Id === id &&
        actual.Config?.Labels?.[OWNER] === this.run &&
        (cleanup
          ? idPattern.test(actual.Config?.Labels?.[PROFILE] ?? '')
          : actual.Config?.Labels?.[PROFILE] === BOUNDARY_DIGEST),
    );
    return actual;
  }

  async start(id: string): Promise<void> {
    const actual = await this.owned(id);
    const expected = this.created.get(id);
    requireProfile(expected && this.imageId);
    inspectBoundary(actual, expected, this.imageId);
    const result = await this.engine('POST', `/containers/${id}/start`);
    if (result.status !== 204) throw new BoundaryError('execution_start_failed');
  }

  async wait(id: string, wallMs: number = BOUNDARY_PROFILE.wallMs): Promise<number> {
    await this.owned(id);
    const result = json(
      await this.engine('POST', `/containers/${id}/wait?condition=not-running`, undefined, wallMs),
    );
    if (!Number.isSafeInteger(result.StatusCode) || result.Error?.Message)
      throw new BoundaryError('execution_wait_failed');
    return result.StatusCode;
  }

  async logs(id: string): Promise<string> {
    await this.owned(id);
    const result = await this.engine('GET', `/containers/${id}/logs?stdout=1&stderr=1`);
    if (result.status !== 200) throw new BoundaryError('execution_logs_failed');
    return decodeLogs(result.body);
  }

  async cleanup(): Promise<string[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${OWNER}=${this.run}`, PROFILE] }),
    );
    const path = `/containers/json?all=1&filters=${filters}`;
    const containers = json(await this.engine('GET', path));
    if (!Array.isArray(containers)) throw new BoundaryError('execution_backend_invalid_response');
    const removed: string[] = [];
    for (const container of containers) {
      // Cleanup remains possible after a profile upgrade, using the saved run UUID.
      await this.owned(container.Id, true);
      const result = await this.engine('DELETE', `/containers/${container.Id}?force=1&v=1`);
      if (result.status !== 204) throw new BoundaryError('execution_cleanup_failed');
      removed.push(container.Id);
      this.created.delete(container.Id);
    }
    if (json(await this.engine('GET', path)).length !== 0)
      throw new BoundaryError('execution_cleanup_unconfirmed');
    return removed;
  }
}
