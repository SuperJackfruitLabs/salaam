import type { Approval, Operation } from '../../core/index.js';
import type { ApprovalRule, StoredRule } from '../../local/index.js';
import { ApprovalModal, approvalReason, onceOnlyReason } from '../modals.js';
import { safeText, shortId } from '../theme.js';
import type { PanelContext } from './context.js';

// Ctrl+O and /approvals: review the exact request waiting, then decide it; and the approval rules
// a desk session keeps (/permissions → Approval rules).

/** Review the one approval waiting, or choose among several. */
export function approvals(ctx: PanelContext): void {
  const waiting = ctx.client.snapshot?.approvals.filter((a) => a.state === 'pending') ?? [];
  if (!waiting.length) {
    ctx.client.report('No approvals are waiting.');
    return;
  }
  const open = (id: string) =>
    void ctx.execute(async () => {
      const approval = waiting.find((a) => a.id === id)!;
      const reviewed = await ctx.client.review(approval);
      // Desk sessions can approve for the session or always; strict work only ever approves once.
      const rules = await ctx.client.approvalRules().catch(() => ({ applies: false }));
      const onceOnly = rules.applies ? onceOnlyReason(reviewed.operation.value) : undefined;
      showApproval(
        ctx,
        reviewed.approval,
        reviewed.operation,
        rules.applies && !onceOnly,
        onceOnly,
        rules.applies,
      );
    });
  if (waiting.length === 1) open(waiting[0]!.id);
  else
    ctx.choice(
      'Approvals waiting',
      waiting.map((approval) => ({
        value: approval.id,
        label:
          ctx.client.snapshot?.operations.find((op) => op.id === approval.operation_id)?.target ??
          shortId(approval.id),
        description: shortId(approval.id) + ' · revision ' + approval.revision,
      })),
      open,
    );
}
/** /permissions → Approval rules: list them, remove one, or add one in plain words. */
export async function approvalRules(ctx: PanelContext): Promise<void> {
  const { applies, rules, problems } = await ctx.client.approvalRules();
  if (!applies) {
    ctx.client.report('Approval rules apply only to desk coding sessions.');
    return;
  }
  const describe = (r: StoredRule) =>
    `${r.effect} ${r.tool} ${r.command ?? (r.paths ?? []).join(', ')}`.trim();
  ctx.choice(
    'Approval rules · deny beats ask beats allow · unmatched requests ask',
    [
      {
        value: 'add',
        label: 'Add a rule',
        description: 'e.g. allow command npm test *  ·  deny edit src/secrets/**',
      },
      ...rules.map((r) => ({
        value: 'rule:' + r.id,
        label: describe(r),
        description:
          r.source === 'user'
            ? 'From your permissions.json; edit that file to change it'
            : r.source === 'repo'
              ? 'Always, in this repo · choose to remove'
              : 'This session · choose to remove',
      })),
      ...problems.map((p, i) => ({ value: 'problem:' + i, label: 'Problem', description: p })),
    ],
    (value) => {
      if (value === 'add') {
        ctx.taskInput(
          'New approval rule',
          '',
          'effect tool words-or-paths',
          'allow|ask|deny, then command or edit, then command words (a final * takes any further words) or comma-separated path globs. Example: allow command git status',
          (text) => {
            const [effect, tool, ...rest] = text.trim().split(/\s+/);
            const target = rest.join(' ');
            const rule =
              tool === 'edit'
                ? {
                    effect,
                    tool,
                    paths: target
                      .split(',')
                      .map((p) => p.trim())
                      .filter(Boolean),
                  }
                : { effect, tool, command: target };
            ctx.choice(
              'Keep this rule for…',
              [
                {
                  value: 'session',
                  label: 'This session',
                  description: 'Gone when the session ends',
                },
                {
                  value: 'repo',
                  label: 'This repo',
                  description: "Every desk session here; kept in Salaam's state",
                },
              ],
              (scope) =>
                void ctx.execute(() =>
                  ctx.client.addRule(scope as 'session' | 'repo', rule as ApprovalRule),
                ),
            );
          },
        );
        return;
      }
      if (!value.startsWith('rule:')) return;
      const rule = rules.find((r) => 'rule:' + r.id === value)!;
      if (rule.source === 'user') {
        ctx.client.report(
          'This rule comes from your permissions.json; edit that file to change it.',
        );
        return;
      }
      ctx.confirm('Remove this rule?', describe(rule), 'remove', () =>
        ctx.client.removeRule(rule.id),
      );
    },
  );
}
export function showApproval(
  ctx: PanelContext,
  approval: Approval,
  operation: Operation,
  offerRules = false,
  onceOnly?: string,
  desk = false,
): void {
  ctx.showModal(
    new ApprovalModal(
      approval,
      operation,
      ctx.view.theme,
      () => ctx.terminal.rows,
      () => ctx.client.snapshot?.approvals.find((a) => a.id === approval.id),
      () => ctx.tui.requestRender(),
      () => ctx.closeModal(),
      (decision) => {
        ctx.closeModal();
        if (decision === 'approve' || decision === 'deny') {
          void ctx.execute(() => ctx.client.decide(approval, decision));
          return;
        }
        if (decision === 'deny-feedback') {
          // Deny, then tell the agent why in its own turn, the way steering reaches it.
          ctx.taskInput(
            'Deny and tell it why',
            '',
            'Why not, or what to do instead',
            'One line. The request is denied and this reaches the agent as feedback.',
            (why) =>
              void ctx.execute(async () => {
                await ctx.client.decide(approval, 'deny');
                const text = why.trim();
                if (!text) return;
                // The turn has usually moved on by now; if it ended, put the reason in the
                // composer instead of losing it.
                const feedback = `I denied that request (${safeText(operation.target)}). ${text}`;
                try {
                  await ctx.client.steer(feedback);
                } catch {
                  ctx.editor.setText(feedback);
                  ctx.client.report(
                    'Denied. The turn had ended, so your reason is in the composer; press enter to send it.',
                  );
                }
              }),
          );
          return;
        }
        // The rule is the exact request just reviewed: its command words or its edited paths.
        // If it cannot become a rule (shell features, odd words), nothing is approved; say why.
        const approveWith = (scope: 'session' | 'repo') => async () => {
          // While the approval is pending the status line shows it, not a notice, so a
          // refused rule is shown where it cannot be missed.
          try {
            await ctx.client.ruleFromOperation(operation.id, scope);
          } catch (error) {
            ctx.showText(
              'Not saved as a rule',
              `${error instanceof Error ? error.message : String(error)}\n\nNothing was approved. Press ctrl+o to approve it once instead.`,
            );
            return;
          }
          await ctx.client.decide(approval, 'approve');
          ctx.client.report(
            scope === 'session'
              ? 'Approved, and the same request will be approved for the rest of this session.'
              : 'Approved, and the same request will always be approved in this repo. Remove it in /permissions.',
          );
        };
        if (decision === 'approve-session') void ctx.execute(approveWith('session'));
        else
          ctx.confirm(
            'Always allow in this repo?',
            `${safeText(operation.target)}

This exact request will be approved without asking in every desk session on this repository, until you remove it in /permissions. It is kept in Salaam's state, not in the repository.`,
            'always allow',
            approveWith('repo'),
          );
      },
      offerRules,
      onceOnly,
      { desk, reason: approvalReason(operation.value, ctx.view.mode?.mode) },
    ),
    86,
  );
}
