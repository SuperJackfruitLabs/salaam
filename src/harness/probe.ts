import { realpathSync, readFileSync, lstatSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { HarnessRpc, type HarnessLaunch, type RpcObject } from './rpc.js';
import {
  digest,
  ServiceError,
  VERSION,
  HARNESS_TARGETS,
  type HarnessTarget,
} from '../core/index.js';

export interface HarnessPin {
  target: HarnessTarget;
  executable: string;
  executable_digest: string;
  version: string;
}
/** Operator-only negotiation. No repository, credential, task or model request is admitted. */
export async function probeHarness(pin: HarnessPin): Promise<{
  schema_version: 1;
  pin: HarnessPin;
  launch_digest: string;
  capability_digest: string;
  advertised: RpcObject;
  enforced: {
    files: false;
    commands: false;
    model_requests: false;
    output_cap: false;
    resume_dispatch: false;
    isolation: 'unproven';
    retention: 'unknown';
  };
}> {
  if (!Object.hasOwn(HARNESS_TARGETS, pin.target) || !isAbsolute(pin.executable))
    throw new ServiceError('invalid_harness', 'Select a pinned supported absolute executable');
  const target = HARNESS_TARGETS[pin.target],
    executable = realpathSync(pin.executable),
    stat = lstatSync(executable);
  if (
    !stat.isFile() ||
    stat.size > 512 * 1024 * 1024 ||
    createHash('sha256').update(readFileSync(executable)).digest('hex') !== pin.executable_digest ||
    pin.version !== target.version
  )
    throw new ServiceError(
      'harness_pin_changed',
      'Harness executable digest or admitted version changed',
    );
  const dir = mkdtempSync(join(tmpdir(), 'sal-harness-probe-')),
    home = join(dir, 'home');
  mkdirSync(home, { mode: 0o700 });
  for (const name of ['.codex', '.config', '.cache']) mkdirSync(join(home, name), { mode: 0o700 });
  const env = {
    HOME: home,
    CODEX_HOME: join(home, '.codex'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    TMPDIR: dir,
    PATH: [dirname(process.execPath), dirname(executable), '/usr/bin', '/bin'].join(':'),
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    GEMINI_CLI_NO_RELAUNCH: 'true',
  };
  let rpc: HarnessRpc | undefined;
  try {
    const version =
      pin.target === 'claude-acp'
        ? {
            stdout: (() => {
              const metadata = JSON.parse(
                readFileSync(join(dirname(executable), '../package.json'), 'utf8'),
              );
              if (metadata.name !== '@zed-industries/claude-agent-acp')
                throw new Error('Unexpected Claude ACP package');
              return metadata.version as string;
            })(),
          }
        : await promisify(execFile)(executable, ['--version'], {
            cwd: dir,
            env,
            timeout: 10000,
            maxBuffer: 16384,
          });
    if (
      !new RegExp('(^|[^0-9.])' + pin.version.replaceAll('.', '\\.') + '([^0-9.]|$)').test(
        version.stdout.trim(),
      )
    )
      throw new ServiceError('harness_version_changed', 'Harness reported a different version');
    const launch: HarnessLaunch = {
      executable,
      args: [...target.args],
      cwd: dir,
      env,
      dialect: target.dialect,
    };
    rpc = new HarnessRpc(launch);
    const advertised =
      target.dialect === 'acp'
        ? await rpc.request('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'salaam', version: VERSION },
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
          })
        : await rpc.request('initialize', {
            clientInfo: { name: 'salaam', version: VERSION },
            capabilities: { experimentalApi: false, requestAttestation: false },
          });
    if (target.dialect === 'acp' && advertised.protocolVersion !== 1)
      throw new ServiceError(
        'harness_protocol_changed',
        'Harness did not negotiate ACP protocol version 1',
      );
    if (target.dialect === 'codex') rpc.notify('initialized', {});
    const enforced = {
      files: false,
      commands: false,
      model_requests: false,
      output_cap: false,
      resume_dispatch: false,
      isolation: 'unproven',
      retention: 'unknown',
    } as const;
    const admittedPin = { ...pin, executable };
    return {
      schema_version: 1,
      pin: admittedPin,
      launch_digest: digest({
        pin: admittedPin,
        args: target.args,
        environment: 'empty-home-no-credentials-v1',
      }),
      capability_digest: digest({ advertised, enforced }),
      advertised,
      enforced,
    };
  } finally {
    await rpc?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
