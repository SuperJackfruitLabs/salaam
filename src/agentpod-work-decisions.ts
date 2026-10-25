import { randomUUID } from 'node:crypto';
import type { AgentPodWork } from './agentpod-work.js';
import type { ManagedWork } from './managed.js';
import { canonical, digest, ServiceError } from './protocol.js';
import { type RunGrants, runGrantCovers, runGrantPrefix } from './run-grants.js';
import {
  workDecisionAnswer,
  type WorkDecision,
  type WorkDecisionDetail,
} from './agentpod-work-decision-protocol.js';
/** Private authenticated Hub control only. Answers choose an existing approval;
 * they never execute an operation or supply a second effect grant. */
export class AgentPodWorkDecisions {
  constructor(
    readonly work: AgentPodWork,
    readonly managed: ManagedWork,
    readonly grants?: RunGrants,
  ) {}
  /** The run directory a grant for this operation would cover, when it is a covered write. */
  private grantable(binding: unknown, op: { kind: string; value: string }): string | null {
    if (!this.grants || op.kind !== 'workspace') return null;
    const run = (binding as { run?: { id?: unknown } } | null)?.run;
    const prefix = runGrantPrefix(typeof run?.id === 'string' ? run.id : '');
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(op.value) as Record<string, unknown>;
    } catch {
      return null;
    }
    return prefix && runGrantCovers(prefix, args) ? prefix : null;
  }
  private owner(binding: unknown) {
    const root = this.work.authority.inspect(binding);
    const row = this.work.store.db
      .prepare('SELECT * FROM agentpod_work WHERE session_id=?')
      .get(root.session_id);
    if (!row) throw new ServiceError('work_missing', 'Admitted work required');
    const admission = JSON.parse(String(row.admission_json));
    if (canonical(admission.binding) !== canonical(root.binding))
      throw new ServiceError('work_authority_mismatch', 'Exact work authority required');
    return { root, row, task: this.work.tasks.get(String(row.task_id)) };
  }
  list(binding: unknown) {
    const { root, row, task } = this.owner(binding);
    this.work.store.execution.assert(root.session_id);
    const decisions = this.managed
      .pending()
      .filter((a) => a.session_id === root.session_id && a.expires_at > Date.now())
      .map((a) => {
        this.managed.assertDecisionOffer(a.id);
        const op = this.managed.operation(a.operation_id);
        if (op.operation_digest !== a.operation_digest)
          throw new ServiceError('approval_mismatch', 'Operation changed');
        const identity = {
          work_request_id: String(row.request_id),
          binding_digest: digest(root.binding),
          task_id: task.id,
          plan_revision: task.plan_revision,
          operation_id: op.id,
          operation_digest: op.operation_digest,
          approval_id: a.id,
          approval_revision: a.revision,
          expires_at: a.expires_at,
        };
        return this.work.store.request<WorkDecision>(
          'agentpod-work-decision-offer',
          a.id,
          identity,
          () => ({
            version: 1,
            request_id: randomUUID(),
            ...identity,
            question: approvalDetail(op).summary + '?',
            detail: approvalDetail(op),
            options: this.grantable(root.binding, op)
              ? [
                  { id: 'approve', title: 'Approve once' },
                  { id: 'approve-run', title: 'Approve for this run' },
                  { id: 'deny', title: 'Deny' },
                ]
              : [
                  { id: 'approve', title: 'Approve once' },
                  { id: 'deny', title: 'Deny' },
                ],
          }),
        );
      });
    return { version: 1 as const, decisions };
  }
  answer(binding: unknown, value: unknown) {
    const { root, row, task } = this.owner(binding),
      answer = workDecisionAnswer(value),
      offered = answer.decision;
    const saved = this.work.store.db
      .prepare("SELECT response FROM requests WHERE actor='agentpod-work-decision-offer' AND id=?")
      .get(offered.approval_id);
    if (
      !saved ||
      canonical(JSON.parse(String(saved.response))) !== canonical(offered) ||
      digest(offered) !== answer.decision_digest ||
      offered.work_request_id !== row.request_id ||
      offered.binding_digest !== digest(root.binding) ||
      offered.task_id !== task.id
    )
      throw new ServiceError('approval_mismatch', 'Answer does not match saved work decision');
    return this.work.store.request(
      'agentpod-work-decision-answer',
      answer.request_id,
      { binding: root.binding, answer },
      () => {
        this.work.store.execution.assert(root.session_id);
        if (
          task.plan_revision !== offered.plan_revision ||
          offered.expires_at <= Date.now() ||
          Date.parse(answer.answered_at) > Date.now() ||
          Date.parse(answer.answered_at) >= offered.expires_at
        )
          throw new ServiceError('approval_stale', 'Decision plan or deadline changed');
        const approval = this.managed.approval(offered.approval_id);
        if (
          approval.session_id !== root.session_id ||
          approval.operation_id !== offered.operation_id ||
          approval.expires_at !== offered.expires_at
        )
          throw new ServiceError('approval_mismatch', 'Approval ownership changed');
        // "Approve for this run" must have been offered, and still be grantable, to be chosen.
        const prefix =
          answer.option_id === 'approve-run'
            ? this.grantable(root.binding, this.managed.operation(offered.operation_id))
            : null;
        if (
          answer.option_id === 'approve-run' &&
          (!prefix || !offered.options.some((o) => o.id === 'approve-run'))
        )
          throw new ServiceError('approval_mismatch', 'This approval cannot cover the run');
        this.managed.decide(
          offered.approval_id,
          answer.request_id,
          offered.approval_revision,
          offered.operation_digest,
          answer.option_id === 'deny' ? 'deny' : 'approve',
        );
        const grant =
          answer.option_id === 'approve-run'
            ? this.grants!.createInTransaction({
                session_id: root.session_id,
                task_id: task.id,
                plan_revision: offered.plan_revision,
                binding_digest: offered.binding_digest,
                path_prefix: prefix!,
                approval_id: offered.approval_id,
                granted_by: answer.answered_by,
              })
            : null;
        this.work.store.execution.assert(root.session_id);
        return {
          version: 1 as const,
          request_id: answer.request_id,
          decision_digest: answer.decision_digest,
          approval_id: offered.approval_id,
          decision: answer.option_id,
          ...(grant ? { grant_id: grant.id } : {}),
        };
      },
    );
  }
}

/** Readable approvals: what a person approves, from the operation's own canonical arguments only.
 * A workspace write names its file, the change, its size, a short preview and the agent's one-line
 * reason; anything else names its kind and target. The digest still binds the exact operation. */
export function approvalDetail(op: {
  kind: string;
  action_key: string;
  target: string;
  value: string;
  operation_digest: string;
}): WorkDecisionDetail {
  const base = { version: 1 as const, reason: null, files: [], digest: op.operation_digest };
  if (op.kind === 'review') return { ...base, summary: 'Accept this step for review' };
  if (op.kind !== 'workspace')
    return { ...base, summary: ('Run ' + op.kind + ' ' + op.target).slice(0, 200) };
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(op.value) as Record<string, unknown>;
  } catch {
    /* not a patch: the generic form below */
  }
  const path = typeof args.path === 'string' ? args.path : op.target.replace(/^station:/, '');
  const content = typeof args.content === 'string' ? args.content : null;
  const change = args.content === null ? 'delete' : args.expected_hash === null ? 'create' : 'edit';
  const verb = { create: 'Create', edit: 'Edit', delete: 'Delete' }[change];
  const reason =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.replace(/\s+/g, ' ').trim().slice(0, 300)
      : null;
  return {
    ...base,
    summary: (verb + ' ' + path + ' in the workspace').slice(0, 200),
    reason,
    files: [
      {
        path: path.slice(0, 512),
        change,
        bytes: content === null ? null : Buffer.byteLength(content),
        preview: content === null ? null : content.slice(0, 1200),
      },
    ],
  };
}
