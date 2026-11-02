// Settling the permissions an execution controller owns (workspace edits, local commands and MCP
// calls): the controller reports what happened, and these record it on the operation, never more
// certain than the report allows. Callers hold the transaction.
import { ServiceError } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { McpOwners } from './mcp-owners.js';
import type { OperationRecords } from './operation-records.js';

export interface OwnedResultDeps {
  readonly store: Store;
  readonly records: OperationRecords;
  readonly mcp: McpOwners;
}

export function workspaceResultInTransaction(
  d: OwnedResultDeps,
  id: string,
  receipt: unknown,
): void {
  if (!d.store.db.isTransaction) throw Error('Workspace result requires a transaction');
  const op = d.records.operation(id);
  if (op.kind !== 'workspace' || op.state !== 'dispatching')
    throw new ServiceError('operation_scope', 'Not a dispatched workspace permission');
  d.mcp.controller(op).assertSettled(op);
  d.records.transition(
    op,
    'succeeded',
    null,
    JSON.stringify(receipt),
    'workspace-content-receipt-v1',
  );
}
export function localExecutionResultInTransaction(
  d: OwnedResultDeps,
  id: string,
  success: boolean,
  receipt: unknown,
): void {
  const op = d.records.operation(id);
  if (
    !d.store.db.isTransaction ||
    op.kind !== 'workspace' ||
    !['dispatching', 'outcome_unknown'].includes(op.state)
  )
    throw new ServiceError('operation_scope', 'Not a dispatched local execution');
  d.mcp.controller(op).assertSettled(op);
  d.records.transition(
    op,
    success ? 'succeeded' : 'failed_definite',
    success
      ? null
      : 'Local command ended without success; recorded output and any workspace effects remain available',
    JSON.stringify(receipt),
    'local-command-exit-v1',
  );
}
export function workspaceUnknownInTransaction(d: OwnedResultDeps, id: string): void {
  const op = d.records.operation(id);
  if (!d.store.db.isTransaction || op.kind !== 'workspace')
    throw new ServiceError('operation_scope', 'Not a workspace permission');
  if (op.state === 'dispatching')
    d.records.transition(
      op,
      'outcome_unknown',
      'Workspace apply result is unconfirmed; inspect the recorded intent',
    );
}
export function workspaceDefiniteFailureInTransaction(d: OwnedResultDeps, id: string): void {
  const op = d.records.operation(id);
  if (!d.store.db.isTransaction || op.kind !== 'workspace' || op.state !== 'dispatching')
    throw new ServiceError('operation_scope', 'Not a dispatched workspace permission');
  d.mcp.controller(op).assertSettled(op);
  d.records.transition(
    op,
    'failed_definite',
    'Protected filesystem refused before its mutation boundary',
  );
}
export function workspaceNotSentInTransaction(d: OwnedResultDeps, id: string): void {
  const op = d.records.operation(id);
  if (!d.store.db.isTransaction || op.kind !== 'workspace')
    throw new ServiceError('operation_scope', 'Not a workspace permission');
  if (op.state !== 'prepared') return;
  const approval = d.records.forOperation(id);
  if (['pending', 'decided'].includes(approval.state))
    d.records.invalidateApproval(approval, 'invalidated');
  d.records.transition(op, 'failed_definite', 'Workspace apply was cancelled before dispatch');
}
export function permissionResultInTransaction(
  d: OwnedResultDeps,
  id: string,
  success: boolean,
  receipt: unknown,
): void {
  if (!d.store.db.isTransaction) throw Error('Owned result requires a transaction');
  const op = d.records.operation(id);
  if (!['harness', 'mcp'].includes(op.kind) || op.state !== 'dispatching') return;
  d.records.transition(
    op,
    success && op.kind !== 'mcp' ? 'succeeded' : 'outcome_unknown',
    op.kind === 'mcp'
      ? 'An MCP protocol result does not verify the external effect; inspect the bound receipt'
      : success
        ? null
        : 'Owned tool failed after permission delivery; inspect actual effects',
    JSON.stringify(receipt),
    op.kind === 'mcp' ? 'managed-mcp-protocol-return' : 'owned-harness-tool-return',
  );
}
export function mcpNotSentInTransaction(d: OwnedResultDeps, id: string): void {
  if (!d.store.db.isTransaction) throw Error('MCP failure requires a transaction');
  const op = d.records.operation(id);
  if (op.kind !== 'mcp') throw new ServiceError('operation_scope', 'Not an MCP permission');
  if (op.state === 'dispatching') {
    permissionResultInTransaction(d, id, false, { protocol_result: 'unknown' });
    return;
  }
  if (op.state !== 'prepared') return;
  const approval = d.records.forOperation(id);
  if (['pending', 'decided'].includes(approval.state))
    d.records.invalidateApproval(approval, 'invalidated');
  d.records.transition(op, 'failed_definite', 'MCP call failed before transport handoff');
}
/** A broken adapter boundary is uncertainty, never evidence that no mutation happened. */
export function mcpUnknownInTransaction(d: OwnedResultDeps, id: string): void {
  if (!d.store.db.isTransaction) throw Error('MCP uncertainty requires a transaction');
  const op = d.records.operation(id);
  if (op.kind !== 'mcp') throw new ServiceError('operation_scope', 'Not an MCP permission');
  if (!['prepared', 'dispatching'].includes(op.state)) return;
  const approval = d.records.forOperation(id);
  if (['pending', 'decided'].includes(approval.state))
    d.records.invalidateApproval(approval, 'invalidated');
  d.records.transition(op, 'outcome_unknown', 'MCP transport dispatch boundary is unconfirmed');
}
