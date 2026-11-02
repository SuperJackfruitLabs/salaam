import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { call, HARNESS_TARGETS, type HarnessTarget } from '../../core/index.js';
import { readFileSync, realpathSync } from 'node:fs';
import { acquireControl } from '../../tui/index.js';
import { probeHarness, type HarnessPin } from '../../harness/index.js';
import type { CliContext } from './context.js';

export const HARNESS_HELP = `salaam harness probe --pin FILE
salaam harness prepare --runtime-root NEW_DIR --arch linux-arm64|linux-x64
salaam harness config --target TARGET --runtime-root PREPARED_DIR [--id ID]
salaam harness list
salaam harness inspect CHILD_ID
salaam harness reconcile CHILD_ID --run-id RUN_ID

Negotiate an operator-pinned external harness in a disposable empty home, with no
repository, credentials or model request. FILE contains target, executable,
executable_digest and version. Targets: gemini-acp, claude-acp, codex-app-server.
Advertised capabilities are separate from enforced authority. A probe grants no
file, command or worker-dispatch permission. A service started with an owner-only
--harness-config FILE runs fresh Docker readiness proofs before admitting configured
targets. Reconcile confirms stopped resources; it never resends a prompt.`;

/** salaam harness probe, prepare and config. */
export async function harnessCommand(ctx: CliContext): Promise<boolean> {
  const { option, group, verb } = ctx;
  if (group === 'harness' && verb === 'probe') {
    const path = option('--pin');
    if (!path) throw new Error('Supply an operator-reviewed --pin FILE');
    const pin = JSON.parse(readFileSync(resolve(path), 'utf8')) as HarnessPin;
    console.log(JSON.stringify(await probeHarness(pin), null, 2));
    return true;
  }
  if (group === 'harness' && verb === 'prepare') {
    const path = option('--runtime-root'),
      arch = option('--arch');
    if (!path || !arch) throw Error('Supply a new --runtime-root and execution-host --arch');
    const { prepareHarnessRuntime } = await import('../../harness/prepare.js');
    console.log(JSON.stringify(await prepareHarnessRuntime(path, arch), null, 2));
    return true;
  }
  if (group === 'harness' && verb === 'config') {
    const target = option('--target'),
      path = option('--runtime-root');
    if (!target || !Object.hasOwn(HARNESS_TARGETS, target) || !path)
      throw Error('Supply a named --target and dedicated --runtime-root');
    const runtime_root = realpathSync(resolve(path));
    const { assertHarnessArtifactRoot, harnessRuntimeDigest } =
      await import('../../harness/backend.js');
    assertHarnessArtifactRoot(runtime_root);
    console.log(
      JSON.stringify(
        {
          schema: 1,
          runtimes: [
            {
              id: option('--id') ?? target,
              target,
              version: HARNESS_TARGETS[target as HarnessTarget].version,
              runtime_root,
              runtime_digest: await harnessRuntimeDigest(runtime_root),
              model: 'claude-sonnet-4-6',
              output: 4096,
              requests: 12,
            },
          ],
        },
        null,
        2,
      ),
    );
    return true;
  }
  return false;
}
/** salaam harness|a2a list, inspect and reconcile: external child work. */
export async function externalCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (
    ['harness', 'a2a'].includes(group ?? '') &&
    ['list', 'inspect', 'reconcile'].includes(verb ?? '')
  ) {
    if (verb === 'list') {
      console.log(JSON.stringify(await call(socket, '/v1/harnesses'), null, 2));
      return true;
    }
    if (!id) throw Error('Supply an external CHILD_ID');
    const current = await call<{ child: { parent_session: string } }>(
      socket,
      `/v1/harnesses/${id}`,
    );
    if (verb === 'inspect') {
      console.log(JSON.stringify(current, null, 2));
      return true;
    }
    const run_id = option('--run-id');
    if (!run_id) throw Error('Supply the exact --run-id from harness inspect');
    const client_id = randomUUID(),
      owner = current.child.parent_session,
      lease = await acquireControl(socket, owner, client_id, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/harnesses/${id}/reconcile`, {
            client_id,
            token: lease.token,
            run_id,
            request_id: option('--request-id') ?? randomUUID(),
          }),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${owner}/control`, {
        request_id: randomUUID(),
        client_id,
        token: lease.token,
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
