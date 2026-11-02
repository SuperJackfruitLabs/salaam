import { randomUUID } from 'node:crypto';
import { call, type InboxEntry } from '../../core/index.js';
import type { RecurringJob } from '../../tasks/index.js';
import { TextModal } from '../modals.js';
import type { PanelContext } from './context.js';

// Ctrl+K → Recurring jobs and Operator inbox: paged lists from the service, each entry with its
// own actions.

export async function schedules(ctx: PanelContext, offset = 0): Promise<void> {
  const page = await call<{
    jobs: (RecurringJob & { schedule: unknown })[];
    next_offset: number | null;
  }>(ctx.client.socket, '/v1/schedules?offset=' + offset);
  ctx.choice(
    'Salaam · recurring jobs',
    [
      {
        value: 'create',
        label: 'Capture a recurring template',
        description: 'Reviewed task and exact workspace snapshot',
      },
      ...page.jobs.map((j) => ({
        value: j.id,
        label: j.name,
        description: j.state + ' · ' + j.id,
      })),
      ...(page.next_offset !== null
        ? [{ value: 'next', label: 'Next page', description: 'More recurring definitions' }]
        : []),
    ],
    (id) => {
      if (id === 'next') {
        void ctx.execute(() => schedules(ctx, page.next_offset!));
        return;
      }
      const task = ctx.client.snapshot?.work_task;
      if (id === 'create') {
        if (!task) {
          ctx.client.report('Create a checked task first.');
          return;
        }
        ctx.taskInput(
          'Recurring template · JSON',
          JSON.stringify({
            name: task.objective.slice(0, 100),
            max_steps: task.steps.length,
            compact: false,
            schedule: null,
          }),
          'Capture an immutable template',
          'Every occurrence receives fresh IDs and a workspace copy. Use null schedule for explicit triggers.',
          (value) =>
            void ctx.execute(() =>
              ctx.client.scheduleAction('create', JSON.parse(value), {
                id: task.id,
                revision: task.revision,
              }),
            ),
        );
        return;
      }
      const job = page.jobs.find((j) => j.id === id)!;
      ctx.choice(
        'Recurring · ' + job.name,
        [
          {
            value: 'inspect',
            label: 'Inspect definition and occurrences',
            description: job.template_digest,
          },
          {
            value: 'run',
            label: 'Trigger an occurrence',
            description: 'Stable logical key · overlap prevented',
          },
          {
            value: 'update',
            label: 'Revise schedule or pause/cancel',
            description: 'Template remains immutable',
          },
        ],
        (action) => {
          if (action === 'inspect') {
            void ctx.execute(async () => {
              const detail = await call(ctx.client.socket, `/v1/schedules/${job.id}`);
              ctx.showModal(
                new TextModal(
                  'Recurring · ' + job.id,
                  JSON.stringify(detail, null, 2),
                  ctx.view.theme,
                  () => ctx.view.rows() - 8,
                  () => ctx.tui.requestRender(),
                  () => ctx.closeModal(),
                ),
              );
            });
            return;
          }
          if (job.session_id !== ctx.client.snapshot?.id) {
            ctx.client.report(
              'Switch to template session ' + job.session_id + ' to change its schedule.',
            );
            return;
          }
          ctx.taskInput(
            action === 'run' ? 'Occurrence key' : 'Schedule revision · JSON',
            action === 'run'
              ? randomUUID()
              : JSON.stringify({ state: job.state, schedule: job.schedule }),
            'Review this admission',
            'Revisions affect future slots. Cancel revokes active owned work; pausing preserves it.',
            (value) =>
              void ctx.execute(() =>
                ctx.client.scheduleAction(
                  action as 'run' | 'update',
                  action === 'run' ? { occurrence_key: value } : JSON.parse(value),
                  { id: job.id, revision: job.revision },
                ),
              ),
          );
        },
      );
    },
  );
}
export async function inbox(ctx: PanelContext, offset = 0): Promise<void> {
  const page = await call<{
    items: InboxEntry[];
    next_offset: number | null;
  }>(ctx.client.socket, '/v1/inbox?offset=' + offset);
  if (!page.items.length) {
    ctx.client.report('Operator inbox is clear.');
    return;
  }
  ctx.choice(
    'Salaam · operator inbox',
    [
      ...page.items.map((item) => ({
        value: item.id,
        label: item.kind + ' · ' + item.source_key,
        description: item.session_id + ' · r' + item.revision,
      })),
      ...(page.next_offset !== null
        ? [{ value: 'next', label: 'Next page', description: 'More saved attention' }]
        : []),
    ],
    (id) => {
      if (id === 'next') {
        void ctx.execute(() => inbox(ctx, page.next_offset!));
        return;
      }
      const item = page.items.find((i) => i.id === id)!;
      ctx.choice(
        'Attention · ' + item.kind,
        [
          {
            value: 'inspect',
            label: 'Inspect saved attention',
            description: 'Source ' + item.source_key,
          },
          {
            value: 'ack',
            label: 'Acknowledge this revision',
            description: 'No approval or retry is issued',
          },
        ],
        (action) => {
          if (action === 'inspect')
            ctx.showModal(
              new TextModal(
                'Inbox · ' + item.id,
                JSON.stringify(item, null, 2),
                ctx.view.theme,
                () => ctx.view.rows() - 8,
                () => ctx.tui.requestRender(),
                () => ctx.closeModal(),
              ),
            );
          else if (ctx.client.snapshot?.id !== item.session_id)
            ctx.client.report(
              'Switch to session ' + item.session_id + ' to acknowledge its attention.',
            );
          else
            ctx.confirm(
              'Acknowledge attention',
              'This clears only the saved attention revision. It does not decide an approval or retry work.',
              'Acknowledge',
              async () => {
                await ctx.client.ackInbox(item.id, item.revision);
              },
            );
        },
      );
    },
  );
}
