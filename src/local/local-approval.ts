// Whether a just-prepared local edit or command is decided without asking: the session's approval
// rules first (a deny refuses, an allow approves with the rule recorded), then the session's mode,
// which approves only what it covers. Anything else stays pending for the person.
import { ServiceError } from '../core/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { Store } from '../store/index.js';
import {
  commandArgv,
  evaluateRules,
  type ApprovalRules,
  type RuleRequest,
} from './approval-rules.js';
import {
  type PermissionPolicy,
  autoApprovesCommands,
  autoApprovesEdits,
  permissionDigest,
  permissionPolicy,
} from './autonomy.js';
import type { LocalCall } from './command-launch.js';
import type { LocalArgs } from './command-request.js';
import type { DangerVerdict } from './command-danger.js';
import { verifyLocalEdits } from './edits.js';

/** What deciding needs from the desk controller. */
export interface ApprovalHost {
  readonly store: Store;
  readonly managed: ManagedWork;
  readonly rules?: ApprovalRules;
  guard(c: LocalCall): void;
  /** Would this command run inside the OS sandbox? */
  sandboxedUnder(args: LocalArgs & { action: 'command' }): boolean;
}

export function decideByPolicy(
  host: ApprovalHost,
  session: string,
  c: LocalCall,
  root: string,
  args: LocalArgs,
  danger: DangerVerdict,
  publishes: string | null,
  escalated: boolean,
): void {
  const policy = permissionPolicy(host.store, session);
  decideByRules(host, session, c, root, args, danger, publishes, escalated, policy);
  decideByMode(host, session, c, root, args, danger, publishes, escalated, policy);
}

/** Desk-session rules decide first. */
function decideByRules(
  host: ApprovalHost,
  session: string,
  c: LocalCall,
  root: string,
  args: LocalArgs,
  danger: DangerVerdict,
  publishes: string | null,
  escalated: boolean,
  policy: PermissionPolicy,
): void {
  // Desk-session rules: a matching deny refuses, a matching allow approves and is recorded with the
  // rule that decided it; anything else falls through to the scoped-edit policy and then asks.
  if (host.rules && policy.mode !== 'inspect' && host.rules.applies(session)) {
    const request: RuleRequest =
      args.action === 'command'
        ? { tool: 'command', argv: commandArgv(args.command) }
        : { tool: 'edit', paths: args.edits.map((e) => e.path) };
    // A repo's allow rules cannot approve a dangerous or publishing command: only the person's own
    // rules can.
    const usable = (all: ReturnType<ApprovalRules['list']>) =>
      danger.dangerous ||
      publishes ||
      (args.action === 'command' && (args.listen || args.outside_sandbox))
        ? all.filter((r) => !(r.source === 'repo' && r.effect === 'allow'))
        : all;
    const decided = evaluateRules(usable(host.rules.list(session)), request);
    const approval = host.managed.forOperation(c.operation_id);
    const rule = decided.rule && {
      id: decided.rule.id,
      source: decided.rule.source,
      effect: decided.rule.effect,
      tool: decided.rule.tool,
      ...(decided.rule.command ? { command: decided.rule.command } : {}),
      ...(decided.rule.paths ? { paths: decided.rule.paths } : {}),
    };
    if (decided.effect === 'deny' && rule) {
      host.managed.decide(
        approval.id,
        'rule-deny:' + c.id,
        approval.revision,
        approval.operation_digest,
        'deny',
      );
      host.store.transaction(() =>
        host.store.event(session, 'permission.rule-denied', {
          rule,
          call_id: c.id,
          operation_id: c.operation_id,
        }),
      );
    } else if (decided.effect === 'allow' && rule) {
      const rules = host.rules;
      host.managed.decide(
        approval.id,
        'rule:' + c.id,
        approval.revision,
        approval.operation_digest,
        'approve',
        {
          receipt: {
            policy_digest: permissionDigest(policy),
            policy_revision: policy.revision,
            rule,
            root,
            call_id: c.id,
          },
          decidedBy: 'rule:' + rule.source,
          authorize: () => {
            host.guard(c);
            const again = evaluateRules(usable(rules.list(session)), request);
            if (again.effect !== 'allow' || again.rule?.id !== rule.id)
              throw new ServiceError('permission_changed', 'Approval rules changed');
          },
        },
      );
    }
  }
}

/** Then the session's mode, for what is still pending. */
function decideByMode(
  host: ApprovalHost,
  session: string,
  c: LocalCall,
  root: string,
  args: LocalArgs,
  danger: DangerVerdict,
  publishes: string | null,
  escalated: boolean,
  policy: PermissionPolicy,
): void {
  // The session's mode approves by itself only what it covers (Phase 2b): scoped or ordinary
  // project edits, and, in auto, commands that stay inside the OS sandbox. Re-checked at decision.
  const covered = (p: typeof policy) =>
    args.action === 'edit'
      ? autoApprovesEdits(
          p,
          args.edits.map((e) => e.path),
        )
      : autoApprovesCommands(
          p,
          host.sandboxedUnder(args),
          danger.dangerous,
          publishes !== null || args.listen === true || !!args.outside_sandbox,
        ) && !(escalated && p.access !== 'yolo');
  if (host.managed.forOperation(c.operation_id).state === 'pending' && covered(policy)) {
    const approval = host.managed.forOperation(c.operation_id);
    host.managed.decide(
      approval.id,
      'scoped:' + c.id,
      approval.revision,
      approval.operation_digest,
      'approve',
      {
        receipt: {
          policy_digest: permissionDigest(policy),
          policy_revision: policy.revision,
          root,
          call_id: c.id,
        },
        authorize: () => {
          host.guard(c);
          const fresh = permissionPolicy(host.store, session);
          if (permissionDigest(fresh) !== permissionDigest(policy) || !covered(fresh))
            throw new ServiceError('permission_changed', 'Scoped edit policy changed');
          if (args.action === 'edit') verifyLocalEdits(root, args.edits);
        },
      },
    );
    // YOLO approves everything; each approval is recorded with what full access would have asked.
    if (policy.access === 'yolo')
      host.store.transaction(() =>
        host.store.event(session, 'permission.yolo-approved', {
          call_id: c.id,
          operation_id: c.operation_id,
          action: args.action,
          ...(args.action === 'command' ? { command: args.command } : {}),
          ...(danger.dangerous
            ? { would_have_asked: { category: danger.category, reason: danger.reason } }
            : publishes
              ? { would_have_asked: { category: 'publish', reason: publishes } }
              : {}),
        }),
      );
  }
}
