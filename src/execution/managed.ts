// Over 600 lines: an operation's whole lifecycle shares one set of guards; rows, owners and owned results live beside it.
import {
  canonical,
  ServiceError,
  type Approval,
  type Operation,
  type Controller,
  type DurableEvent,
  type OperationState,
  POLICY_DIGEST,
} from '../core/index.js';
import type { Store } from '../store/index.js';
import {
  DefiniteFailure,
  type EffectConnector,
  type EffectInput,
  type EffectReceipt,
} from './effect-connector.js';
import {
  McpOwners,
  type McpPermissionController,
  type McpResolutionController,
  type OperationResolution,
} from './mcp-owners.js';
import { OperationRecords, operationBinding, preparedRecords } from './operation-records.js';
import * as owned from './owned-results.js';
import { cancelInTransaction } from './cancellation.js';

export { operationBinding } from './operation-records.js';
export type {
  McpPermissionController,
  McpResolutionController,
  OperationResolution,
} from './mcp-owners.js';

export interface ManagedOptions {
  connector?: EffectConnector;
  approvalTtlMs?: number;
  assertActive(session: string, epoch: number, attempt: string): void;
  reply(session: string, epoch: number, request: string, confirmed: boolean): void;
  failed(session: string, error: Error): void;
  assertMcpOperation?: (operation: Operation) => void;
  /** Legacy trusted controller seam; production controllers register their ownership below. */
  assertMcpSettlement?: (operation: Operation) => void;
}
/** Managed operations: each tool effect prepared once, approved by the operator (or a policy the
 * operator set), dispatched once, and settled with a receipt or left honestly unknown. */
export class ManagedWork {
  private mcp: McpOwners;
  private records: OperationRecords;
  /** What the owned-result and cancellation steps work on. */
  private settling: owned.OwnedResultDeps;
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private reconciling = new Set<string>();
  private lookups = new Set<Promise<Operation>>();
  private paused = false;
  private timer: NodeJS.Timeout;
  constructor(
    readonly store: Store,
    readonly options: ManagedOptions,
  ) {
    this.mcp = new McpOwners(options);
    this.records = new OperationRecords(store);
    this.settling = { store, records: this.records, mcp: this.mcp };
    store.changes.on('event', this.changed);
    this.timer = setInterval(() => {
      try {
        this.expire();
      } catch (error) {
        for (const approval of this.pending()) options.failed(approval.session_id, error as Error);
      }
    }, 100);
    this.timer.unref();
  }
  /** Ownership comes from the controller's durable records, never a tool target prefix. */
  registerMcpController(name: string, controller: McpPermissionController): () => void {
    return this.mcp.register(name, controller);
  }
  registerMcpResolutionController(name: string, controller: McpResolutionController): () => void {
    return this.mcp.registerResolution(name, controller);
  }
  private changed = (event: DurableEvent) => {
    if (
      [
        'approval.decided',
        'approval.expired',
        'approval.invalidated',
        'approval.dialog_bound',
      ].includes(event.kind)
    ) {
      try {
        this.deliver((event.payload as { approval_id: string }).approval_id);
      } catch (error) {
        this.options.failed(event.session_id, error as Error);
      }
    }
  };
  operation(id: string): Operation {
    return this.records.operation(id);
  }
  approval(id: string): Approval {
    return this.records.approval(id);
  }
  pending(): Approval[] {
    return this.records.pending();
  }
  private binding(op: Operation): string {
    return operationBinding(op);
  }
  private transition(
    op: Operation,
    state: OperationState,
    error: string | null = null,
    receipt: string | null = null,
    resolution: string | null = null,
  ): void {
    this.records.transition(op, state, error, receipt, resolution);
  }
  private invalidateApproval(approval: Approval, state: 'expired' | 'invalidated'): void {
    this.records.invalidateApproval(approval, state);
  }
  async prepare(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    kind: 'review' | 'effect' | 'harness',
    target: string,
    value: string,
  ): Promise<{ operation: Operation; approval: Approval }> {
    return this.prepareBound(session, epoch, attempt, call, kind, target, value);
  }
  async prepareMcp(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    target: string,
    value: string,
    context: string,
  ): Promise<{ operation: Operation; approval: Approval }> {
    return this.store.transaction(() =>
      this.prepareMcpInTransaction(session, epoch, attempt, call, target, value, context),
    );
  }
  prepareMcpInTransaction(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    target: string,
    value: string,
    context: string,
  ): { operation: Operation; approval: Approval } {
    if (!this.store.db.isTransaction) throw Error('MCP preparation requires a transaction');
    if (
      (!this.options.assertMcpOperation && this.mcp.size === 0) ||
      !/^[a-f0-9]{64}$/.test(context)
    )
      throw new ServiceError('mcp_disabled', 'A reviewed MCP execution controller is required');
    return this.insertPrepared(session, epoch, attempt, call, 'mcp', target, value, context);
  }
  prepareWorkspaceInTransaction(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    target: string,
    value: string,
    context: string,
  ): { operation: Operation; approval: Approval } {
    if (!this.store.db.isTransaction || !/^[a-f0-9]{64}$/.test(context) || !this.mcp.size)
      throw new ServiceError('workspace_disabled', 'A reviewed workspace controller is required');
    return this.insertPrepared(session, epoch, attempt, call, 'workspace', target, value, context);
  }
  workspaceResultInTransaction(id: string, receipt: unknown): void {
    owned.workspaceResultInTransaction(this.settling, id, receipt);
  }
  localExecutionResultInTransaction(id: string, success: boolean, receipt: unknown): void {
    owned.localExecutionResultInTransaction(this.settling, id, success, receipt);
  }
  workspaceUnknownInTransaction(id: string): void {
    owned.workspaceUnknownInTransaction(this.settling, id);
  }
  workspaceDefiniteFailureInTransaction(id: string): void {
    owned.workspaceDefiniteFailureInTransaction(this.settling, id);
  }
  workspaceNotSentInTransaction(id: string): void {
    owned.workspaceNotSentInTransaction(this.settling, id);
  }
  private async prepareBound(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    kind: 'review' | 'effect' | 'harness',
    target: string,
    value: string,
  ): Promise<{ operation: Operation; approval: Approval }> {
    this.options.assertActive(session, epoch, attempt);
    const old = this.store.db
      .prepare('SELECT id FROM operations WHERE session_id=? AND worker_epoch=? AND tool_call_id=?')
      .get(session, epoch, call) as { id: string } | undefined;
    if (old) {
      const op = this.operation(old.id);
      if (
        op.attempt_id !== attempt ||
        op.kind !== kind ||
        op.target !== target ||
        op.value !== value
      )
        throw new ServiceError(
          'operation_conflict',
          'Tool invocation already binds different arguments',
        );
      return { operation: op, approval: this.forOperation(op.id) };
    }
    if (this.paused || this.store.hasUnknown(session))
      throw new ServiceError('operation_blocked', 'Unresolved effects block new operations');
    const connector = this.options.connector;
    if (kind === 'effect' && !connector)
      throw new ServiceError('effect_disabled', 'No external effect connector is configured');
    const version =
      kind === 'harness'
        ? 'owned-once-only'
        : kind === 'review'
          ? 'read-only'
          : await connector!.version(target, AbortSignal.timeout(2500));
    return this.store.transaction(() =>
      this.insertPrepared(session, epoch, attempt, call, kind, target, value, version, connector),
    );
  }
  private insertPrepared(
    session: string,
    epoch: number,
    attempt: string,
    call: string,
    kind: Operation['kind'],
    target: string,
    value: string,
    version: string,
    connector?: EffectConnector,
  ): { operation: Operation; approval: Approval } {
    if (!this.store.db.isTransaction) throw Error('Operation preparation requires a transaction');
    this.options.assertActive(session, epoch, attempt);
    const existing = this.store.db
      .prepare('SELECT id FROM operations WHERE session_id=? AND worker_epoch=? AND tool_call_id=?')
      .get(session, epoch, call) as { id: string } | undefined;
    if (existing) {
      const op = this.operation(existing.id);
      if (
        op.attempt_id !== attempt ||
        op.kind !== kind ||
        op.target !== target ||
        op.value !== value ||
        (['mcp', 'workspace'].includes(kind) && op.target_version !== version)
      )
        throw new ServiceError(
          'operation_conflict',
          'Tool invocation already binds different arguments',
        );
      return { operation: op, approval: this.forOperation(op.id) };
    }
    if (this.paused || this.store.hasUnknown(session))
      throw new ServiceError('operation_blocked', 'Unresolved effects block new operations');
    const { operation: op, approval } = preparedRecords(
      session,
      epoch,
      attempt,
      call,
      kind,
      target,
      value,
      version,
      connector,
      this.options.approvalTtlMs,
    );
    const id = op.id;
    this.records.insert('operations', op);
    this.records.insert('approvals', approval);
    this.store.event(session, 'operation.prepared', {
      operation_id: id,
      attempt_id: attempt,
      operation_digest: op.operation_digest,
      target,
      value,
      target_version: version,
    });
    this.store.event(session, 'approval.requested', {
      approval_id: approval.id,
      operation_id: id,
      operation_digest: op.operation_digest,
      target,
      value,
      target_version: version,
      expires_at: approval.expires_at,
    });
    return { operation: op, approval };
  }
  forOperation(id: string): Approval {
    return this.records.forOperation(id);
  }
  assertDecisionOffer(id: string): void {
    const approval = this.approval(id);
    if (approval.state !== 'pending')
      throw new ServiceError('approval_stale', 'Approval is no longer pending');
    this.fresh(this.operation(approval.operation_id));
  }
  decide(
    id: string,
    request: string,
    revision: number,
    binding: string,
    decision: 'approve' | 'deny',
    scoped?: { receipt: Record<string, unknown>; authorize: () => void; decidedBy?: string },
  ): Approval {
    const requestWork = this.store.db.isTransaction
      ? this.store.requestInTransaction.bind(this.store)
      : this.store.request.bind(this.store);
    return requestWork<Approval>(
      'local-operator',
      request,
      {
        kind: 'approval-decision',
        id,
        revision,
        binding,
        decision,
        ...(scoped ? { scoped: scoped.receipt } : {}),
      },
      () => {
        const approval = this.approval(id);
        const op = this.operation(approval.operation_id);
        if (approval.actor_scope !== 'local-operator')
          throw new ServiceError('unauthorized', 'Operator is outside approval scope', 403);
        if (approval.revision !== revision || approval.state !== 'pending')
          throw new ServiceError(
            'approval_stale',
            'Approval is no longer pending at this revision',
          );
        if (binding !== approval.operation_digest || binding !== this.binding(op))
          throw new ServiceError(
            'approval_mismatch',
            'Decision does not match the bound operation',
          );
        if (scoped) {
          if (decision !== 'approve' || op.kind !== 'workspace')
            throw new ServiceError(
              'invalid_permissions',
              'Scoped approval only applies to local workspace edits',
            );
          scoped.authorize();
          this.store.event(
            op.session_id,
            'permission.auto-approved',
            { ...scoped.receipt, operation_id: op.id, operation_digest: op.operation_digest },
            request,
          );
        }
        this.fresh(op);
        this.store.db
          .prepare(
            "UPDATE approvals SET state='decided',decision=?,decided_by=?,revision=revision+1 WHERE id=?",
          )
          .run(decision, scoped ? (scoped.decidedBy ?? 'scoped-policy') : 'local-operator', id);
        if (decision === 'deny')
          this.transition(op, 'cancelled_before_dispatch', 'Denied by operator');
        this.store.event(
          approval.session_id,
          'approval.decided',
          { approval_id: id, operation_id: op.id, decision },
          request,
        );
        return this.approval(id);
      },
    );
  }
  private fresh(op: Operation): void {
    this.options.assertActive(op.session_id, op.worker_epoch, op.attempt_id);
    const approval = this.forOperation(op.id);
    if (
      op.operation_digest !== this.binding(op) ||
      approval.operation_digest !== op.operation_digest ||
      approval.policy_digest !== POLICY_DIGEST ||
      op.policy_digest !== POLICY_DIGEST
    )
      throw new ServiceError('binding_changed', 'Operation or policy binding changed');
    if (approval.expires_at <= Date.now() || !['pending', 'decided'].includes(approval.state))
      throw new ServiceError('approval_stale', 'Approval expired or was invalidated');
    if (op.kind === 'effect' && this.options.connector?.id !== op.connector)
      throw new ServiceError('connector_changed', 'Effect connector changed');
    if (op.kind === 'mcp' || op.kind === 'workspace') {
      this.mcp.controller(op).assert(op);
    }
  }
  bindDialog(session: string, epoch: number, id: string, binding: string, request: string): void {
    this.store.transaction(() => {
      const approval = this.approval(id);
      const op = this.operation(approval.operation_id);
      if (
        approval.session_id !== session ||
        approval.worker_epoch !== epoch ||
        binding !== approval.operation_digest ||
        op.operation_digest !== this.binding(op)
      )
        throw new ServiceError('dialog_mismatch', 'Dialog does not bind this worker operation');
      this.options.assertActive(session, epoch, op.attempt_id);
      const existing = this.store.db
        .prepare('SELECT pi_request_id FROM approval_dialogs WHERE approval_id=?')
        .get(id) as { pi_request_id: string } | undefined;
      if (existing) {
        if (existing.pi_request_id !== request)
          throw new ServiceError('dialog_conflict', 'Approval already has a dialog');
        return;
      }
      this.store.db
        .prepare("INSERT INTO approval_dialogs VALUES (?,?,?,?,'pending')")
        .run(id, session, epoch, request);
      this.store.event(session, 'approval.dialog_bound', {
        approval_id: id,
        pi_request_id: request,
        epoch,
      });
    });
  }
  private deliver(id: string): void {
    const approval = this.approval(id);
    if (approval.state === 'pending') return;
    const dialog = this.store.db
      .prepare("SELECT pi_request_id FROM approval_dialogs WHERE approval_id=? AND state='pending'")
      .get(id) as { pi_request_id: string } | undefined;
    if (!dialog) return;
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE approval_dialogs SET state='replied' WHERE approval_id=? AND state='pending'",
        )
        .run(id);
      this.store.event(approval.session_id, 'approval.dialog_replied', {
        approval_id: id,
        pi_request_id: dialog.pi_request_id,
      });
    });
    this.options.reply(
      approval.session_id,
      approval.worker_epoch,
      dialog.pi_request_id,
      approval.state === 'decided' && approval.decision === 'approve',
    );
  }
  expire(): void {
    const expired = this.store.db
      .prepare(
        "SELECT a.* FROM approvals a JOIN operations o ON o.id=a.operation_id WHERE a.state IN ('pending','decided') AND o.state='prepared' AND a.expires_at<=?",
      )
      .all(Date.now()) as unknown as Approval[];
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const approval of expired) {
        this.invalidateApproval(approval, 'expired');
        this.transition(
          this.operation(approval.operation_id),
          'cancelled_before_dispatch',
          'Approval expired',
        );
      }
    });
  }
  start(id: string, session: string, epoch: number, attempt: string): Operation {
    const op = this.operation(id);
    if (op.kind === 'harness' || op.kind === 'mcp' || op.kind === 'workspace')
      throw new ServiceError(
        'operation_scope',
        'An owned permission can only be consumed by its execution controller',
      );
    if (op.session_id !== session || op.worker_epoch !== epoch || op.attempt_id !== attempt)
      throw new ServiceError('operation_scope', 'Operation belongs to another invocation', 403);
    if (op.state !== 'prepared' || this.active.has(id)) return op;
    this.fresh(op);
    const approval = this.forOperation(id);
    if (approval.decision !== 'approve' || approval.state !== 'decided') return op;
    const controller = new AbortController();
    const done = this.dispatch(id, controller.signal)
      .catch((error) => this.options.failed(session, error as Error))
      .finally(() => this.active.delete(id));
    this.active.set(id, { controller, done });
    return this.operation(id);
  }
  private input(op: Operation): EffectInput {
    return {
      target: op.target,
      value: op.value,
      target_version: op.target_version,
      argument_digest: op.argument_digest,
    };
  }
  /** Commit a one-time grant handoff before replying to the owned runtime. This is not a tool receipt. */
  takePermission(id: string): boolean {
    return this.store.transaction(() => this.takePermissionInTransaction(id));
  }
  /** The caller atomically commits its call marker with this one-time permission. */
  takePermissionInTransaction(id: string): boolean {
    if (!this.store.db.isTransaction) throw Error('Owned permission requires a transaction');
    const op = this.operation(id);
    if (!['harness', 'mcp', 'workspace'].includes(op.kind) || op.state !== 'prepared') return false;
    this.fresh(op);
    if (this.paused || this.store.hasUnknown(op.session_id))
      throw new ServiceError('operation_blocked', 'Unresolved effects block new permissions');
    const approval = this.forOperation(id);
    if (approval.state !== 'decided' || approval.decision !== 'approve') return false;
    this.transition(op, 'dispatching');
    return true;
  }
  permissionResult(id: string, success: boolean, receipt: unknown): void {
    this.store.transaction(() => this.permissionResultInTransaction(id, success, receipt));
  }
  permissionResultInTransaction(id: string, success: boolean, receipt: unknown): void {
    owned.permissionResultInTransaction(this.settling, id, success, receipt);
  }
  mcpNotSent(id: string): void {
    this.store.transaction(() => this.mcpNotSentInTransaction(id));
  }
  mcpNotSentInTransaction(id: string): void {
    owned.mcpNotSentInTransaction(this.settling, id);
  }
  /** A broken adapter boundary is uncertainty, never evidence that no mutation happened. */
  mcpUnknownInTransaction(id: string): void {
    owned.mcpUnknownInTransaction(this.settling, id);
  }
  private async dispatch(id: string, signal: AbortSignal): Promise<void> {
    try {
      let op = this.operation(id);
      if (op.kind === 'effect') {
        const version = await this.options.connector!.version(op.target, signal);
        if (version !== op.target_version)
          throw new DefiniteFailure('Target version changed before dispatch');
      }
      this.store.transaction(() => {
        op = this.operation(id);
        this.fresh(op);
        if (
          this.paused ||
          this.store.hasUnknown(op.session_id) ||
          op.state !== 'prepared' ||
          this.forOperation(id).decision !== 'approve'
        )
          throw new ServiceError('operation_blocked', 'Dispatch is no longer authorized');
        this.transition(op, 'dispatching');
      });
      const receipt: EffectReceipt =
        op.kind === 'review'
          ? { id: op.action_key, accepted: true, payload: this.input(op) }
          : await this.options.connector!.dispatch(op.action_key, this.input(op), signal);
      this.recordReceipt(id, receipt);
    } catch (error) {
      const op = this.operation(id);
      if (!['prepared', 'dispatching', 'outcome_unknown'].includes(op.state)) return;
      this.store.transaction(() =>
        this.transition(
          op,
          op.state === 'prepared' || error instanceof DefiniteFailure
            ? 'failed_definite'
            : 'outcome_unknown',
          (error as Error).message.slice(0, 4096),
        ),
      );
    }
  }
  recordReceipt(id: string, receipt: EffectReceipt): void {
    const op = this.operation(id);
    if (op.kind === 'mcp' || op.kind === 'harness' || op.kind === 'workspace')
      throw new ServiceError(
        'operation_scope',
        'An owned result requires its execution controller',
      );
    if (!['dispatching', 'outcome_unknown'].includes(op.state)) return;
    if (
      canonical(receipt.payload) !== canonical(this.input(op)) ||
      (op.replay !== 'opaque' && receipt.id !== op.action_key)
    )
      throw new Error('Receipt does not match operation binding');
    this.store.transaction(() =>
      this.transition(
        op,
        'succeeded',
        null,
        JSON.stringify(receipt),
        op.kind === 'review' ? 'local-review-receipt' : 'external-receipt',
      ),
    );
  }
  invalidateWorker(session: string, epoch: number): void {
    const ops = this.store.db
      .prepare(
        "SELECT * FROM operations WHERE session_id=? AND worker_epoch=? AND state IN ('prepared','dispatching')",
      )
      .all(session, epoch) as unknown as Operation[];
    if (!ops.length) return;
    this.store.transaction(() => {
      for (const op of ops) {
        const approval = this.forOperation(op.id);
        if (['pending', 'decided'].includes(approval.state))
          this.invalidateApproval(approval, 'invalidated');
        this.transition(
          op,
          op.state === 'prepared' ? 'cancelled_before_dispatch' : 'outcome_unknown',
          'Worker no longer owns this operation',
        );
      }
    });
    for (const op of ops) this.active.get(op.id)?.controller.abort();
  }
  recover(): void {
    const pairs = this.store.db
      .prepare(
        "SELECT DISTINCT session_id,worker_epoch FROM operations WHERE state IN ('prepared','dispatching')",
      )
      .all() as { session_id: string; worker_epoch: number }[];
    for (const pair of pairs) this.invalidateWorker(pair.session_id, pair.worker_epoch);
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE approval_dialogs SET state='invalidated' WHERE state='pending'")
        .run();
    });
  }
  reconcile(id: string): Promise<Operation> {
    const task = this.reconcileOperation(id);
    this.lookups.add(task);
    void task.then(
      () => this.lookups.delete(task),
      () => this.lookups.delete(task),
    );
    return task;
  }
  private async reconcileOperation(id: string): Promise<Operation> {
    const op = this.operation(id);
    if (op.state !== 'outcome_unknown') return op;
    if (this.active.has(id) || this.reconciling.has(id))
      throw new ServiceError('operation_busy', 'Owned transport or lookup is still settling');
    const connector = this.options.connector;
    if (op.replay !== 'lookup' || !connector?.lookup || connector.id !== op.connector) return op;
    this.reconciling.add(id);
    try {
      const receipt = await connector.lookup(op.action_key, AbortSignal.timeout(2500));
      if (receipt) this.recordReceipt(id, receipt);
      // A negative lookup cannot exclude an earlier request still arriving.
    } catch (error) {
      this.store.transaction(() => {
        const current = this.operation(id);
        if (current.state === 'outcome_unknown')
          this.transition(current, 'outcome_unknown', (error as Error).message.slice(0, 4096));
      });
    } finally {
      this.reconciling.delete(id);
    }
    return this.operation(id);
  }
  async reconcileAll(): Promise<void> {
    const ids = this.store.db
      .prepare("SELECT id FROM operations WHERE state='outcome_unknown'")
      .all() as { id: string }[];
    for (const { id } of ids) await this.reconcile(id);
  }
  resolve(
    id: string,
    request: string,
    revision: number,
    binding: string,
    outcome: 'succeeded' | 'failed_definite',
    evidence: string,
  ): Operation {
    const input: OperationResolution = {
      kind: 'operation-resolution',
      id,
      revision,
      binding,
      outcome,
      evidence,
    };
    return this.store.request('local-operator', request, input, () => {
      const op = this.operation(id);
      if (
        op.state !== 'outcome_unknown' ||
        op.revision !== revision ||
        this.active.has(id) ||
        this.reconciling.has(id)
      )
        throw new ServiceError(
          'resolution_stale',
          'Operation is not unresolved at this revision or transport is active',
        );
      if (op.operation_digest !== binding || binding !== this.binding(op))
        throw new ServiceError('binding_changed', 'Resolution binding mismatch');
      if (op.kind === 'mcp' || op.kind === 'workspace')
        this.mcp.assertResolution(op, request, input);
      this.transition(
        op,
        outcome,
        null,
        null,
        JSON.stringify({ source: 'operator-attestation', actor: 'local-operator', evidence }),
      );
      return this.operation(id);
    });
  }
  cancelInTransaction(attempt: string, request: string, actor = 'local-operator') {
    return cancelInTransaction(this.settling, attempt, request, actor);
  }
  abortCancelled(attempt: string): void {
    for (const [id, active] of this.active)
      if (this.operation(id).attempt_id === attempt) active.controller.abort();
  }
  cancel(
    attempt: string,
    request: string,
    revision: number,
    controller: Controller,
  ): { attempt_id: string; cancel_requested: true; unresolved_operations: string[] } {
    const receipt = this.store.request(
      'local-operator',
      request,
      { kind: 'cancel-attempt', attempt, revision },
      () => {
        const work = this.store.attempt(attempt);
        this.store.authorizeControl(work.session_id, controller);
        if (this.store.session(work.session_id).revision !== revision)
          throw new ServiceError('revision_conflict', 'Session revision changed');
        if (!['accepted', 'dispatching', 'running'].includes(work.state))
          throw new ServiceError('attempt_settled', 'Attempt already settled');
        return this.cancelInTransaction(attempt, request);
      },
    );
    this.abortCancelled(attempt);
    return receipt;
  }
  pause(): void {
    this.paused = true;
    clearInterval(this.timer);
  }
  async close(): Promise<void> {
    this.pause();
    for (const active of this.active.values()) active.controller.abort();
    await Promise.all([...this.active.values()].map((active) => active.done));
    await Promise.allSettled(this.lookups);
    this.store.changes.off('event', this.changed);
    this.mcp.clear();
  }
}
