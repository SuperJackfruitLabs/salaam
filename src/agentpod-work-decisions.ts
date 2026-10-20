import { randomUUID } from 'node:crypto';
import type { AgentPodWork } from './agentpod-work.js';
import type { ManagedWork } from './managed.js';
import { canonical, digest, ServiceError } from './protocol.js';
import { workDecisionAnswer, type WorkDecision } from './agentpod-work-decision-protocol.js';
/** Private authenticated Hub control only. Answers choose an existing approval;
 * they never execute an operation or supply a second effect grant. */
export class AgentPodWorkDecisions {
  constructor(
    readonly work: AgentPodWork,
    readonly managed: ManagedWork,
  ) {}
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
            question: 'Approve this exact operation? ' + op.kind + ' ' + op.action_key,
            options: [
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
        this.managed.decide(
          offered.approval_id,
          answer.request_id,
          offered.approval_revision,
          offered.operation_digest,
          answer.option_id,
        );
        this.work.store.execution.assert(root.session_id);
        return {
          version: 1 as const,
          request_id: answer.request_id,
          decision_digest: answer.decision_digest,
          approval_id: offered.approval_id,
          decision: answer.option_id,
        };
      },
    );
  }
}
