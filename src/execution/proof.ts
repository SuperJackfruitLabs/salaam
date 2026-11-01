import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { fork } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BOUNDARY_DIGEST,
  BOUNDARY_IMAGE,
  BOUNDARY_PROFILE,
  BoundaryBroker,
  BoundaryError,
  engineRequest,
} from './boundary.js';
import { digest } from '../core/index.js';

export interface BoundaryProofOptions {
  socket: string;
  scratchRoot: string;
  report: string;
}

function save(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Real engine proof, separate from the offline suite. Never reads real Salaam state/keys. */
export async function proveExecutionBoundary(options: BoundaryProofOptions): Promise<boolean> {
  const reportPath = resolve(options.report);
  const run = randomUUID();
  const report: Record<string, any> = {
    schema: 1,
    operator: { platform: process.platform, arch: process.arch, node: process.version },
    run_id: run,
    started_at: new Date().toISOString(),
    status: 'running',
    coding_tools_enabled: false,
    profile: BOUNDARY_PROFILE,
    profile_digest: BOUNDARY_DIGEST,
    image: BOUNDARY_IMAGE,
    source_digest: digest([
      readFileSync(new URL('./boundary.js', import.meta.url), 'utf8'),
      readFileSync(new URL('./proof.js', import.meta.url), 'utf8'),
      readFileSync(new URL('./orphan.js', import.meta.url), 'utf8'),
    ]),
    checks: [],
  };
  // Persist identity before any engine mutation. Failure (including disk full) prevents create.
  save(reportPath, report);
  let dir: string | undefined;
  let broker: BoundaryBroker | undefined;
  const servers: ReturnType<typeof createServer>[] = [];
  const previousCanary = process.env.SALAAM_BOUNDARY_CANARY;
  process.env.SALAAM_BOUNDARY_CANARY = randomUUID();
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    report.checks.push({ name, passed: ok, ...(detail === undefined ? {} : { detail }) });
    if (!ok) throw new BoundaryError(`proof_failed:${name}`);
  };
  try {
    const root = realpathSync(options.scratchRoot);
    dir = mkdtempSync(join(root, 'proof-'));
    chmodSync(dir, 0o755); // Denial must come from isolation, rather than host permission bits.
    const workspace = join(dir, 'workspace');
    const secretDir = join(dir, 'private');
    mkdirSync(workspace, { mode: 0o777 });
    chmodSync(workspace, 0o777);
    mkdirSync(secretDir, { mode: 0o755 });
    writeFileSync(join(workspace, 'input'), 'workspace-canary', { mode: 0o644 });
    const secrets = ['credential', 'journal.sqlite', 'home-key'];
    for (const name of secrets) writeFileSync(join(secretDir, name), randomUUID(), { mode: 0o644 });
    // Real host sockets with a reachable positive control. Their parents are never mounted.
    for (const name of ['operator.sock', 'bridge.sock', 'docker.sock']) {
      const socket = join(secretDir, name);
      const server = createServer((connection) => connection.end('host-control-canary'));
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, resolve);
      });
      chmodSync(socket, 0o666);
      await new Promise<void>((resolve, reject) => {
        const client = createConnection(socket);
        client.once('error', reject);
        client.once('data', (value) => {
          client.destroy();
          if (value.toString() === 'host-control-canary') resolve();
          else reject(new Error('Socket canary unavailable'));
        });
      });
    }
    symlinkSync(join(secretDir, 'credential'), join(workspace, 'escape-absolute'));
    symlinkSync('../private/journal.sqlite', join(workspace, 'escape-relative'));
    symlinkSync(join(secretDir, 'home-key'), join(workspace, 'escape-home'));
    symlinkSync(join(secretDir, 'operator.sock'), join(workspace, 'escape-socket'));
    symlinkSync(join(secretDir, 'bridge.sock'), join(workspace, 'escape-bridge'));
    symlinkSync(join(secretDir, 'docker.sock'), join(workspace, 'escape-daemon'));
    const canaries = secrets.map((name) => readFileSync(join(secretDir, name), 'utf8'));
    const engine = engineRequest(options.socket);
    broker = new BoundaryBroker(run, engine);
    report.backend = await broker.prepare();
    check('backend-and-pinned-image', true);
    save(reportPath, report);

    const isolation = await broker.create(workspace, 'isolation');
    check('effective-profile-inspected-before-start', true, { container: isolation });
    await broker.start(isolation);
    const exit = await broker.wait(isolation);
    const logs = await broker.logs(isolation);
    check(
      'workspace-environment-filesystem-network-kernel-limits',
      exit === 0 && logs.includes('isolation-ok'),
      { exit, logs },
    );
    check(
      'workspace-write-visible-on-host',
      readFileSync(join(workspace, 'result'), 'utf8').trim() === 'workspace-write',
    );
    check(
      'host-private-files-unchanged',
      secrets.every(
        (name, index) => readFileSync(join(secretDir, name), 'utf8') === canaries[index],
      ),
    );
    check('completed-container-removed', (await broker.cleanup()).includes(isolation));

    // Change a real daemon-side limit after creation. No probe process may start.
    const drifted = await broker.create(workspace, 'timeout');
    const update = await engine('POST', `/containers/${drifted}/update`, {
      Memory: 64 * 1024 * 1024,
      MemorySwap: 64 * 1024 * 1024,
    });
    check('profile-drift-injected-on-real-engine', update.status === 200);
    let denied = false;
    try {
      await broker.start(drifted);
    } catch (error) {
      denied =
        error instanceof BoundaryError && error.code.startsWith('execution_profile_mismatch');
    }
    const driftState = JSON.parse(
      (await engine('GET', `/containers/${drifted}/json`)).body.toString(),
    ).State;
    check(
      'changed-profile-denied-before-start',
      denied && driftState.Status === 'created' && !driftState.Running,
    );
    await broker.cleanup();

    const timeout = await broker.create(workspace, 'timeout');
    await broker.start(timeout);
    let timedOut = false;
    try {
      await broker.wait(timeout, 250);
    } catch (error) {
      timedOut = error instanceof BoundaryError && error.code === 'execution_backend_timeout';
    }
    check('wall-deadline-fails-closed', timedOut);
    check('timed-out-container-removed', (await broker.cleanup()).includes(timeout));

    const output = await broker.create(workspace, 'output');
    await broker.start(output);
    await broker.wait(output);
    let bounded = false;
    try {
      await broker.logs(output);
    } catch (error) {
      bounded = error instanceof BoundaryError && error.code === 'execution_output_limit';
    }
    check('output-reader-bounded', bounded);
    await broker.cleanup();

    const helper = fork(new URL('./orphan.js', import.meta.url), [options.socket, workspace, run], {
      env: {},
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let orphan: string;
    try {
      orphan = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Orphan helper timed out')), 10_000);
        helper.once('message', (value: any) => {
          clearTimeout(timer);
          if (/^[a-f0-9]{64}$/.test(value?.id)) resolve(value.id);
          else reject(new Error('Invalid helper identity'));
        });
        helper.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        helper.once('exit', () => {
          clearTimeout(timer);
          reject(new Error('Helper exited early'));
        });
      });
    } finally {
      await new Promise<void>((resolve) => {
        if (helper.exitCode !== null || helper.signalCode !== null) {
          resolve();
          return;
        }
        helper.once('exit', () => resolve());
        helper.kill('SIGKILL');
      });
    }
    check('broker-process-killed-with-owned-descendant-live', true, { container: orphan });
    // A replacement broker reconciles only the saved run's containers; never restarts them.
    broker = new BoundaryBroker(run, engineRequest(options.socket));
    check(
      'replacement-broker-reaps-orphan-without-replay',
      (await broker.cleanup()).includes(orphan),
    );
    await delay(3_250);
    check('cancelled-descendant-cannot-write-later', !existsSync(join(workspace, 'escaped')));
    check('final-owned-container-set-empty', (await broker.cleanup()).length === 0);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    // Engine error bodies and host env/credential material are deliberately not evidence output.
    report.error = error instanceof BoundaryError ? error.code : 'proof_infrastructure_failure';
  } finally {
    if (broker) {
      try {
        await broker.cleanup();
        report.cleanup_confirmed = true;
      } catch {
        report.cleanup_confirmed = false;
        report.status = 'failed';
      }
    }
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    // If the engine is unavailable, retain the canaries/workspace for explicit reconciliation.
    if (dir && (!broker || report.cleanup_confirmed)) rmSync(dir, { recursive: true, force: true });
    else if (dir) report.retained_scratch = dir;
    if (previousCanary === undefined) delete process.env.SALAAM_BOUNDARY_CANARY;
    else process.env.SALAAM_BOUNDARY_CANARY = previousCanary;
    report.finished_at = new Date().toISOString();
    save(reportPath, report);
  }
  return report.status === 'passed';
}
