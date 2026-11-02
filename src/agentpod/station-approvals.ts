// Approval scopes for station writes: a write the run's grant, or the agent's standing rule,
// covers is answered by it, and checked again at decision time.
import { digest, ServiceError } from '../core/index.js';
import type { ManagedWork } from '../execution/index.js';
import { type RunGrants, runGrantCovers, runGrantPrefix } from '../tasks/index.js';
import type { AgentPodAuthority } from './authority.js';

/** What the approval scopes read: the authority's binding and rules, the run grants and the
 * task scope of a session's run (both wired by the service, so either may be absent). */
export interface StationApprovalDeps {
  readonly authority: Pick<AgentPodAuthority, 'binding' | 'approvalRules'>;
  readonly managed: Pick<ManagedWork, 'forOperation' | 'decide'>;
  readonly grants?: RunGrants;
  readonly grantScope?: (
    session: string,
  ) => { task_id: string; plan_revision: number; task_state: string } | null;
}

/** A write the run's grant covers is answered by it, checked again at decision time. The
 * operation is still prepared, digest-bound and journaled on its own; deletes always ask. */
export function answerFromGrant(
  deps: StationApprovalDeps,
  operation: string,
  session: string,
  args: Record<string, unknown>,
): void {
  if (!deps.grants || !deps.grantScope) return;
  const binding = deps.authority.binding(session) as { run?: { id?: unknown } } | null;
  const prefix = runGrantPrefix(typeof binding?.run?.id === 'string' ? binding.run.id : '');
  const live = () => {
    const scope = deps.grantScope!(session);
    if (!scope || !prefix || !runGrantCovers(prefix, args)) return null;
    const g = deps.grants!.active({
      session_id: session,
      binding_digest: digest(binding),
      ...scope,
    });
    return g;
  };
  const grant = live();
  if (!grant) return answerFromRule(deps, operation, session, args);
  const approval = deps.managed.forOperation(operation);
  if (approval.state !== 'pending') return;
  deps.managed.decide(
    approval.id,
    'run-grant:' + operation,
    approval.revision,
    approval.operation_digest,
    'approve',
    {
      decidedBy: 'run-grant:' + grant.id,
      receipt: {
        rule: 'run-grant',
        grant_id: grant.id,
        granted_by: grant.granted_by,
        granted_on: grant.approval_id,
      },
      authorize: () => {
        if (live()?.id !== grant.id)
          throw new ServiceError('permission_changed', 'The run grant no longer covers this write');
      },
    },
  );
}

/** An agent's standing "Always allow" rule (pinned at admission or added by a renewal, dropped at the renewal that no
 * longer lists it) answers a workspace write anywhere in the workspace, never a delete or a
 * hidden path. Checked again at decision time, so a rule revoked meanwhile answers nothing. */
function answerFromRule(
  deps: StationApprovalDeps,
  operation: string,
  session: string,
  args: Record<string, unknown>,
): void {
  if (!runGrantCovers('', args)) return;
  const live = () =>
    deps.authority.approvalRules(session).find((r) => r.scope === 'workspace-write');
  const rule = live();
  if (!rule) return;
  const approval = deps.managed.forOperation(operation);
  if (approval.state !== 'pending') return;
  deps.managed.decide(
    approval.id,
    'rule:' + operation,
    approval.revision,
    approval.operation_digest,
    'approve',
    {
      decidedBy: 'rule:' + rule.id,
      receipt: { rule: 'agent-rule', rule_id: rule.id, set_by: rule.set_by },
      authorize: () => {
        if (live()?.id !== rule.id)
          throw new ServiceError(
            'permission_changed',
            'The approval rule no longer covers this write',
          );
      },
    },
  );
}
