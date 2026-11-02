// Operations and their approvals as rows: reading them, the binding digest that ties an approval
// to one exact operation, the records a new operation starts with, and each state change with the
// event it commits. Callers hold the transaction.
import { randomUUID } from 'node:crypto';
import {
  digest,
  ServiceError,
  type Approval,
  type Operation,
  type OperationState,
  POLICY_DIGEST,
} from '../core/index.js';
import type { Store } from '../store/index.js';
import type { EffectConnector } from './effect-connector.js';

/** How long an operator has to decide, unless the service sets its own. */
const APPROVAL_TTL_MS = 300000;

export function operationBinding(op: Operation): string {
  return digest({
    id: op.id,
    session: op.session_id,
    attempt: op.attempt_id,
    epoch: op.worker_epoch,
    tool_call: op.tool_call_id,
    kind: op.kind,
    action_key: op.action_key,
    argument_digest: op.argument_digest,
    target: op.target,
    value: op.value,
    target_version: op.target_version,
    policy: op.policy_digest,
    connector: op.connector,
    replay: op.replay,
  });
}

/** A just-prepared operation and the pending approval that asks for it. */
export function preparedRecords(
  session: string,
  epoch: number,
  attempt: string,
  call: string,
  kind: Operation['kind'],
  target: string,
  value: string,
  version: string,
  connector: EffectConnector | undefined,
  approvalTtlMs = APPROVAL_TTL_MS,
): { operation: Operation; approval: Approval } {
  const id = randomUUID();
  const op: Operation = {
    id,
    session_id: session,
    attempt_id: attempt,
    worker_epoch: epoch,
    tool_call_id: call,
    kind,
    action_key: digest({ id, attempt, epoch, call, target, value, version }),
    argument_digest: digest({ target, value, target_version: version }),
    operation_digest: '',
    target,
    value,
    target_version: version,
    policy_digest: POLICY_DIGEST,
    connector:
      kind === 'workspace'
        ? 'station-workspace-v1'
        : kind === 'mcp'
          ? 'managed-mcp-protocol-v1'
          : kind === 'harness'
            ? 'external-harness-once-v1'
            : kind === 'review'
              ? 'local-review-v1'
              : connector!.id,
    replay:
      kind === 'harness' || kind === 'workspace'
        ? 'opaque'
        : kind === 'mcp'
          ? 'opaque'
          : kind === 'review'
            ? 'read-only'
            : connector!.replay,
    revision: 1,
    state: 'prepared',
    receipt: null,
    error: null,
    resolution: null,
  };
  op.operation_digest = operationBinding(op);
  const approval: Approval = {
    id: randomUUID(),
    operation_id: id,
    session_id: session,
    worker_epoch: epoch,
    operation_digest: op.operation_digest,
    revision: 1,
    actor_scope: 'local-operator',
    policy_digest: POLICY_DIGEST,
    expires_at: Date.now() + approvalTtlMs,
    state: 'pending',
    decision: null,
    decided_by: null,
  };
  return { operation: op, approval };
}

export class OperationRecords {
  constructor(private readonly store: Store) {}
  operation(id: string): Operation {
    const row = this.store.db.prepare('SELECT * FROM operations WHERE id=?').get(id) as unknown as
      Operation | undefined;
    if (!row) throw new ServiceError('not_found', 'Operation not found', 404);
    return row;
  }
  approval(id: string): Approval {
    const row = this.store.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as unknown as
      Approval | undefined;
    if (!row) throw new ServiceError('not_found', 'Approval not found', 404);
    return row;
  }
  pending(): Approval[] {
    return this.store.db
      .prepare("SELECT * FROM approvals WHERE state='pending'")
      .all() as unknown as Approval[];
  }
  forOperation(id: string): Approval {
    const row = this.store.db.prepare('SELECT id FROM approvals WHERE operation_id=?').get(id) as
      { id: string } | undefined;
    if (!row) throw new ServiceError('approval_missing', 'Operation has no approval');
    return this.approval(row.id);
  }
  insert(table: 'operations' | 'approvals', row: Operation | Approval): void {
    const keys = Object.keys(row);
    this.store.db
      .prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  }
  transition(
    op: Operation,
    state: OperationState,
    error: string | null = null,
    receipt: string | null = null,
    resolution: string | null = null,
  ): void {
    this.store.db
      .prepare(
        'UPDATE operations SET state=?,revision=revision+1,error=?,receipt=COALESCE(?,receipt),resolution=COALESCE(?,resolution) WHERE id=?',
      )
      .run(state, error, receipt, resolution, op.id);
    this.store.event(op.session_id, 'operation.' + state, {
      operation_id: op.id,
      attempt_id: op.attempt_id,
      error,
    });
  }
  invalidateApproval(approval: Approval, state: 'expired' | 'invalidated'): void {
    this.store.db
      .prepare('UPDATE approvals SET state=?,revision=revision+1 WHERE id=?')
      .run(state, approval.id);
    this.store.db
      .prepare(
        "UPDATE approval_dialogs SET state='invalidated' WHERE approval_id=? AND state!='pending'",
      )
      .run(approval.id);
    this.store.event(approval.session_id, 'approval.' + state, {
      approval_id: approval.id,
      operation_id: approval.operation_id,
    });
  }
}
