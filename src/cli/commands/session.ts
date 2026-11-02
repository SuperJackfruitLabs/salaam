import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { call, type SessionSnapshot } from '../../core/index.js';
import { acquireControl, Outbox } from '../../tui/index.js';
import type { CliContext } from './context.js';
import type { SessionRevocation } from '../../store/index.js';

export const ARTIFACTS_HELP = `salaam artifacts put SESSION_ID --text TEXT [--request-id ID] [--takeover]

Persist text evidence; reference its returned artifact ID in a task evidence fact.
Read it with salaam history read SESSION_ID --artifact-id ID.`;
export const TASK_HELP = `salaam task inspect SESSION_ID
salaam task update SESSION_ID --task-version N --kind objective|constraint|completed|outstanding|evidence --text TEXT
                          [--supersedes FACT_ID] [--artifact-id ID] [--request-id ID] [--takeover]

Updates are explicit and versioned. Corrections retain the original fact and its provenance.`;
export const HISTORY_HELP = `salaam history read SESSION_ID [--artifact-id ID|--entry-id ID] [--offset N]

Read bounded evidence/history pages, including entries preceding compaction.`;
export const COMPACTIONS_HELP = `salaam compactions inspect COMPACTION_ID
salaam compactions cancel COMPACTION_ID [--takeover] [--request-id ID]`;
export const SESSION_HELP = `salaam session create [--cwd DIR] [--request-id ID] [--coding | --local | --local-coding]
  --local-coding allows reviewed edits and native commands, each under the host OS sandbox
                 (see salaam help service for levels and read paths)
  --local allows bounded local file inspection; optionally select --provider ID --model ID
salaam session list
salaam session inspect SESSION_ID
salaam session submit SESSION_ID --text TEXT
salaam session continue SESSION_ID --attempt ATTEMPT_ID --text NEW_INSTRUCTION
salaam session resume SESSION_ID
salaam session cancel SESSION_ID --attempt ATTEMPT_ID [--takeover]
salaam session revoke SESSION_ID --reason TEXT [--request-id ID] [--takeover]
salaam session revocation SESSION_ID
salaam session probe SESSION_ID [--takeover]
salaam session children SESSION_ID
salaam session usage SESSION_ID
salaam session compact SESSION_ID --task-version N [--takeover] [--request-id ID]

Submissions are durable. Continuing an interrupted attempt creates a new instruction.
Revocation permanently fences the session and its descendants. Its receipt confirms
authority withdrawal; process stop and external effects require their own evidence.
Retry a lost revocation reply with the same request ID and reason.
Use salaam attach SESSION_ID for an interactive terminal.`;

/** salaam task inspect. */
export async function taskInspectCommand(ctx: CliContext): Promise<boolean> {
  const { socket, group, verb, id } = ctx;
  if (group === 'task' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/task`), null, 2));
    return true;
  }
  return false;
}
/** salaam history read. */
export async function historyCommand(ctx: CliContext): Promise<boolean> {
  const { option, socket, group, verb, id } = ctx;
  if (group === 'history' && verb === 'read' && id) {
    const query = new URLSearchParams();
    for (const key of ['artifact-id', 'entry-id', 'offset']) {
      const value = option('--' + key);
      if (value !== undefined) query.set(key.replace('-', '_'), value);
    }
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/history?${query}`), null, 2));
    return true;
  }
  return false;
}
/** salaam task update, session compact, compactions cancel and artifacts put: a write under the session's control. */
export async function recordCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (
    (group === 'task' && verb === 'update' && id) ||
    (group === 'session' && verb === 'compact' && id) ||
    (group === 'compactions' && verb === 'cancel' && id) ||
    (group === 'artifacts' && verb === 'put' && id)
  ) {
    const work =
      group === 'compactions'
        ? await call<{ session_id: string }>(socket, `/v1/compactions/${id}`)
        : null;
    const session = work?.session_id ?? id;
    const client_id = randomUUID();
    const lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
    const request_id = option('--request-id') ?? randomUUID();
    try {
      const expected = Number(option('--task-version'));
      const fact =
        group === 'task'
          ? {
              kind: option('--kind'),
              text: option('--text'),
              supersedes: option('--supersedes'),
              artifact_id: option('--artifact-id'),
            }
          : undefined;
      if (
        !['compactions', 'artifacts'].includes(group) &&
        (!Number.isSafeInteger(expected) || expected < 0)
      )
        throw new Error('Supply the reviewed --task-version from task inspect');
      console.log(JSON.stringify({ request_id }));
      console.log(
        JSON.stringify(
          await call(
            socket,
            group === 'compactions'
              ? `/v1/compactions/${id}/cancel`
              : `/v1/sessions/${session}/${group === 'task' ? 'task' : group === 'artifacts' ? 'artifacts' : 'compact'}`,
            {
              request_id,
              expected_version: expected,
              fact,
              ...(group === 'artifacts' ? { text: option('--text') } : {}),
              client_id,
              token: lease.token,
            },
          ),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${session}/control`, {
        request_id: randomUUID(),
        action: 'release',
        client_id,
        token: lease.token,
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
/** salaam compactions inspect. */
export async function compactionsCommand(ctx: CliContext): Promise<boolean> {
  const { socket, group, verb, id } = ctx;
  if (group === 'compactions' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/compactions/${id}`), null, 2));
    return true;
  }
  return false;
}
/** salaam session children and usage. */
export async function sessionReadCommand(ctx: CliContext): Promise<boolean> {
  const { socket, group, verb, id } = ctx;
  if (group === 'session' && id && (verb === 'children' || verb === 'usage')) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/${verb}`), null, 2));
    return true;
  }
  return false;
}
/** salaam session revocation, revoke and cancel. */
export async function sessionRevokeCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, state, socket, group, verb, id } = ctx;
  if (group === 'session' && verb === 'revocation' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/revocation`), null, 2));
    return true;
  }
  if (group === 'session' && verb === 'revoke' && id) {
    const reason = option('--reason');
    if (!reason) throw new Error('Supply --reason');
    const request_id = option('--request-id') ?? randomUUID();
    const saved = await call<SessionRevocation | null>(socket, `/v1/sessions/${id}/revocation`);
    if (saved?.request_id === request_id && saved.session_id === id) {
      if (saved.reason !== reason) throw new Error('Request ID already binds a different reason');
      console.log(JSON.stringify(saved, null, 2));
      return true;
    }
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      console.log(JSON.stringify({ request_id }));
      for (let retry = 0; ; retry++) {
        const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
        try {
          console.log(
            JSON.stringify(
              await call(socket, `/v1/sessions/${id}/revoke`, {
                ...controller,
                request_id,
                expected_revision: snapshot.revision,
                reason,
              }),
              null,
              2,
            ),
          );
          break;
        } catch (error) {
          if ((error as { code?: string }).code !== 'revision_conflict' || retry >= 7) throw error;
        }
      }
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  if (group === 'session' && verb === 'cancel' && id) {
    const attempt = option('--attempt');
    if (!attempt) throw new Error('Supply --attempt');
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
      const outbox = new Outbox(state, id);
      const record = outbox.enqueueCancellation(attempt, snapshot.revision, option('--request-id'));
      console.log(JSON.stringify({ request_id: record.request_id }));
      await outbox.flush(socket, id, controller);
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
/** salaam session submit, continue and resume. */
export async function sessionSubmitCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, state, socket, group, verb, id } = ctx;
  if (group === 'session' && ['submit', 'continue', 'resume'].includes(verb ?? '') && id) {
    const client = randomUUID();
    const lease = await acquireControl(socket, id, client, args.includes('--takeover'));
    const controller = { client_id: client, token: lease.token };
    try {
      if (verb !== 'resume') {
        const text = option('--text');
        if (!text) throw new Error('Supply --text with a new instruction');
        const continues = verb === 'continue' ? option('--attempt') : undefined;
        if (verb === 'continue' && !continues)
          throw new Error('Supply --attempt with the interrupted attempt ID');
        const snapshot = await call<SessionSnapshot>(socket, `/v1/sessions/${id}/snapshot`);
        const outbox = new Outbox(state, id);
        const pending = outbox.enqueue(text, snapshot.revision, continues);
        await outbox.flush(socket, id, controller);
        console.log(JSON.stringify({ request_id: pending.request_id, accepted: true }));
      }
      console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/resume`, controller)));
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
/** salaam session create, list, inspect and probe. */
export async function sessionCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'session' && verb === 'create') {
    const cwd = resolve(option('--cwd') ?? process.cwd());
    const requestId = option('--request-id') ?? randomUUID();
    if (args.includes('--coding')) {
      const health = await call<{ coding_root?: string | null }>(socket, '/v1/health');
      if (!health.coding_root)
        throw new Error(
          'Coding service is not configured; start with --coding-root (and --coding-socket for commands)',
        );
    }
    console.log(
      JSON.stringify(
        await call(socket, '/v1/sessions', {
          cwd,
          request_id: requestId,
          ...(args.includes('--coding') ? { coding: true } : {}),
          ...(args.includes('--local') || args.includes('--local-coding')
            ? {
                local_workspace: true,
                ...(args.includes('--local-coding') ? { local_coding: true } : {}),
                ...(option('--provider')
                  ? {
                      route: {
                        provider: option('--provider'),
                        model: option('--model'),
                        max_tokens: option('--max-output-tokens')
                          ? Number(option('--max-output-tokens'))
                          : undefined,
                      },
                    }
                  : {}),
              }
            : {}),
        }),
        null,
        2,
      ),
    );
    return true;
  }
  if (group === 'session' && verb === 'list') {
    console.log(JSON.stringify(await call(socket, '/v1/sessions'), null, 2));
    return true;
  }
  if (group === 'session' && verb === 'inspect' && id) {
    console.log(JSON.stringify(await call(socket, `/v1/sessions/${id}/snapshot`), null, 2));
    return true;
  }
  if (group === 'session' && verb === 'probe' && id) {
    const client_id = randomUUID();
    const lease = await acquireControl(socket, id, client_id, args.includes('--takeover'));
    const controller = { client_id, token: lease.token };
    try {
      console.log(
        JSON.stringify(
          await call(socket, `/v1/sessions/${id}/probe`, controller, undefined, 15000),
          null,
          2,
        ),
      );
    } finally {
      await call(socket, `/v1/sessions/${id}/control`, {
        ...controller,
        request_id: randomUUID(),
        action: 'release',
        expected_epoch: lease.epoch,
      }).catch(() => {});
    }
    return true;
  }
  return false;
}
