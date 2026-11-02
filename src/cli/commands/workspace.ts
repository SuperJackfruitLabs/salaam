import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { call, workspaceDiff, type WorkspaceChange } from '../../core/index.js';
import { acquireControl } from '../../tui/index.js';
import { proveExecutionBoundary, BoundaryBroker, engineRequest } from '../../execution/index.js';
import type { CliContext } from './context.js';

interface WorkspaceDiffPage {
  revision: number;
  digest: string;
  changes: WorkspaceChange[];
  next_offset: number | null;
}

export const WORKSPACE_HELP = `salaam workspace inspect SESSION_ID
salaam workspace diff SESSION_ID
salaam workspace refresh SESSION_ID --revision N --digest REVIEWED_OBSERVED_DIGEST [--takeover]

Inspect an owned coding copy, print its checked diff, or acknowledge exact human edits.
The source checkout stays outside the writable coding workspace.`;
export const COMMANDS_HELP = `salaam commands list SESSION_ID
salaam commands start SESSION_ID --step-key KEY --command TEXT --revision N [--cwd RELATIVE_DIR]
salaam commands inspect SESSION_ID --run-id UUID
salaam commands logs SESSION_ID --run-id UUID [--offset BYTES]
salaam commands cancel SESSION_ID --run-id UUID [--takeover]
salaam commands reconcile SESSION_ID --run-id UUID [--takeover]

Commands use a proven executor and a disposable working copy. Persist edits with the
guarded file tool. A repeated step key returns the same run without executing again.`;
export const EXECUTION_HELP = `salaam execution prove --docker-socket PATH --scratch-root DIR --report PATH
salaam execution cleanup --docker-socket PATH --run-id UUID

Run the M9.1 boundary proof on a pre-provisioned local Linux Docker engine.
Only disposable fixtures are mounted. The pinned image must already be present.
No coding tools are enabled. A failed/unavailable backend exits nonzero.
Cleanup reconciles the saved proof run without replaying commands.`;

/** salaam workspace: a coding copy, its diff and its refresh. */
export async function workspaceCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'workspace' && id && ['inspect', 'diff', 'refresh'].includes(verb ?? '')) {
    if (verb === 'inspect') {
      console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/workspace`), null, 2));
      return true;
    }
    if (verb === 'diff') {
      let offset: number | null = 0,
        identity: string | undefined;
      while (offset !== null) {
        const page: WorkspaceDiffPage = await call<WorkspaceDiffPage>(
          socket,
          `/v1/sessions/${id}/workspace/diff?offset=${offset}`,
        );
        const nextIdentity = `${page.revision}:${page.digest}`;
        if (identity && identity !== nextIdentity)
          throw new Error('Workspace changed while reading diff');
        identity = nextIdentity;
        for (const file of page.changes) {
          process.stdout.write(workspaceDiff(file));
        }
        offset = page.next_offset;
      }
      return true;
    }
    const expected = Number(option('--revision')),
      reviewed = option('--digest');
    if (!Number.isSafeInteger(expected) || !reviewed)
      throw new Error('Supply reviewed --revision and --digest');
    const client = randomUUID(),
      lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/sessions/${id}/workspace/refresh`, {
            request_id: option('--request-id') ?? randomUUID(),
            expected_revision: expected,
            digest: reviewed,
            client_id: client,
            token: lease.token,
          }),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id: client,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
/** salaam commands: isolated commands in a coding workspace. */
export async function commandsCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (
    group === 'commands' &&
    id &&
    ['list', 'inspect', 'logs', 'start', 'cancel', 'reconcile'].includes(verb ?? '')
  ) {
    const run = option('--run-id');
    if (['list', 'inspect', 'logs'].includes(verb!)) {
      if (verb !== 'list' && !run) throw new Error('Supply --run-id');
      const path =
        `/v1/sessions/${id}/commands` +
        (verb === 'list' ? '?summary=1' : `/${run}`) +
        (verb === 'logs' ? `/logs?offset=${Number(option('--offset') ?? 0)}` : '');
      console.log(JSON.stringify(await call(socket, path), null, 2));
      return true;
    }
    if (verb !== 'start' && !run) throw new Error('Supply --run-id');
    const body =
      verb === 'start'
        ? {
            step_key: option('--step-key'),
            command: option('--command'),
            cwd: option('--cwd') ?? '.',
            expected_revision: Number(option('--revision')),
          }
        : { request_id: option('--request-id') ?? randomUUID() };
    const client = randomUUID(),
      lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    try {
      console.log(
        JSON.stringify(
          await call(
            socket,
            `/v1/sessions/${id}/commands` + (verb === 'start' ? '' : `/${run}/${verb}`),
            { ...body, client_id: client, token: lease.token },
          ),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id: client,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
/** salaam execution: prove the container boundary, or clean up after a proof. */
export async function executionCommand(ctx: CliContext): Promise<boolean> {
  const { option, group, verb } = ctx;
  if (group === 'execution' && ['prove', 'cleanup'].includes(verb ?? '')) {
    const dockerSocket = option('--docker-socket');
    if (!dockerSocket) throw new Error('Supply an explicit local --docker-socket PATH');
    if (verb === 'cleanup') {
      const run = option('--run-id');
      if (!run) throw new Error('Supply the saved proof --run-id UUID');
      const removed = await new BoundaryBroker(run, engineRequest(dockerSocket)).cleanup();
      console.log(JSON.stringify({ removed, cleanup_confirmed: true }));
    } else {
      const scratchRoot = option('--scratch-root');
      const report = option('--report');
      if (!scratchRoot || !report) throw new Error('Supply --scratch-root DIR and --report PATH');
      const passed = await proveExecutionBoundary({ socket: dockerSocket, scratchRoot, report });
      console.log(JSON.stringify({ passed, report: resolve(report), coding_tools_enabled: false }));
      if (!passed) process.exitCode = 1;
    }
    return true;
  }
  return false;
}
