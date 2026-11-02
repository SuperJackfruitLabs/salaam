import { randomUUID } from 'node:crypto';
import { call } from '../../core/index.js';
import { TextModal } from '../modals.js';
import { shortId } from '../theme.js';
import type { PanelContext } from './context.js';

// Ctrl+K → Task actions and Job actions: the durable task's saved plan, steps, checks,
// bounded progression and checkpoints, and the one-shot job bound to it.

/** The task's actions, or a form for a new plan when there is none. With `progressionOnly`, only
 * the actions that choose how the task progresses. */
export function taskActions(ctx: PanelContext, progressionOnly = false): void {
  const task = ctx.client.snapshot?.work_task;
  if (!task) {
    const initial = JSON.stringify({
      objective: 'Describe the task',
      constraints: [],
      steps: [
        {
          key: 'work',
          title: 'Implement and inspect',
          instruction: 'Describe the task',
          depends_on: [],
          checks: ['tests'],
        },
      ],
      acceptance: [{ key: 'tests', command: 'node --test', cwd: '.' }],
      deliverables: [],
    });
    ctx.taskInput(
      'Create task · plan JSON',
      initial,
      'Paste the objective, steps, checks and deliverables',
      'Creates a saved plan. No work starts until explicitly requested.',
      (value) =>
        void ctx.execute(async () => {
          const plan = JSON.parse(value);
          ctx.confirm(
            'Create this task',
            String(plan.objective).slice(0, 256) +
              '\n' +
              (Array.isArray(plan.steps) ? plan.steps.length : 0) +
              ' saved steps. No work starts yet.\nReview the full plan in Context after creation.',
            'Create task',
            () => ctx.client.taskAction('create', { plan }),
          );
        }),
    );
    return;
  }
  const reviewed = { id: task.id, revision: task.revision };
  const items = [
    {
      value: 'inspect',
      label: 'Inspect task and verification',
      description: task.state + ' · revision ' + task.revision,
    },
    {
      value: 'plan',
      label: 'Revise task plan',
      description: 'Preserve history; attempted steps remain immutable',
    },
    {
      value: 'run',
      label: 'Start or continue one step',
      description: 'Explicit instruction · same durable task',
    },
    {
      value: 'review',
      label: 'Record operator step review',
      description: 'A review is separate from verified success',
    },
    {
      value: 'verify',
      label: 'Run an acceptance check',
      description: 'Actual isolated command outcome and workspace digest',
    },
    {
      value: 'finish',
      label: 'Verify task completion',
      description: 'Requires fresh checks and deliverables',
    },
    {
      value: 'auto',
      label: 'Run bounded task',
      description: 'Explicit step limit · checked steps · idle compaction',
    },
    {
      value: 'pause',
      label: 'Pause task progression',
      description: 'Current work may settle; no later steps start',
    },
    {
      value: 'checkpoint',
      label: 'Create task checkpoint',
      description: 'Capture the owned workspace at an idle boundary',
    },
    {
      value: 'restore',
      label: 'Restore task checkpoint',
      description: 'Preserve human edits and report conflicts',
    },
    {
      value: 'cancel',
      label: 'Cancel task',
      description: 'Stop work; uncertain external effects remain recorded',
    },
  ];
  ctx.choice(
    progressionOnly ? 'Bounded progression · permissions unchanged' : 'Salaam · task',
    progressionOnly
      ? items.filter((i) => ['inspect', 'plan', 'auto', 'pause'].includes(i.value))
      : items,
    (action) => {
      if (action === 'inspect')
        ctx.showModal(
          new TextModal(
            'Task · ' + task.id,
            JSON.stringify(task, null, 2),
            ctx.view.theme,
            () => ctx.view.rows() - 8,
            () => ctx.tui.requestRender(),
            () => ctx.closeModal(),
          ),
        );
      else if (action === 'plan')
        ctx.taskInput(
          'Revise task · plan JSON',
          JSON.stringify({
            objective: task.objective,
            constraints: task.constraints,
            steps: task.steps.map(({ key, title, instruction, depends_on, checks }) => ({
              key,
              title,
              instruction,
              depends_on,
              checks,
            })),
            acceptance: task.acceptance,
            deliverables: task.deliverables,
            limits: task.limits,
          }),
          'Review the complete revised plan',
          'Revising pauses progression and requires fresh verification.',
          (value) =>
            void ctx.execute(() =>
              ctx.client.taskAction('revise', { plan: JSON.parse(value) }, reviewed),
            ),
        );
      else if (action === 'run') {
        const eligible = task.steps.filter((s) =>
          ['pending', 'failed', 'cancelled', 'interrupted'].includes(s.state),
        );
        if (!eligible.length) {
          ctx.client.report('No step is eligible for an explicit run.');
          return;
        }
        ctx.choice(
          'Choose a saved step',
          eligible.map((s) => ({
            value: s.id,
            label: s.title,
            description: s.key + ' · ' + s.state,
          })),
          (id) => {
            const step = eligible.find((s) => s.id === id)!;
            ctx.taskInput(
              'Step instruction',
              step.state === 'interrupted' ? '' : step.instruction,
              'Review or enter the instruction',
              step.state === 'interrupted'
                ? 'Inspect the interrupted outcome first; this creates a new attempt.'
                : 'Dependencies and task limits are checked by the service.',
              (instruction) =>
                void ctx.execute(() =>
                  ctx.client.taskAction(
                    `steps/${id}/run`,
                    {
                      instruction,
                      ...(step.state === 'interrupted'
                        ? { continues_attempt_id: step.attempt_id }
                        : {}),
                    },
                    reviewed,
                  ),
                ),
            );
          },
        );
      } else if (action === 'review') {
        const steps = task.steps.filter((s) => s.state === 'awaiting_review');
        if (!steps.length) {
          ctx.client.report('No step awaits operator review.');
          return;
        }
        ctx.choice(
          'Review a settled step',
          steps.map((s) => ({ value: s.id, label: s.title, description: s.attempt_id ?? '' })),
          (id) =>
            ctx.taskInput(
              'Record operator review',
              '',
              'What did you inspect?',
              'This records your decision; fresh command receipts are still required for task success.',
              (review) =>
                void ctx.execute(() =>
                  ctx.client.taskAction(`steps/${id}/complete`, { review }, reviewed),
                ),
            ),
        );
      } else if (action === 'verify') {
        if (!task.acceptance.length) {
          ctx.client.report('Configure acceptance checks in the task plan first.');
          return;
        }
        ctx.choice(
          'Choose acceptance check',
          task.acceptance.map((c) => ({ value: c.key, label: c.key, description: c.command })),
          (key) =>
            void ctx.execute(() => ctx.client.taskAction('verify', { check_key: key }, reviewed)),
        );
      } else if (action === 'finish')
        ctx.confirm(
          'Verify task completion',
          'The service will recheck every configured command receipt and deliverable against the current workspace.',
          'Verify completion',
          () => ctx.client.taskAction('finish', {}, reviewed),
        );
      else if (action === 'auto')
        ctx.taskInput(
          'Bounded progression',
          String(task.steps.filter((s) => s.state === 'pending').length),
          'Maximum new steps (1–32)',
          'Steps advance only after their configured checks pass. Human approvals remain separate.',
          (value) => {
            const max_steps = Number(value);
            ctx.confirm(
              'Run this bounded plan',
              `Task ${shortId(task.id)} · plan revision ${task.plan_revision}\nAt most ${max_steps} new steps; each step needs fresh passing checks.\nLimits: ${task.limits.requests} requests · ${task.limits.runtime_ms} ms · ${task.limits.concurrency} concurrent executions.\n${task.limits.token_units === null ? 'Token budget disabled' : task.limits.token_units + ' declared token units'} · ${task.limits.verification_runs} verification runs.\nChecks: ${task.acceptance.map((c) => c.key).join(', ') || 'none'} · Deliverables: ${task.deliverables.length}.\nDeterministic compaction at idle boundaries. Human approvals remain separate.`,
              'Run bounded task',
              () => ctx.client.taskAction('auto', { max_steps, compact: true }, reviewed),
            );
          },
        );
      else if (action === 'pause')
        void ctx.execute(() =>
          ctx.client.taskAction('auto', { max_steps: 0, compact: false }, reviewed),
        );
      else if (action === 'checkpoint')
        void ctx.execute(() => ctx.client.taskAction('checkpoint', {}, reviewed));
      else if (action === 'restore')
        void ctx.execute(async () => {
          const checkpoints = await call<{ id: string; revision: number; digest: string }[]>(
            ctx.client.socket,
            `/v1/tasks/${task.id}/checkpoints`,
          );
          if (!checkpoints.length) {
            ctx.client.report('No checkpoints have been saved.');
            return;
          }
          ctx.choice(
            'Choose checkpoint',
            checkpoints.map((c) => ({
              value: c.id,
              label: 'Workspace revision ' + c.revision,
              description: c.digest,
            })),
            (checkpoint_id) => {
              const w = ctx.client.workspace;
              if (!w?.observed_digest) {
                ctx.client.report('Refresh the owned workspace before restoring.');
                return;
              }
              ctx.confirm(
                'Restore reviewed task changes',
                JSON.stringify(
                  {
                    checkpoint_id,
                    current_revision: w.revision,
                    current_digest: w.observed_digest,
                    human_edits: 'Preserved; conflicts are reported',
                    external_effects: 'Not rolled back',
                  },
                  null,
                  2,
                ),
                'Restore checkpoint',
                () =>
                  ctx.client.taskAction(
                    'restore',
                    {
                      checkpoint_id,
                      workspace_revision: w.revision,
                      workspace_digest: w.observed_digest,
                    },
                    reviewed,
                  ),
              );
            },
          );
        });
      else if (action === 'cancel')
        ctx.confirm(
          'Cancel this task',
          'Current work is cancelled and later steps stop. Inspect any uncertain effects separately.',
          'Cancel task',
          () => ctx.client.taskAction('cancel', {}, reviewed),
        );
    },
  );
}
export function jobActions(ctx: PanelContext): void {
  const snapshot = ctx.client.snapshot,
    job = snapshot?.job,
    task = snapshot?.work_task;
  if (!snapshot || !task) {
    ctx.client.report('Create a checked task first.');
    return;
  }
  if (!job) {
    ctx.taskInput(
      'Create one-shot job · JSON',
      JSON.stringify({
        name: task.objective.slice(0, 100),
        max_steps: task.steps.length,
        compact: false,
      }),
      'Bind this task and its reviewed execution scope',
      'Creates an immutable definition. It stays idle until explicitly triggered.',
      (value) =>
        void ctx.execute(() =>
          ctx.client.jobAction('create', JSON.parse(value), {
            id: task.id,
            revision: task.revision,
          }),
        ),
    );
    return;
  }
  const reviewed = { id: job.id, revision: job.revision };
  ctx.choice(
    'Salaam · one-shot job',
    [
      {
        value: 'inspect',
        label: 'Inspect job binding',
        description: job.state + ' · ' + job.name,
      },
      {
        value: 'run',
        label: 'Trigger one-shot job',
        description: 'Stable logical key · same occurrence on retry',
      },
      {
        value: 'cancel',
        label: 'Cancel job',
        description: 'Revoke future grants and cancel active owned work',
      },
    ],
    (action) => {
      if (action === 'inspect')
        ctx.showModal(
          new TextModal(
            'Job · ' + job.id,
            JSON.stringify(job, null, 2),
            ctx.view.theme,
            () => ctx.view.rows() - 8,
            () => ctx.tui.requestRender(),
            () => ctx.closeModal(),
          ),
        );
      else if (action === 'run')
        ctx.taskInput(
          'One-shot occurrence key',
          job.occurrence?.occurrence_key ?? randomUUID(),
          'Use one stable key for this intentional run',
          'Binding ' +
            job.binding_digest.slice(0, 16) +
            ' · at most ' +
            job.max_steps +
            ' new steps. Existing task budgets and approvals apply.',
          (key) =>
            void ctx.execute(() => ctx.client.jobAction('run', { occurrence_key: key }, reviewed)),
        );
      else
        ctx.confirm(
          'Cancel one-shot job',
          'Cancels active owned work. Unknown external outcomes still require inspection.',
          'Cancel job',
          () => ctx.client.jobAction('cancel', {}, reviewed),
        );
    },
  );
}
