import { spawn, execFile } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readHost, hostMcp, hostToolkit } from './host.js';
import { readAgentPodPins } from '../agentpod/index.js';
import { acquireStateLock, canonical, digest, ServiceError, call } from '../core/index.js';

/** This is node-owned startup, not a station lifecycle grant or a work admission. */
export async function startHost(path: string) {
  let m = readHost(path);
  if (m.schema !== 2 && m.schema !== 3 && m.schema !== 4 && m.schema !== 5 && m.schema !== 6)
    throw Error('Automatic host startup requires a reviewed AgentPod manifest');
  mkdirSync(m.state, { recursive: true, mode: 0o700 });
  m = readHost(path);
  if (m.schema !== 2 && m.schema !== 3 && m.schema !== 4 && m.schema !== 5 && m.schema !== 6)
    throw Error('AgentPod manifest changed');
  const expected = digest(m),
    deadline = Date.now() + 20000;
  let release: (() => void) | undefined;
  while (!release) {
    try {
      release = acquireStateLock(join(m.state, 'startup'));
    } catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'state_locked') throw error;
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for concurrent host startup', { cause: error });
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const current = readHost(path);
    if (digest(current) !== expected) throw Error('Host manifest changed during startup');
    const probe = async () => {
      let h: Record<string, any>;
      try {
        h = await call(join(m.state, 'operator.sock'), '/v1/health', undefined, undefined, 2000);
      } catch {
        return false;
      }
      if (
        h.host_manifest_digest !== expected ||
        h.runtime_node !== m.node ||
        h.agentpod_pins_digest !== m.pins_digest ||
        canonical(h.managed_mcp ?? null) !==
          canonical(hostMcp(m) ? { profile_digest: hostMcp(m)!.profile_digest } : null) ||
        canonical(h.managed_toolkit ?? null) !==
          canonical(
            hostToolkit(m) ? { configuration_digest: hostToolkit(m)!.configuration_digest } : null,
          ) ||
        canonical(h.station_execution ?? null) !==
          canonical(
            m.schema === 5 || m.schema === 6
              ? { configuration_digest: m.station_execution.configuration_digest }
              : null,
          ) ||
        canonical(h.strict_work ?? null) !== canonical(m.schema === 6 ? m.strict_work : null) ||
        canonical(h.provider_route) !== canonical(m.provider)
      )
        throw new ServiceError(
          'host_mismatch',
          'Running daemon does not match the reviewed host manifest',
        );
      if (h.host_supervisor_connected !== true) return false;
      if (
        h.service !== 'healthy' ||
        h.job_execution?.control_error ||
        h.job_execution?.schedule_control_error ||
        h.job_execution?.inbox_control_error
      )
        throw Error('Reviewed host controls are not ready');
      return true;
    };
    if (!(await probe())) {
      const log = openSync(
        join(m.state, 'host.log'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const st = fstatSync(log);
        if (!st.isFile() || st.uid !== process.getuid?.() || st.mode & 0o077)
          throw Error('Host startup log must be private');
        const child = spawn(
          m.node,
          [join(m.repo, 'bin/salaam.mjs'), 'host', 'run', '--manifest', realpathSync(path)],
          {
            detached: true,
            stdio: ['ignore', log, log],
            env: {
              PATH: dirname(m.node) + ':/usr/bin:/bin',
              HOME: process.env.HOME,
              LANG: 'en_US.UTF-8',
            },
          },
        );
        let spawnError: Error | undefined;
        child.on('error', (error) => {
          spawnError = error;
        });
        child.unref();
        while (!(await probe())) {
          if (spawnError) throw spawnError;
          if (digest(readHost(path)) !== expected)
            throw Error('Host manifest changed during startup');
          if (Date.now() >= deadline)
            throw Error('Host did not become ready; inspect its private host.log');
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        closeSync(log);
      }
    }
    if (m.schema !== 2 && m.schema !== 3 && m.schema !== 4 && m.schema !== 5 && m.schema !== 6)
      throw Error('AgentPod manifest changed');
    const pins = readAgentPodPins(m.agentpod_config, m.state);
    return {
      version: 1,
      ready: true,
      manifest_digest: expected,
      node: m.node,
      cli: join(m.repo, 'bin/salaam.mjs'),
      state: m.state,
      workspace: m.workspace,
      node_id: pins.node_id,
      pins_digest: m.pins_digest,
      strict_work: m.schema === 6 ? m.strict_work : null,
    };
  } finally {
    release();
  }
}

const launcherUnit = /^salaam-host@[a-f0-9]{16}\.service$/;
/** Launcher profile: an unprivileged operator asks systemd to start a root-owned,
 * provisioned unit. It names only the unit; root reads its own reviewed manifest. */
export async function startHostUnit(
  unit: string,
  state: string,
  options: { systemctl?: string; timeoutMs?: number } = {},
) {
  if (!launcherUnit.test(unit)) throw Error('Unit must be salaam-host@<16 hex>.service');
  if (realpathSync(state) !== state) throw Error('Use the canonical state path');
  const socket = join(state, 'operator.sock'),
    deadline = Date.now() + (options.timeoutMs ?? 20000);
  const ready = async () => {
    let h: Record<string, any>;
    try {
      h = await call(socket, '/v1/health', undefined, undefined, 2000);
    } catch {
      return null;
    }
    if (!h.host_receipt || h.host_receipt.manifest_digest !== h.host_manifest_digest)
      throw new ServiceError('host_mismatch', 'Running daemon reports no reviewed host receipt');
    if (h.host_receipt.state !== state)
      throw new ServiceError('host_mismatch', 'Running daemon serves another state directory');
    if (h.host_supervisor_connected !== true || h.service !== 'healthy') return null;
    if (
      h.job_execution?.control_error ||
      h.job_execution?.schedule_control_error ||
      h.job_execution?.inbox_control_error
    )
      throw Error('Reviewed host controls are not ready');
    return h.host_receipt as Record<string, unknown>;
  };
  let receipt = await ready();
  if (receipt) return receipt;
  await new Promise<void>((done, fail) =>
    execFile(
      options.systemctl ?? '/usr/bin/systemctl',
      ['start', '--no-ask-password', unit],
      { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 20000 },
      (error) =>
        error ? fail(Error('systemd refused to start ' + unit + '; inspect its journal')) : done(),
    ),
  );
  while (!(receipt = await ready())) {
    if (Date.now() >= deadline) throw Error('Host unit did not become ready; inspect its journal');
    await new Promise((r) => setTimeout(r, 100));
  }
  return receipt;
}
