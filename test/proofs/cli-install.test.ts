import { test, expect } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, realpathSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/config.js';
import { call } from '../../src/transport.js';
import { until } from '../helpers.js';
import type { SessionSnapshot } from '../../src/protocol.js';

const exec = promisify(execFile);
test('npm link installs both executable names, with help/version and one shared service from outside the checkout', async () => {
  const prefix = mkdtempSync('/tmp/sal-install-'),
    state = mkdtempSync('/tmp/sal-installed-state-'),
    socket = join(state, 'operator.sock');
  const env = {
    ...process.env,
    npm_config_prefix: prefix,
    npm_config_cache: join(prefix, 'cache'),
  };
  const salaam = join(prefix, 'bin', 'salaam'),
    sal = join(prefix, 'bin', 'sal');
  let service: ReturnType<typeof spawn> | undefined;
  const run = async (command: string, ...args: string[]) =>
    (await exec(command, args, { cwd: state, env, timeout: 15000 })).stdout;
  try {
    await exec('npm', ['link', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], {
      cwd: ROOT,
      env,
      timeout: 15000,
    });
    expect(realpathSync(salaam)).toBe(join(ROOT, 'bin/salaam.mjs'));
    expect(realpathSync(sal)).toBe(realpathSync(salaam));
    expect(await run(salaam, '--help')).toBe(await run(sal, '--help'));
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    expect(await run(sal, '--version')).toBe(`salaam ${version}\n`);
    expect(await run(salaam, 'auth', '--help')).toContain('hidden prompt');
    expect(await run(sal, 'session', '--help')).toContain('session continue');
    expect(await run(sal, 'help', 'service')).toContain('--provider PROVIDER');
    expect(await run(sal, 'service', 'start', '--help')).toContain('service start');
    await expect(run(sal, 'nonesuch')).rejects.toThrow('Unknown or incomplete command');
    service = spawn(salaam, ['service', 'start', '--foreground', '--state', state], {
      cwd: state,
      env,
    });
    let stderr = '';
    service.stderr!.on('data', (chunk) => (stderr += chunk));
    await until(async () => {
      try {
        return await call(socket, '/v1/health');
      } catch {
        return null;
      }
    }, Boolean);
    const session = JSON.parse(
      await run(sal, 'session', 'create', '--cwd', state, '--state', state),
    );
    await expect(
      run(sal, 'session', 'create', '--cwd', state, '--coding', '--state', state),
    ).rejects.toThrow('Coding service is not configured');
    await until(
      () => call<SessionSnapshot>(socket, `/v1/sessions/${session.id}/snapshot`),
      (x) => x.state === 'ready',
    );
    // A literal help flag supplied as prompt text must remain an instruction.
    await run(salaam, 'session', 'submit', session.id, '--text', '--help', '--state', state);
    const final = await until(
      () => call<SessionSnapshot>(socket, `/v1/sessions/${session.id}/snapshot`),
      (x) => x.attempts[0]?.state === 'completed',
    );
    expect(final.attempts[0]!.result).toBe('Offline reply: --help');
    expect(JSON.parse(await run(sal, 'service', 'status', '--state', state)).sessions).toHaveLength(
      1,
    );
    const exit = once(service, 'exit');
    await run(sal, 'service', 'stop', '--state', state);
    await exit;
    expect(stderr).toBe('');
  } finally {
    if (service && service.exitCode === null && service.signalCode === null) {
      const exit = once(service, 'exit');
      service.kill('SIGKILL');
      await exit;
    }
    rmSync(prefix, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
test('a clean checkout launcher explains the missing build instead of showing a module stack trace', async () => {
  const dir = mkdtempSync('/tmp/sal-unbuilt-');
  try {
    mkdirSync(join(dir, 'bin'));
    cpSync(join(ROOT, 'bin/salaam.mjs'), join(dir, 'bin/salaam.mjs'));
    cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
    await expect(exec(process.execPath, [join(dir, 'bin/salaam.mjs'), '--help'])).rejects.toThrow(
      'Run npm run build',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
