import { call } from '../../core/index.js';
import { TextModal } from '../modals.js';
import { rewind } from '../panels/changes.js';
import { shortId } from '../theme.js';
import { cancelChoices, queuedItems } from '../turn-keys.js';
import type { SlashCommand } from './types.js';

// The work in progress: cancel, steer or queue a turn; ask for a plan or a review; and look at,
// rewind or undo what the turns changed.

const cancel: SlashCommand = {
  names: ['cancel'],
  session: true,
  run(ctx, _args, _name, snapshot) {
    const active = cancelChoices(snapshot);
    if (!active.length) {
      ctx.client.report('No active or queued instruction to cancel.');
      return;
    }
    const confirmCancel = (id: string) =>
      ctx.confirm(
        'Cancel instruction',
        'Cancel attempt ' +
          shortId(id) +
          '? Your typed text is kept. /exit would leave it running.',
        'Cancel work',
        () => ctx.client.cancel(id),
        true,
      );
    if (active.length === 1) confirmCancel(active[0]!.id);
    else
      ctx.choice(
        'Cancel an instruction',
        active.map((a) => ({ value: a.id, label: a.label })),
        confirmCancel,
      );
  },
};

const steer: SlashCommand = {
  names: ['steer'],
  session: true,
  async run(ctx, args) {
    if (!args) throw new Error('Use /steer followed by guidance for the active turn.');
    await ctx.client.steer(args);
  },
};

const queue: SlashCommand = {
  names: ['queue'],
  session: true,
  async run(ctx, args, _name, snapshot) {
    if (args) {
      await ctx.client.submit(args);
      return;
    }
    const queued = queuedItems(snapshot);
    if (!queued.length) {
      ctx.client.report('Nothing is queued. Tab queues text for after the running turn.');
      return;
    }
    ctx.choice(
      'Queued instructions',
      queued.map((q) => ({ value: q.attempt, label: q.text.slice(0, 80) })),
      (attempt) => {
        const item = queued.find((q) => q.attempt === attempt)!;
        ctx.choice(
          'Queued instruction',
          [
            { value: 'edit', label: 'Edit', description: 'Move it back into the input' },
            { value: 'remove', label: 'Remove', description: 'Cancel it before it runs' },
          ],
          (choice) =>
            void ctx.execute(async () => {
              await ctx.client.cancel(item.attempt);
              if (choice === 'edit') ctx.editor.setText(item.text);
            }),
        );
      },
    );
  },
};

const PLAN =
  'Produce an implementation plan. Inspect relevant workspace files, explain assumptions, steps and validation. Do not edit files or run mutating commands. ';
const REVIEW =
  'Review the workspace changes. Inspect the actual code and report actionable bugs with file references and verification gaps. Do not edit files. ';

const ask: SlashCommand = {
  names: ['plan', 'review'],
  session: true,
  run(ctx, args, command) {
    const instruction = command === 'plan' ? PLAN : REVIEW;
    ctx.confirm(
      command === 'plan' ? 'Request a plan' : 'Request a review',
      'This submits a model instruction and uses provider credits. It does not change tool permissions; mutations still use existing approval controls.',
      'Submit instruction',
      () => ctx.client.submit(instruction + args).then(() => undefined),
    );
  },
};

const diffCommand: SlashCommand = {
  names: ['diff'],
  session: true,
  async run(ctx, _args, _name, snapshot) {
    // Coding sessions review their diff file by file in Changes (Phase 3a).
    if (snapshot.capabilities.includes('local-coding-reviewed')) ctx.setTab('changes');
    else if (snapshot.capabilities.includes('local-workspace-read')) {
      const diff = await call<{ text: string }>(
        ctx.client.socket,
        `/v1/sessions/${snapshot.id}/local-diff`,
      );
      ctx.showText('Local Git changes', diff.text);
    } else ctx.setTab('changes');
  },
};

const rewindTurn: SlashCommand = {
  names: ['rewind'],
  session: true,
  async run(ctx, args) {
    await rewind(ctx, args);
  },
};

const undo: SlashCommand = {
  names: ['undo'],
  session: true,
  async run(ctx, args) {
    if (args === 'reconcile') {
      await ctx.client.reconcileUndo();
      return;
    }
    if (args) throw new Error('Use /undo or /undo reconcile.');
    const review = await ctx.client.undoReview();
    ctx.showModal(
      new TextModal(
        'Undo local edit · review the inverse',
        review.edits
          .map(
            (e) =>
              '--- ' +
              e.path +
              '\n' +
              e.after +
              '\n+++ restored\n' +
              (e.before ?? '(remove new file)'),
          )
          .join('\n\n'),
        ctx.view.theme,
        () => ctx.terminal.rows,
        () => ctx.tui.requestRender(),
        () => ctx.closeModal(),
        undefined,
        () => {
          ctx.closeModal();
          void ctx.execute(() => ctx.client.undo(review));
        },
      ),
    );
  },
};

export const TURN_COMMANDS: readonly SlashCommand[] = [
  cancel,
  steer,
  queue,
  ask,
  diffCommand,
  rewindTurn,
  undo,
];
