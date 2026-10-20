import type { Store } from './store.js';
import type { ManagedWork } from './managed.js';
import type { ToolkitResources } from './toolkit-resources.js';
import type { AgentPodAuthority } from './agentpod-authority.js';
import { agentpodBinding, type AgentPodBinding } from './agentpod-protocol.js';
import { canonical, digest, object, ServiceError, type Operation } from './protocol.js';
import { toolkitRequest, type ToolkitRequest } from './toolkit-protocol.js';

export interface ToolkitActionPin {
  kind: 'read' | 'write' | 'destructive';
  policy: 'agent' | 'approval';
  digest: string;
}
export interface ToolkitCall {
  id: string;
  session_id: string;
  worker_epoch: number;
  attempt_id: string;
  tool_call_id: string;
  resource_id: string;
  request_json: string;
  request_digest: string;
  context_digest: string;
  action_pin: string;
  operation_id: string | null;
  state:
    | 'prepared'
    | 'delivered'
    | 'dispatching'
    | 'pending'
    | 'denied'
    | 'returned'
    | 'outcome_unknown'
    | 'cancelled';
  revision: number;
  receipt_json: string | null;
  cancel_requested: number;
}
export interface ToolkitCallOptions {
  authority: AgentPodAuthority;
  resources: ToolkitResources;
  assertActive(session: string, epoch: number, attempt: string): void;
  /** Trusted controller must derive this from the actual admitted binary/catalog,
   * never from a worker's annotations or request. Includes policy and native kind. */
  action(resource: string, service: string, action: string): ToolkitActionPin;
}
export function toolkitCallContext(
  call: Pick<
    ToolkitCall,
    | 'id'
    | 'session_id'
    | 'worker_epoch'
    | 'attempt_id'
    | 'tool_call_id'
    | 'resource_id'
    | 'request_digest'
    | 'action_pin'
  >,
): string {
  return digest({
    id: call.id,
    session: call.session_id,
    epoch: call.worker_epoch,
    attempt: call.attempt_id,
    tool_call: call.tool_call_id,
    resource: call.resource_id,
    request: call.request_digest,
    action: call.action_pin,
  });
}

type Phase = 'review' | 'admit' | 'dispatch';
interface Reply {
  version: 1;
  phase: Phase;
  request_digest: string;
  decision: 'pending' | 'denied' | 'allowed';
  decision_id?: string;
  authority_for_ms?: number;
  send_within_ms?: number;
}
function blocked(): never {
  throw new ServiceError(
    'toolkit_call_blocked',
    'Native Toolkit call is unavailable or unresolved',
  );
}

/** Durable native call/approval owner. MCP delivery is NOT the effect grant;
 * only the post-credential dispatch callback consumes that grant. This core
 * requires a separately authenticated, resource-bound private endpoint and an
 * actual admitted catalogue controller before exposing any model capability. */
export class ToolkitCalls {
  private unregister: () => void;
  private closing = false;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly options: ToolkitCallOptions,
  ) {
    this.unregister = managed.registerMcpController('managed-toolkit-v1', {
      owns: (op) =>
        !!store.db.prepare('SELECT 1 FROM toolkit_calls WHERE operation_id=?').get(op.id),
      assert: (op) => {
        this.bound(this.operationCall(op));
      },
      assertSettled: (op) => {
        const call = this.operationCall(op);
        options.resources.stopProof(call.resource_id);
        // Opaque native results settle only through the persistent, exact human
        // resolution role. The execution controller alone cannot attest them.
        if (['delivered', 'dispatching', 'outcome_unknown'].includes(call.state)) blocked();
      },
    });
  }
  close(): void {
    this.closing = true;
    this.unregister();
  }
  get(id: string): ToolkitCall {
    const call = this.store.db
      .prepare('SELECT * FROM toolkit_calls WHERE id=?')
      .get(id) as unknown as ToolkitCall | undefined;
    if (!call) throw new ServiceError('not_found', 'Native Toolkit call not found', 404);
    return call;
  }
  private change(call: ToolkitCall, state: ToolkitCall['state']): void {
    this.store.db
      .prepare('UPDATE toolkit_calls SET state=?,revision=revision+1 WHERE id=?')
      .run(state, call.id);
    this.store.event(call.session_id, 'toolkit.call.' + state, {
      call_id: call.id,
      attempt_id: call.attempt_id,
      operation_id: call.operation_id,
      request_digest: call.request_digest,
    });
  }
  private request(call: ToolkitCall): ToolkitRequest {
    const request = toolkitRequest(JSON.parse(call.request_json));
    if (
      digest(request) !== call.request_digest ||
      digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]) !== call.id
    )
      blocked();
    return request;
  }
  /** Historical data access remains exact-root/principal scoped, even when a
   * lease expires. The caller must separately authenticate this data reader. */
  saved(id: string, binding: AgentPodBinding): ToolkitCall {
    const call = this.get(id),
      request = this.request(call);
    const admitted = this.options.authority.bySession(call.session_id);
    if (
      digest(agentpodBinding(binding)) !== request.root_digest ||
      admitted.digest !== request.root_digest ||
      admitted.binding !== canonical(binding)
    )
      blocked();
    return call;
  }
  private action(resource: string, request: ToolkitRequest): ToolkitActionPin {
    const pin = this.options.action(resource, request.service, request.action);
    if (
      Object.keys(pin).sort().join(',') !== 'digest,kind,policy' ||
      !/^[a-f0-9]{64}$/.test(pin.digest) ||
      !['read', 'write', 'destructive'].includes(pin.kind) ||
      !['agent', 'approval'].includes(pin.policy) ||
      (pin.kind !== 'read' && pin.policy !== 'approval') ||
      request.approval !== (pin.policy === 'approval')
    )
      blocked();
    return pin;
  }
  private context(
    call: Omit<ToolkitCall, 'context_digest' | 'operation_id' | 'state' | 'revision'>,
  ): string {
    return toolkitCallContext(call);
  }
  private bound(call: ToolkitCall): ToolkitRequest {
    const request = this.request(call),
      resource = this.options.resources.get(call.resource_id);
    this.options.assertActive(call.session_id, call.worker_epoch, call.attempt_id);
    this.options.resources.assertLive(call.resource_id);
    if (
      resource.session_id !== call.session_id ||
      resource.root_digest !== request.root_digest ||
      resource.profile_digest !== request.profile_digest ||
      digest(this.options.authority.binding(call.session_id)) !== request.root_digest ||
      canonical(this.action(call.resource_id, request)) !== call.action_pin ||
      this.context(call) !== call.context_digest ||
      request.expires_at_ms <= Date.now()
    )
      blocked();
    if (
      this.store.hasUnknown(call.session_id) ||
      this.store.db
        .prepare(
          "SELECT 1 FROM toolkit_calls WHERE resource_id=? AND id!=? AND state IN ('prepared','delivered','dispatching','pending','outcome_unknown')",
        )
        .get(call.resource_id, call.id)
    )
      blocked();
    return request;
  }
  private operationCall(op: Operation): ToolkitCall {
    const row = this.store.db
      .prepare('SELECT id FROM toolkit_calls WHERE operation_id=?')
      .get(op.id);
    if (!row) blocked();
    const call = this.get(String(row.id)),
      request = this.request(call);
    if (
      op.session_id !== call.session_id ||
      op.worker_epoch !== call.worker_epoch ||
      op.attempt_id !== call.attempt_id ||
      op.tool_call_id !== call.tool_call_id ||
      op.target !== 'toolkit/' + request.service + '/' + request.action ||
      op.value !== canonical(request.args) ||
      op.target_version !== call.context_digest
    )
      blocked();
    return call;
  }
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    toolCall: string,
    resourceId: string,
    input: unknown,
  ): ToolkitCall {
    const request = toolkitRequest(input),
      id = digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]);
    if (typeof toolCall !== 'string' || !toolCall || toolCall.length > 512) blocked();
    const prior = this.store.db
      .prepare(
        'SELECT id FROM toolkit_calls WHERE (session_id=? AND worker_epoch=? AND tool_call_id=?) OR id=?',
      )
      .all(session, epoch, toolCall, id);
    if (prior.length) {
      if (prior.length !== 1) blocked();
      const old = this.get(String(prior[0]!.id));
      if (
        old.id !== id ||
        old.session_id !== session ||
        old.worker_epoch !== epoch ||
        old.attempt_id !== attempt ||
        old.tool_call_id !== toolCall ||
        old.resource_id !== resourceId ||
        old.request_json !== canonical(request)
      )
        blocked();
      return old; // Saved/uncertain call wins before any fresh authority or action lookup.
    }
    if (this.closing) blocked();
    return this.store.transaction(() => {
      const call: ToolkitCall = {
        id,
        session_id: session,
        worker_epoch: epoch,
        attempt_id: attempt,
        tool_call_id: toolCall,
        resource_id: resourceId,
        request_json: canonical(request),
        request_digest: digest(request),
        context_digest: '',
        action_pin: canonical(this.action(resourceId, request)),
        operation_id: null,
        state: 'prepared',
        revision: 1,
        receipt_json: null,
        cancel_requested: 0,
      };
      call.context_digest = this.context(call);
      this.bound(call);
      if (request.expires_at_ms > Date.now() + 300000) blocked();
      if (request.approval)
        call.operation_id = this.managed.prepareMcpInTransaction(
          session,
          epoch,
          attempt,
          toolCall,
          'toolkit/' + request.service + '/' + request.action,
          canonical(request.args),
          call.context_digest,
        ).operation.id;
      const keys = Object.keys(call);
      this.store.db
        .prepare(
          `INSERT INTO toolkit_calls(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
        )
        .run(...Object.values(call));
      this.store.event(session, 'toolkit.call.prepared', {
        call_id: id,
        attempt_id: attempt,
        operation_id: call.operation_id,
        request_digest: call.request_digest,
      });
      return this.get(id);
    });
  }
  /** Durable delivery marker, without consuming native effect permission. */
  deliver(id: string): void {
    if (this.closing) blocked();
    this.store.transaction(() => {
      const call = this.get(id);
      this.bound(call);
      if (!['prepared', 'pending'].includes(call.state)) blocked();
      this.change(call, 'delivered');
    });
  }
  verify(resourceId: string, phase: Phase, input: unknown): Reply {
    const request = toolkitRequest(input),
      requestDigest = digest(request);
    const denied: Reply = { version: 1, phase, request_digest: requestDigest, decision: 'denied' };
    if (!['review', 'admit', 'dispatch'].includes(phase)) blocked();
    if (this.closing) return denied;
    return this.store.transaction(() => {
      const call = this.get(
        digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]),
      );
      if (
        call.resource_id !== resourceId ||
        call.request_digest !== requestDigest ||
        call.request_json !== canonical(request)
      )
        blocked();
      if (call.state !== 'delivered') return denied;
      this.bound(call);
      let decisionId: string | undefined;
      if (call.operation_id) {
        const op = this.managed.operation(call.operation_id),
          approval = this.managed.forOperation(op.id);
        this.operationCall(op);
        if (
          op.state !== 'prepared' ||
          approval.expires_at <= Date.now() ||
          approval.operation_digest !== op.operation_digest ||
          approval.policy_digest !== op.policy_digest
        )
          return denied;
        if (approval.state === 'pending')
          return phase === 'review' ? { ...denied, decision: 'pending' } : denied;
        if (approval.state !== 'decided' || approval.decision !== 'approve')
          return {
            ...denied,
            decision_id: digest({ approval: approval.id, revision: approval.revision }),
          };
        decisionId = digest({ approval: approval.id, revision: approval.revision });
      } else if (phase === 'review') return denied;
      if (phase === 'review') return { ...denied, decision: 'allowed', decision_id: decisionId! };
      const duration = this.options.authority.leaseWindow(
        call.session_id,
        request.root_digest,
        Math.min(90000, request.expires_at_ms - Date.now()),
      );
      if (phase === 'dispatch') {
        if (call.operation_id && !this.managed.takePermissionInTransaction(call.operation_id))
          return denied;
        this.change(call, 'dispatching');
      }
      return {
        ...denied,
        decision: 'allowed',
        authority_for_ms: duration,
        ...(phase === 'dispatch' ? { send_within_ms: Math.min(1000, duration) } : {}),
      };
    });
  }
  /** Lost/opaque outcomes fence the parent even if no response or reply was saved. */
  record(id: string, resourceId: string, input: unknown): ToolkitCall {
    const owner = this.get(id);
    if (owner.resource_id !== resourceId) blocked();
    try {
      return this.recordChecked(id, resourceId, input);
    } catch (error) {
      if (['delivered', 'dispatching'].includes(owner.state)) {
        this.options.resources.fence(resourceId);
        try {
          this.unknown(id);
        } catch {}
      }
      throw error;
    }
  }
  private recordChecked(id: string, resourceId: string, input: unknown): ToolkitCall {
    const receipt = object(input),
      encoded = canonical(receipt);
    if (
      Object.keys(receipt).some(
        (k) =>
          ![
            'id',
            'request_digest',
            'state',
            'decision_id',
            'result',
            'cancellation_requested',
          ].includes(k),
      ) ||
      Buffer.byteLength(encoded) > 270000 ||
      (receipt.decision_id !== undefined &&
        (typeof receipt.decision_id !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,128}$/.test(receipt.decision_id))) ||
      (receipt.cancellation_requested !== undefined &&
        typeof receipt.cancellation_requested !== 'boolean') ||
      (receipt.result !== undefined &&
        (receipt.state !== 'returned' ||
          typeof receipt.result !== 'string' ||
          Buffer.byteLength(receipt.result) > 262144)) ||
      (receipt.state === 'returned' && (typeof receipt.result !== 'string' || !receipt.result)) ||
      !['awaiting_decision', 'denied', 'cancelled', 'returned', 'outcome_unknown'].includes(
        String(receipt.state),
      )
    )
      blocked();
    return this.store.transaction(() => {
      const call = this.get(id),
        request = this.request(call);
      if (this.context(call) !== call.context_digest || request.approval !== !!call.operation_id)
        blocked();
      if (call.operation_id) this.operationCall(this.managed.operation(call.operation_id));
      else if (
        JSON.parse(call.action_pin).kind !== 'read' ||
        JSON.parse(call.action_pin).policy !== 'agent'
      )
        blocked();
      if (
        call.resource_id !== resourceId ||
        receipt.id !== call.id ||
        receipt.request_digest !== call.request_digest
      )
        blocked();
      if (!['delivered', 'dispatching'].includes(call.state)) {
        if (call.receipt_json === encoded) return call;
        blocked();
      }
      let next: ToolkitCall['state'] = 'outcome_unknown';
      if (call.state === 'delivered' && receipt.state === 'awaiting_decision' && call.operation_id)
        next = 'pending';
      else if (
        call.state === 'delivered' &&
        ['denied', 'cancelled'].includes(String(receipt.state))
      ) {
        next = receipt.state === 'denied' ? 'denied' : 'cancelled';
        if (call.operation_id) this.managed.mcpNotSentInTransaction(call.operation_id);
      } else if (call.state === 'dispatching' && receipt.state === 'returned') {
        if (call.operation_id)
          this.managed.permissionResultInTransaction(call.operation_id, true, receipt);
        else next = 'returned'; // Actual pinned native read, protocol data only.
      } else if (call.operation_id) this.managed.mcpUnknownInTransaction(call.operation_id);
      this.store.db.prepare('UPDATE toolkit_calls SET receipt_json=? WHERE id=?').run(encoded, id);
      this.change(call, next);
      return this.get(id);
    });
  }
  unknown(id: string): void {
    const call = this.get(id);
    if (!['delivered', 'dispatching'].includes(call.state)) return;
    this.options.resources.fence(call.resource_id);
    unknownToolkitCall(this.store, this.managed, call);
  }
  recover(): void {
    for (const row of this.store.db
      .prepare("SELECT id FROM toolkit_calls WHERE state IN ('delivered','dispatching')")
      .all())
      this.unknown(String(row.id));
  }
}

function unknownToolkitCall(store: Store, managed: ManagedWork, call: ToolkitCall): void {
  store.transaction(() => unknownToolkitCallInTransaction(store, managed, call));
}
function unknownToolkitCallInTransaction(
  store: Store,
  managed: ManagedWork,
  call: ToolkitCall,
): void {
  if (!store.db.isTransaction) throw Error('Native uncertainty requires a transaction');
  const current = store.db
    .prepare('SELECT * FROM toolkit_calls WHERE id=?')
    .get(call.id) as unknown as ToolkitCall;
  if (!['delivered', 'dispatching'].includes(current.state)) return;
  if (current.operation_id) managed.mcpUnknownInTransaction(current.operation_id);
  store.db
    .prepare("UPDATE toolkit_calls SET state='outcome_unknown',revision=revision+1 WHERE id=?")
    .run(current.id);
  store.event(current.session_id, 'toolkit.call.outcome_unknown', {
    call_id: current.id,
    attempt_id: current.attempt_id,
    operation_id: current.operation_id,
    request_digest: current.request_digest,
  });
}
/** Service recovery must fence calls even when no native profile/controller is
 * configured after a restart. Absence of a controller never erases ownership. */
export function recoverToolkitCalls(store: Store, managed: ManagedWork): void {
  for (const row of store.db
    .prepare("SELECT * FROM toolkit_calls WHERE state IN ('delivered','dispatching')")
    .all())
    unknownToolkitCall(store, managed, row as unknown as ToolkitCall);
}
export function cancelToolkitCalls(
  store: Store,
  managed: ManagedWork,
  attempt: string,
  resources: ToolkitResources,
): void {
  if (!store.db.isTransaction) throw Error('Native call cancellation requires a transaction');
  for (const row of store.db
    .prepare(
      "SELECT * FROM toolkit_calls WHERE attempt_id=? AND state IN ('prepared','pending','delivered','dispatching')",
    )
    .all(attempt)) {
    const call = row as unknown as ToolkitCall;
    resources.fence(call.resource_id);
    store.db.prepare('UPDATE toolkit_calls SET cancel_requested=1 WHERE id=?').run(call.id);
    if (['delivered', 'dispatching'].includes(call.state))
      unknownToolkitCallInTransaction(store, managed, call);
    else {
      if (call.operation_id) managed.mcpNotSentInTransaction(call.operation_id);
      store.db
        .prepare("UPDATE toolkit_calls SET state='cancelled',revision=revision+1 WHERE id=?")
        .run(call.id);
      store.event(call.session_id, 'toolkit.call.cancelled', {
        call_id: call.id,
        attempt_id: attempt,
        operation_id: call.operation_id,
        request_digest: call.request_digest,
      });
    }
  }
}
