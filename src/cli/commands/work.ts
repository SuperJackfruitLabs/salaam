import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { call } from '../../core/index.js';
import { readFileSync } from 'node:fs';
import { acquireControl } from '../../tui/index.js';
import type { CliContext } from './context.js';

export const SCHEDULES_HELP = `salaam schedules create TASK_ID --name NAME --revision N --max-steps N [--schedule FILE] [--compact]
salaam schedules list [--offset N]
salaam schedules inspect JOB_ID
salaam schedules occurrences JOB_ID [--offset N]
salaam schedules run JOB_ID --key STABLE_KEY --revision N
salaam schedules update JOB_ID --revision N --status active|paused|cancelled [--schedule FILE]

Capture a reviewed immutable plan and workspace template. Every occurrence receives
fresh session/task/workspace IDs. Omit --schedule for explicit triggers only.
FILE: {"kind":"interval","anchor":1792281600000,"every_ms":3600000,"missed":"skip","max_catch_up":1}
Daily schedules require time HH:mm, timezone IANA, gap skip, fold first|second,
missed skip|catch_up, and max_catch_up 1–8. Updates append a revision and restart
the cursor from now. Pausing stops future admission; cancellation also revokes active work.
Mutations accept --request-id and --takeover. Unknown work prevents overlap.`;
export const INBOX_HELP = `salaam inbox list [--offset N]
salaam inbox inspect ITEM_ID
salaam inbox ack ITEM_ID --revision N [--request-id ID] [--takeover]

Shared durable attention for approvals, unknown effects, infrastructure, checks
and task results. Acknowledgement clears only the inspected revision; it never
approves an operation, retries work or marks a task successful.`;
export const JOBS_HELP = `salaam jobs create TASK_ID --name NAME --revision TASK_REVISION --max-steps N [--compact]
salaam jobs list [--offset N]
salaam jobs inspect JOB_ID
salaam jobs run JOB_ID --key STABLE_OCCURRENCE_KEY --revision JOB_REVISION
salaam jobs occurrence OCCURRENCE_ID
salaam jobs cancel JOB_ID --revision JOB_REVISION

Mutations accept --request-id ID and --takeover. A job binds one reviewed, unstarted
checked task, workspace, provider/executor profile and bounded progression grant.
Its one logical occurrence survives retries and daemon replacement; changing the key
cannot create a second run. Interrupted work requires explicit task continuation.
Use schedules for fresh recurring occurrences. Public trigger gateways remain disabled.`;
export const TASKS_HELP = `salaam tasks create SESSION_ID --plan FILE --revision 0
salaam tasks current SESSION_ID
salaam tasks inspect TASK_ID
salaam tasks history TASK_ID [--offset N]
salaam tasks revise TASK_ID --plan FILE --revision TASK_REVISION
salaam tasks run TASK_ID --step STEP_ID --revision TASK_REVISION [--text INSTRUCTION]
                 [--continue-attempt INTERRUPTED_ATTEMPT_ID]
salaam tasks complete TASK_ID --step STEP_ID --revision TASK_REVISION --review TEXT
salaam tasks verify TASK_ID --check KEY --revision N [--step STEP_ID]
salaam tasks finish TASK_ID --revision N [--exception-reason TEXT --evidence-artifact ID]
salaam tasks checkpoint TASK_ID --revision N
salaam tasks checkpoints TASK_ID
salaam tasks restore TASK_ID --checkpoint ID --revision N --workspace-revision N --workspace-digest DIGEST
salaam tasks restores TASK_ID
salaam tasks auto TASK_ID --revision N --max-steps N [--compact]
salaam tasks pause TASK_ID --revision N
salaam tasks cancel TASK_ID --revision N

Mutations accept --request-id ID and --takeover. Reuse the same request ID and input
when retrying a lost response. One task per session. Automatic progression is opt-in
and bounded by step, request, runtime, concurrency and declared token limits.
Plans may explicitly set limits.token_units to null to disable token budgeting;
request/runtime limits and approvals still apply. Unsupported output caps are rejected.
Success requires fresh command receipts and deliverables at the exact workspace revision.
Operator exceptions are reported separately. Checkpoints preserve conflicting human edits.
Legacy task facts remain under the singular task command.`;

/** salaam schedules: recurring jobs. */
export async function schedulesCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'schedules' && verb) {
    if (verb === 'list' || (id && ['inspect', 'occurrences'].includes(verb))) {
      console.log(
        JSON.stringify(
          await call(
            socket,
            verb === 'list'
              ? '/v1/schedules?offset=' + (option('--offset') ?? '0')
              : `/v1/schedules/${id}` +
                  (verb === 'occurrences'
                    ? '/occurrences?offset=' + (option('--offset') ?? '0')
                    : ''),
          ),
          null,
          2,
        ),
      );
      return true;
    }
    if (id && ['create', 'update', 'run'].includes(verb)) {
      const revision = Number(option('--revision'));
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error('Supply reviewed --revision');
      const target = await call<{ session_id: string }>(
        socket,
        verb === 'create' ? `/v1/tasks/${id}` : `/v1/schedules/${id}`,
      );
      const client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          target.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        const file = option('--schedule');
        const body = {
          client_id,
          token: lease.token,
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: revision,
          ...(verb === 'run'
            ? { occurrence_key: option('--key') }
            : verb === 'create'
              ? {
                  task_id: id,
                  name: option('--name'),
                  max_steps: Number(option('--max-steps')),
                  compact: args.includes('--compact'),
                  schedule: file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : null,
                }
              : {
                  schedule: file ? JSON.parse(readFileSync(resolve(file), 'utf8')) : null,
                  state: option('--status'),
                }),
        };
        console.log(
          JSON.stringify(
            await call(
              socket,
              verb === 'create' ? '/v1/schedules' : `/v1/schedules/${id}/${verb}`,
              body,
            ),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${target.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}
/** salaam inbox: shared operator attention. */
export async function inboxCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'inbox' && verb) {
    if (verb === 'list' || (verb === 'inspect' && id)) {
      console.log(
        JSON.stringify(
          await call(
            socket,
            verb === 'list' ? '/v1/inbox?offset=' + (option('--offset') ?? '0') : `/v1/inbox/${id}`,
          ),
          null,
          2,
        ),
      );
      return true;
    }
    if (verb === 'ack' && id) {
      const entry = await call<{ session_id: string }>(socket, `/v1/inbox/${id}`),
        client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          entry.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        console.log(
          JSON.stringify(
            await call(socket, `/v1/inbox/${id}/ack`, {
              client_id,
              token: lease.token,
              request_id: option('--request-id') ?? randomUUID(),
              expected_revision: Number(option('--revision')),
            }),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${entry.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}
/** salaam jobs: one-shot jobs. */
export async function jobsCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'jobs' && verb) {
    if (verb === 'list') {
      console.log(
        JSON.stringify(
          await call(socket, '/v1/jobs?offset=' + encodeURIComponent(option('--offset') ?? '0')),
          null,
          2,
        ),
      );
      return true;
    }
    if (id && ['inspect', 'occurrence'].includes(verb)) {
      console.log(
        JSON.stringify(
          await call(socket, verb === 'inspect' ? `/v1/jobs/${id}` : `/v1/job-occurrences/${id}`),
          null,
          2,
        ),
      );
      return true;
    }
    if (id && ['create', 'run', 'cancel'].includes(verb)) {
      const expected = Number(option('--revision'));
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new Error('Supply the reviewed --revision');
      const target = await call<{ session_id: string }>(
        socket,
        verb === 'create' ? `/v1/tasks/${id}` : `/v1/jobs/${id}`,
      );
      const client_id = randomUUID(),
        lease = await acquireControl(
          socket,
          target.session_id,
          client_id,
          args.includes('--takeover'),
        );
      try {
        const body = {
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: expected,
          client_id,
          token: lease.token,
          ...(verb === 'create'
            ? {
                task_id: id,
                name: option('--name'),
                max_steps: Number(option('--max-steps')),
                compact: args.includes('--compact'),
              }
            : verb === 'run'
              ? { occurrence_key: option('--key') }
              : {}),
        };
        console.log(
          JSON.stringify(
            await call(socket, verb === 'create' ? '/v1/jobs' : `/v1/jobs/${id}/${verb}`, body),
            null,
            2,
          ),
        );
      } finally {
        await call(socket, `/v1/sessions/${target.session_id}/control`, {
          request_id: randomUUID(),
          action: 'release',
          client_id,
          token: lease.token,
          expected_epoch: lease.epoch,
        }).catch(() => {});
      }
      return true;
    }
  }
  return false;
}
/** salaam tasks: durable plans, verification and checkpoints. */
export async function tasksCommand(ctx: CliContext): Promise<boolean> {
  const { args, option, socket, group, verb, id } = ctx;
  if (group === 'tasks' && verb && id) {
    if (['inspect', 'history', 'current', 'checkpoints', 'restores'].includes(verb)) {
      const path =
        verb === 'current'
          ? `/v1/tasks?session_id=${encodeURIComponent(id)}`
          : `/v1/tasks/${id}${verb === 'history' ? '/history?offset=' + encodeURIComponent(option('--offset') ?? '0') : ['checkpoints', 'restores'].includes(verb) ? '/' + verb : ''}`;
      console.log(JSON.stringify(await call(socket, path), null, 2));
      return true;
    }
    if (
      [
        'create',
        'revise',
        'run',
        'complete',
        'verify',
        'finish',
        'checkpoint',
        'restore',
        'auto',
        'pause',
        'cancel',
      ].includes(verb)
    ) {
      const expected = Number(option('--revision'));
      if (!Number.isSafeInteger(expected) || expected < 0)
        throw new Error('Supply the reviewed --revision');
      const task =
        verb === 'create'
          ? undefined
          : await call<{ session_id: string }>(socket, `/v1/tasks/${id}`);
      const session = task?.session_id ?? id;
      const client_id = randomUUID();
      const lease = await acquireControl(socket, session, client_id, args.includes('--takeover'));
      try {
        const body: Record<string, unknown> = {
          request_id: option('--request-id') ?? randomUUID(),
          expected_revision: expected,
          client_id,
          token: lease.token,
        };
        let path = '/v1/tasks';
        if (verb === 'create' || verb === 'revise') {
          const file = option('--plan');
          if (!file)
            throw new Error('Supply --plan FILE containing objective, constraints and steps');
          body.plan = JSON.parse(readFileSync(resolve(file), 'utf8'));
          if (verb === 'create') body.session_id = id;
          else path += `/${id}/revise`;
        } else if (
          ['verify', 'finish', 'checkpoint', 'restore', 'auto', 'pause', 'cancel'].includes(verb)
        ) {
          path += `/${id}/${verb === 'pause' ? 'auto' : verb}`;
          if (verb === 'verify') {
            body.check_key = option('--check');
            body.step_id = option('--step') ?? null;
          }
          if (verb === 'finish') {
            const reason = option('--exception-reason'),
              evidence = option('--evidence-artifact');
            if (reason || evidence) {
              if (!reason || !evidence)
                throw new Error('Supply both --exception-reason and --evidence-artifact');
              body.exception = { reason, evidence_artifact: evidence };
            }
          }
          if (verb === 'restore') {
            body.checkpoint_id = option('--checkpoint');
            body.workspace_revision = Number(option('--workspace-revision'));
            body.workspace_digest = option('--workspace-digest');
          }
          if (verb === 'auto' || verb === 'pause') {
            body.max_steps = verb === 'pause' ? 0 : Number(option('--max-steps'));
            body.compact = args.includes('--compact');
          }
        } else {
          const step = option('--step');
          if (!step) throw new Error('Supply the reviewed --step ID');
          path += `/${id}/steps/${step}/${verb}`;
          if (verb === 'complete') {
            body.review = option('--review');
            if (!body.review)
              throw new Error('Supply --review TEXT recording the operator decision');
          } else {
            body.instruction = option('--text') ?? null;
            body.continues_attempt_id = option('--continue-attempt') ?? null;
          }
        }
        console.log(JSON.stringify(await call(socket, path, body), null, 2));
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
  }
  return false;
}
