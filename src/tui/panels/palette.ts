import { commandTerminal, SLASH_COMMANDS } from '../../core/index.js';
import type { CommandContext } from '../commands/types.js';
import { FormModal } from '../modals.js';
import { shortId } from '../theme.js';
import type { ViewTab } from '../view.js';
import { approvals } from './approvals.js';
import { evidence, history, tools } from './history.js';
import { inbox, schedules } from './schedules.js';
import { jobActions, taskActions } from './tasks.js';

// Ctrl+K (or F2): every slash command and every other action, in one filterable list.

/** What the actions list needs beyond what a slash command does. */
export interface PaletteContext extends CommandContext {
  refresh(): Promise<void>;
  /** Edit the composer's text in VISUAL or EDITOR. */
  editPrompt(): Promise<void>;
  /** Show a command's captured output in the Commands tab. */
  openLog(id: string): void;
}

export function palette(ctx: PaletteContext): void {
  const snapshot = ctx.client.snapshot;
  const items = [
    ...SLASH_COMMANDS.filter((c) => c.kind !== 'unavailable').map((c) => ({
      value: 'slash:' + c.name,
      label: '/' + c.name,
      description: c.description,
    })),
    {
      value: 'schedules',
      label: 'Recurring jobs and schedules',
      description: 'Immutable templates · fresh bounded occurrences',
    },
    {
      value: 'inbox',
      label: 'Operator inbox',
      description: 'Shared durable attention and results',
    },
    {
      value: 'model',
      label: 'Choose model and provider',
      description: '/model · switches this session',
    },
    { value: 'help', label: 'Slash commands', description: '/help' },
    { value: 'new', label: 'New session', description: 'ctrl+n' },
    {
      value: 'coding',
      label: 'New local coding session',
      description: '/coding · reviewed edits and local commands',
    },
    { value: 'sessions', label: 'Switch session', description: 'ctrl+p' },
    { value: 'conversation', label: 'Conversation', description: 'Messages and live progress' },
    {
      value: 'task',
      label: 'Task actions',
      description: 'Saved plan, verification, bounded progression and checkpoints',
    },
    {
      value: 'jobs',
      label: 'Job actions',
      description: 'Bound one-shot admission and durable occurrence recovery',
    },
    { value: 'changes', label: 'Review changes', description: 'alt+g · guarded workspace diff' },
    { value: 'commands', label: 'Commands and output', description: 'ctrl+t' },
    {
      value: 'transcript',
      label: 'Full transcript',
      description: 'ctrl+x · every tool call and its output',
    },
    {
      value: 'context',
      label: 'Session context',
      description: 'Identity, task facts, child results and usage',
    },
    {
      value: 'history',
      label: 'Browse full history',
      description: 'Older entries, including before compaction',
    },
    {
      value: 'artifact',
      label: 'Read artifact',
      description: 'Read saved evidence without acknowledging it',
    },
    {
      value: 'tool',
      label: 'Inspect tool activity',
      description: 'Review captured input and outcome',
    },
    {
      value: 'approvals',
      label: 'Review approvals',
      description: 'ctrl+o · exact bound decisions',
    },
    { value: 'control', label: 'Take control', description: 'Keep the same session and work' },
    {
      value: 'resume',
      label: 'Resume worker',
      description: 'Restore the same conversation; interrupted instructions stay explicit',
    },
    {
      value: 'continue',
      label: 'Continue interrupted work',
      description: 'Enter a new instruction for the saved interruption',
    },
    {
      value: 'logs',
      label: 'Command logs',
      description: 'Inspect captured output and exit status',
    },
    {
      value: 'cancel-command',
      label: 'Cancel a command',
      description: 'Remove its isolated process tree',
    },
    {
      value: 'cancel',
      label: 'Cancel current work',
      description: 'Explicitly cancel a running instruction',
    },
    { value: 'refresh', label: 'Refresh connection', description: 'f5' },
    {
      value: 'editor',
      label: 'Edit prompt externally',
      description: 'ctrl+g · VISUAL or EDITOR',
    },
    {
      value: 'theme',
      label:
        ctx.view.theme.name === 'night' ? 'Theme · switch to Paper' : 'Theme · switch to Night',
      description: 'Salaam’s two native terminal palettes',
    },
    {
      value: 'rail',
      label: 'Toggle workspace rail',
      description: 'ctrl+b · shown on wide terminals',
    },
    { value: 'help', label: 'Keyboard help', description: 'F1' },
    { value: 'stop', label: 'Stop service', description: 'Separate from detach and cancel' },
  ];
  ctx.choice('Salaam · actions', items, (value) => {
    if (value.startsWith('slash:')) {
      const name = value.slice(6);
      const definition = SLASH_COMMANDS.find((c) => c.name === name)!;
      if (definition.arguments?.startsWith('<')) {
        ctx.editor.setText('/' + name + ' ');
        ctx.tui.setFocus(ctx.editor);
      } else void ctx.execute(() => ctx.runSlashCommand(name));
      return;
    }
    if (['conversation', 'changes', 'commands', 'context'].includes(value)) {
      ctx.setTab(value as ViewTab);
      return;
    }
    if (value === 'model') ctx.modelPicker();
    else if (value === 'help') void ctx.execute(() => ctx.runSlashCommand('help'));
    else if (value === 'coding') void ctx.execute(() => ctx.newSession(true));
    else if (value === 'new') void ctx.execute(() => ctx.newSession());
    else if (value === 'task') taskActions(ctx);
    else if (value === 'jobs') jobActions(ctx);
    else if (value === 'schedules') void ctx.execute(() => schedules(ctx));
    else if (value === 'inbox') void ctx.execute(() => inbox(ctx));
    else if (value === 'sessions') void ctx.execute(() => ctx.sessions());
    else if (value === 'approvals') approvals(ctx);
    else if (value === 'history') void ctx.execute(() => history(ctx));
    else if (value === 'artifact')
      ctx.showModal(
        new FormModal(
          'Read artifact · paste its ID',
          '',
          ctx.view.theme,
          false,
          () => ctx.tui.requestRender(),
          () => ctx.closeModal(),
          (id) => {
            ctx.closeModal();
            void ctx.execute(() => evidence(ctx, 'artifact_id', id));
          },
        ),
      );
    else if (value === 'tool') tools(ctx);
    else if (value === 'control')
      ctx.confirm(
        'Take control',
        'Another operator may be controlling this session. Taking control preserves its running work and changes who may send instructions.',
        'Take control',
        () => ctx.client.takeControl(),
      );
    else if (value === 'resume') void ctx.execute(() => ctx.client.resume());
    else if (value === 'continue') {
      const interrupted = snapshot?.attempts.find(
        (a) => a.state === 'interrupted' && !a.resolved_by,
      );
      if (!interrupted) ctx.client.report('No unresolved interruption in this session.');
      else {
        ctx.view.continuation = interrupted.id;
        ctx.client.notice = 'Enter a new instruction to continue the interrupted attempt.';
        ctx.view.tab = 'conversation';
        ctx.tui.setFocus(ctx.editor);
        ctx.tui.requestRender();
      }
    } else if (value === 'logs') commandPicker(ctx, false);
    else if (value === 'cancel-command') commandPicker(ctx, true);
    else if (value === 'cancel') {
      const attempt = snapshot?.attempts.find((a) =>
        ['accepted', 'dispatching', 'running'].includes(a.state),
      );
      if (!attempt) ctx.client.report('No active instruction to cancel.');
      else
        ctx.confirm(
          'Cancel current work',
          'Cancel attempt ' + attempt.id + '? Detaching would leave it running.',
          'Cancel work',
          () => ctx.client.cancel(attempt.id),
        );
    } else if (value === 'refresh') void ctx.execute(() => ctx.refresh());
    else if (value === 'editor') void ctx.execute(() => ctx.editPrompt());
    else if (value === 'theme') ctx.toggleTheme();
    else if (value === 'rail') ctx.toggleRail();
    else if (value === 'stop')
      ctx.confirm(
        'Stop Salaam service',
        'This interrupts model work in every session using this service. Running commands may require reconciliation after restart. Closing this terminal would simply detach.',
        'Stop service',
        async () => {
          await ctx.client.shutdown();
          ctx.finish();
        },
      );
  });
}
/** Command logs, or Cancel a command: choose one of this session's commands. */
export function commandPicker(ctx: PaletteContext, cancel: boolean): void {
  const commands = ctx.client.commands.filter((run) => !cancel || !commandTerminal(run.state));
  if (!commands.length) {
    ctx.client.report(cancel ? 'No active commands to cancel.' : 'No command output yet.');
    return;
  }
  ctx.choice(
    cancel ? 'Cancel a command' : 'Command output',
    commands.map((run) => ({
      value: run.id,
      label: run.command,
      description: run.state + ' · ' + shortId(run.id) + ' · revision ' + run.workspace_revision,
    })),
    (id) => {
      if (cancel)
        ctx.confirm(
          'Cancel command',
          'Cancel command ' + id + ' and its owned descendants?',
          'Cancel command',
          () => ctx.client.cancelCommand(id),
        );
      else {
        ctx.openLog(id);
      }
    },
  );
}
