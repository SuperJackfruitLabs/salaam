import { randomUUID } from 'node:crypto';
import { digest, call } from '../../core/index.js';
import { acquireControl } from '../../tui/index.js';
import type { CliContext } from './context.js';

export const WORKERS_HELP = `salaam workers proposal CHILD_ID [--offset N]
salaam workers integrate CHILD_ID --revision N --root-digest SHA256 --patch-digest SHA256
salaam workers integration RECEIPT_ID
salaam workers resolve RECEIPT_ID --revision N --root-digest SHA256

Writing specialists use private drafts. Review every proposal page and the root digest before integration.
Integration does not verify a task. Resolution explicitly admits a new apply only against its unchanged original root.
Mutations accept --request-id ID and --takeover.`;
export const TEAM_HELP = `salaam team show TASK_ID
salaam team assign TASK_ID --step STEP_ID --profile PROFILE_ID --requests N --revision N
salaam team assign TASK_ID --step STEP_ID --profile PROFILE_ID --runtime RUNTIME_ID --invocations 1 --revision N
salaam team run TASK_ID --assignment ID --generation N --revision N [--instruction TEXT --continues ATTEMPT_ID]
salaam team send TASK_ID --to ASSIGNMENT_ID --text TEXT
salaam team receive TASK_ID --assignment ID
salaam team ack TASK_ID --assignment ID --message MESSAGE_ID
salaam team reject TASK_ID --assignment ID --generation N --revision N --reason TEXT

Mutations accept --request-id ID and --takeover. Claims bind the plan, admitted profile and generation.
Messages never wake workers. Use run for an explicit new claim or follow-up.
External assignments require a task with explicit limits.invocations and
token_units:null. Their internal model usage is reported as unknown.`;
export const AGENTS_HELP = `salaam agents list --session SESSION_ID
salaam agents inspect PROFILE_ID --session SESSION_ID
salaam agents admit PROFILE_ID --session SESSION_ID --digest REVIEWED_DIGEST [--facts ID,ID]
salaam agents revoke GRANT_ID --session SESSION_ID

Profiles are data in .salaam/agents/*.md with JSON front matter and a prompt body.
Inspect the effective tools and digest before admission. Project definitions cannot
grant themselves authority. Mutations accept --request-id and --takeover.`;

/** salaam workers: review and integrate isolated proposals. */
export async function workersCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'workers') {
    if (!id) throw new Error('Supply a child or integration receipt ID');
    if (verb === 'proposal' || verb === 'integration') {
      const result = await call<{
        changes: { path: string; before: unknown; after: unknown }[];
        diff: string[];
      }>(
        socket,
        verb === 'proposal'
          ? `/v1/workers/${id}/proposal?offset=${Number(option('--offset') ?? 0)}`
          : `/v1/integrations/${id}`,
      );
      if (verb === 'proposal' && !args.includes('--json')) {
        const { changes, diff, ...metadata } = result;
        console.log(
          JSON.stringify(
            {
              ...metadata,
              files: changes.map((c) => ({
                path: c.path,
                before_hash: digest(c.before),
                after_hash: digest(c.after),
              })),
            },
            null,
            2,
          ),
        );
        for (const patch of diff) console.log(patch);
      } else console.log(JSON.stringify(result, null, 2));
      return true;
    }
    if (!['integrate', 'resolve'].includes(verb ?? ''))
      throw new Error('Use workers proposal, integrate, integration or resolve');
    const owner =
      verb === 'integrate'
        ? (await call<{ parent_session: string }>(socket, `/v1/children/${id}`)).parent_session
        : (await call<{ parent_session: string }>(socket, `/v1/integrations/${id}`)).parent_session;
    const revision = option('--revision'),
      workspace_digest = option('--root-digest'),
      patch_digest = option('--patch-digest');
    if (revision === undefined || !workspace_digest || (verb === 'integrate' && !patch_digest))
      throw new Error(
        'Supply reviewed --revision N, --root-digest SHA256 and --patch-digest SHA256 for integration',
      );
    const client_id = randomUUID(),
      lease = await acquireControl(socket, owner, client_id, args.includes('--takeover'));
    try {
      const result = await call(
        socket,
        verb === 'integrate' ? `/v1/workers/${id}/integrate` : `/v1/integrations/${id}/resolve`,
        {
          client_id,
          token: lease.token,
          request_id: option('--request-id') ?? randomUUID(),
          workspace_revision: Number(revision),
          workspace_digest,
          patch_digest,
        },
      );
      console.log(JSON.stringify(result, null, 2));
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
/** salaam team: assignments and the team inbox. */
export async function teamCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'team') {
    if (!id) throw new Error('Supply TASK_ID');
    if (verb === 'show') {
      console.log(JSON.stringify(await call(socket, `/v1/tasks/${id}/team`), null, 2));
      return true;
    }
    if (!['assign', 'run', 'reject', 'send', 'receive', 'ack'].includes(verb ?? ''))
      throw new Error('Use team show, assign, run, send, receive or ack');
    const task = await call<{ session_id: string }>(socket, `/v1/tasks/${id}`);
    const client_id = randomUUID(),
      lease = await acquireControl(socket, task.session_id, client_id, args.includes('--takeover'));
    try {
      const assignment = option('--assignment');
      if (['run', 'reject', 'receive', 'ack'].includes(verb!) && !assignment)
        throw new Error('Supply --assignment ID');
      const revision = option('--revision'),
        generation = option('--generation');
      if (['assign', 'run', 'reject'].includes(verb!) && revision === undefined)
        throw new Error('Supply the reviewed --revision N');
      if (['run', 'reject'].includes(verb!) && generation === undefined)
        throw new Error('Supply the reviewed --generation N');
      const path = assignment ? `${assignment}/${verb}` : verb;
      const result = await call(socket, `/v1/tasks/${id}/team/${path}`, {
        client_id,
        token: lease.token,
        request_id: option('--request-id') ?? randomUUID(),
        expected_revision: revision === undefined ? undefined : Number(revision),
        generation: generation === undefined ? undefined : Number(generation),
        ...(verb === 'assign'
          ? {
              step_id: option('--step'),
              profile_id: option('--profile'),
              ...(() => {
                const runtime = option('--runtime');
                return runtime
                  ? { runtime, invocations: Number(option('--invocations')) }
                  : { requests: Number(option('--requests')) };
              })(),
            }
          : {}),
        ...(verb === 'run'
          ? { instruction: option('--instruction'), continues_attempt_id: option('--continues') }
          : {}),
        ...(verb === 'send' ? { recipient: option('--to'), text: option('--text') } : {}),
        ...(verb === 'ack' ? { message_id: option('--message') } : {}),
        ...(verb === 'reject' ? { reason: option('--reason') } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await call(socket, `/v1/sessions/${task.session_id}/control`, {
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
/** salaam agents: specialist profiles. */
export async function agentsCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'agents') {
    const session = option('--session');
    if (!session) throw new Error('Supply --session SESSION_ID');
    if (verb === 'list' || verb === 'inspect') {
      console.log(
        JSON.stringify(
          await call(
            socket,
            `/v1/sessions/${session}/agents${verb === 'inspect' ? '?profile=' + encodeURIComponent(id ?? '') : ''}`,
          ),
          null,
          2,
        ),
      );
      return true;
    }
    if (!id || !['admit', 'revoke'].includes(verb ?? ''))
      throw new Error('Use agents list, inspect, admit or revoke');
    const client_id = randomUUID(),
      lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
    try {
      const expected_digest = option('--digest');
      if (verb === 'admit' && !expected_digest)
        throw new Error('Review agents inspect and supply --digest SHA256');
      const fact_ids = option('--facts')?.split(',').filter(Boolean) ?? [];
      const result = await call(socket, `/v1/sessions/${session}/agents/${verb}`, {
        request_id: option('--request-id') ?? randomUUID(),
        client_id,
        token: lease.token,
        ...(verb === 'admit' ? { profile_id: id, expected_digest, fact_ids } : { grant_id: id }),
      });
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await call(socket, `/v1/sessions/${session}/control`, {
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
