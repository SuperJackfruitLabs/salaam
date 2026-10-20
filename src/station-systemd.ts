import { execFile } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  realpathSync,
  lstatSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { promisify } from 'node:util';
import type { StationConfig } from './station-config.js';
import { stationUnavailable, stationHash } from './station-config.js';
const exec = promisify(execFile);
const env = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  HOME: '/nonexistent',
  SYSTEMD_COLORS: '0',
  SYSTEMD_PAGER: 'cat',
};
export interface StationUnit {
  id: string;
  description: string;
  invocation: string;
  cgroup: string;
  pid: number;
  active: string;
  sub: string;
  code: number;
  status: number;
}
/** Linux systemd is the narrow first station runner. It consumes no model-supplied
 * unit properties, environment, mounts or executable path. Source is a filtered,
 * immutable snapshot; managed MCP/Toolkit stay in the separately trusted daemon. */
export class StationSystemd {
  constructor(readonly config: StationConfig) {}
  unit(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) stationUnavailable();
    return 'salaam-station-' + id + '.service';
  }
  private async command(executable: string, args: string[]) {
    const pin =
      executable === this.config.systemctl.path ? this.config.systemctl : this.config.systemd_run;
    if (
      realpathSync(executable) !== executable ||
      stationHash(readFileSync(executable)) !== pin.sha256
    )
      stationUnavailable();
    return exec(executable, args, { env, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' });
  }
  async launch(
    id: string,
    description: string,
    snapshot: string,
    output: string,
    command: string,
  ): Promise<void> {
    if (
      process.platform !== 'linux' ||
      process.getuid?.() !== 0 ||
      !existsSync('/run/systemd/system')
    )
      stationUnavailable();
    if (
      !/^[a-f0-9]{64}$/.test(description) ||
      realpathSync(snapshot) !== snapshot ||
      !lstatSync(snapshot).isDirectory() ||
      !output.startsWith(resolve(snapshot, '..') + '/') ||
      [snapshot, output, this.config.runtime_root].some((p) =>
        [...p].some(
          (c) => c === '%' || c === ':' || c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 92,
        ),
      )
    )
      stationUnavailable();
    const script = join(dirname(output), 'command');
    writeFileSync(script, command, { mode: 0o444, flag: 'wx' });
    chmodSync(script, 0o444);
    const properties = {
      Description: 'Salaam station ' + description,
      RootDirectory: this.config.runtime_root,
      WorkingDirectory: '/workspace',
      BindReadOnlyPaths: snapshot + ':/workspace ' + script + ':/run/salaam-command',
      DynamicUser: 'yes',
      MountAPIVFS: 'yes',
      PrivateNetwork: 'yes',
      PrivateDevices: 'yes',
      PrivateTmp: 'no',
      PrivateMounts: 'yes',
      TemporaryFileSystem:
        '/tmp:rw,nosuid,nodev,size=64M,nr_inodes=4096,mode=1777 /var/tmp:rw,nosuid,nodev,size=16M,nr_inodes=1024,mode=1777',
      ProtectSystem: 'strict',
      ProtectHome: 'yes',
      ProtectKernelTunables: 'yes',
      ProtectKernelModules: 'yes',
      ProtectKernelLogs: 'yes',
      ProtectControlGroups: 'yes',
      ProtectClock: 'yes',
      ProtectHostname: 'yes',
      ProtectProc: 'invisible',
      ProcSubset: 'pid',
      NoNewPrivileges: 'yes',
      CapabilityBoundingSet: '',
      AmbientCapabilities: '',
      RestrictSUIDSGID: 'yes',
      RestrictRealtime: 'yes',
      LockPersonality: 'yes',
      RestrictNamespaces: 'yes',
      RestrictAddressFamilies: 'AF_UNIX',
      MemoryMax: '536870912',
      MemorySwapMax: '0',
      TasksMax: '64',
      CPUQuota: '100%',
      RuntimeMaxSec: '30',
      TimeoutStopSec: '2',
      KillMode: 'control-group',
      SendSIGKILL: 'yes',
      LimitFSIZE: '65536',
      LimitCORE: '0',
      UMask: '0077',
      RemainAfterExit: 'yes',
      StandardInput: 'null',
      StandardOutput: 'append:' + output,
      StandardError: 'append:' + output,
      UnsetEnvironment:
        'ANTHROPIC_API_KEY OPENAI_API_KEY SSH_AUTH_SOCK DOCKER_HOST HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY STK_HOME STK_CONFIG STK_PASSPHRASE_FILE SALAAM_WORKER_CONFIG',
      Environment: 'HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin LANG=C',
    };
    await this.command(this.config.systemd_run.path, [
      '--quiet',
      '--expand-environment=no',
      '--unit',
      this.unit(id),
      '--service-type=exec',
      ...Object.entries(properties).flatMap(([k, v]) => ['--property', k + '=' + v]),
      '--',
      '/usr/bin/env',
      '-i',
      'HOME=/tmp',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'LANG=C',
      '/bin/sh',
      '/run/salaam-command',
    ]);
  }
  async inspect(id: string, description: string): Promise<StationUnit | null> {
    let stdout: string;
    try {
      ({ stdout } = await this.command(this.config.systemctl.path, [
        'show',
        this.unit(id),
        '--no-pager',
        '--property=Id,LoadState,Description,InvocationID,ControlGroup,ExecMainPID,ActiveState,SubState,ExecMainCode,ExecMainStatus',
      ]));
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
      if (!stdout.includes('LoadState=not-found\n')) stationUnavailable();
    }
    const v = Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const i = line.indexOf('=');
          if (i < 1) stationUnavailable();
          return [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    if (v.LoadState === 'not-found') return null;
    if (
      v.Id !== this.unit(id) ||
      v.Description !== 'Salaam station ' + description ||
      !v.InvocationID ||
      !/^[a-f0-9]{32}$/.test(v.InvocationID) ||
      (v.ControlGroup !== '/system.slice/' + this.unit(id) &&
        !(v.ControlGroup === '' && ['inactive', 'failed'].includes(v.ActiveState!)))
    )
      stationUnavailable();
    const result: StationUnit = {
      id: this.unit(id),
      description,
      invocation: v.InvocationID,
      cgroup: '/system.slice/' + this.unit(id),
      pid: Number(v.ExecMainPID),
      active: v.ActiveState!,
      sub: v.SubState!,
      code: Number(v.ExecMainCode),
      status: Number(v.ExecMainStatus),
    };
    if (![result.pid, result.code, result.status].every(Number.isSafeInteger)) stationUnavailable();
    return result;
  }
  private populated(group: string): boolean {
    if (
      !group.startsWith('/system.slice/salaam-station-') ||
      resolve('/sys/fs/cgroup' + group) !== '/sys/fs/cgroup' + group
    )
      stationUnavailable();
    const path = join('/sys/fs/cgroup', group, 'cgroup.events');
    if (!existsSync(path)) return false;
    const events = readFileSync(path, 'utf8');
    if (!/^populated [01]$/m.test(events)) stationUnavailable();
    return /^populated 1$/m.test(events);
  }
  async stop(
    id: string,
    description: string,
    prior?: StationUnit,
  ): Promise<{
    version: 1;
    unit: string;
    invocation: string;
    cgroup: string;
    observed_empty: true;
  }> {
    const current = await this.inspect(id, description),
      owned = current ?? prior;
    if (!owned || (current && prior && current.invocation !== prior.invocation))
      stationUnavailable();
    if (current) {
      await this.command(this.config.systemctl.path, ['stop', this.unit(id)]);
    }
    for (let i = 0; i < 100; i++) {
      if (!this.populated(owned.cgroup))
        return {
          version: 1,
          unit: this.unit(id),
          invocation: owned.invocation,
          cgroup: owned.cgroup,
          observed_empty: true,
        };
      await new Promise((r) => setTimeout(r, 20));
    }
    stationUnavailable();
  }
}
