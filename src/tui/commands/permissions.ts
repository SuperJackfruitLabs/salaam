import { approvals } from '../panels/approvals.js';
import { cycleMode, fullAccess, permissionControls, yolo } from '../panels/permissions.js';
import { schedules } from '../panels/schedules.js';
import { taskActions } from '../panels/tasks.js';
import type { SlashCommand } from './types.js';

// What the session may do on its own, and how its task progresses. The two stay separate.

const mode: SlashCommand = {
  names: ['mode'],
  session: true,
  async run(ctx) {
    await cycleMode(ctx);
  },
};

const fullAccessCommand: SlashCommand = {
  names: ['full-access'],
  session: true,
  async run(ctx) {
    await fullAccess(ctx);
  },
};

const yoloCommand: SlashCommand = {
  names: ['yolo'],
  session: true,
  async run(ctx) {
    await yolo(ctx);
  },
};

const permissions: SlashCommand = {
  names: ['permissions'],
  session: true,
  async run(ctx) {
    await permissionControls(ctx);
  },
};

const approvalsCommand: SlashCommand = {
  names: ['approvals'],
  session: true,
  run(ctx) {
    approvals(ctx);
  },
};

const tasks: SlashCommand = {
  names: ['tasks'],
  session: true,
  run(ctx) {
    taskActions(ctx);
  },
};

const progression: SlashCommand = {
  names: ['progression'],
  session: true,
  run(ctx) {
    ctx.choice(
      'Progression · does not change permissions',
      [
        {
          value: 'manual',
          label: 'Manual steps',
          description: 'Pause future task steps; current work can settle',
        },
        {
          value: 'bounded',
          label: 'Bounded automatic task',
          description: 'Checked task, step grant and budgets; permission gates still apply',
        },
        {
          value: 'scheduled',
          label: 'Scheduled tasks',
          description: 'Reviewed templates and fresh bounded occurrences',
        },
      ],
      (value) => {
        if (value === 'bounded') taskActions(ctx, true);
        else if (value === 'scheduled') void ctx.execute(() => schedules(ctx));
        else {
          const task = ctx.client.snapshot?.work_task;
          if (!task)
            ctx.client.report(
              'Manual instruction mode is active. No task is configured for automatic progression.',
            );
          else
            ctx.confirm(
              'Manual progression',
              'Stop admitting later task steps? Already-running work may settle. Permissions remain unchanged.',
              'Pause progression',
              () =>
                ctx.client.taskAction(
                  'auto',
                  { max_steps: 0, compact: false },
                  { id: task.id, revision: task.revision },
                ),
            );
        }
      },
    );
  },
};

export const PERMISSION_COMMANDS: readonly SlashCommand[] = [
  mode,
  fullAccessCommand,
  yoloCommand,
  permissions,
  approvalsCommand,
  tasks,
  progression,
];
