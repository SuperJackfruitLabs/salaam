import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { operationBinding, type ManagedWork, type OperationResolution } from './managed.js';
import type { ToolkitResources } from './toolkit-resources.js';
import type { ToolkitOwners } from './toolkit-owners.js';
import { toolkitCallContext, type ToolkitCall } from './toolkit-calls.js';
import { toolkitRequest, type ToolkitControl } from './toolkit-protocol.js';
import { agentpodBinding } from './agentpod-protocol.js';
import { canonical, digest, object, ServiceError, type Operation } from './protocol.js';

type Outcome = 'succeeded' | 'failed_definite';
interface ReadResolution {
  kind: 'toolkit-read-resolution';
  id: string;
  revision: number;
  binding: string;
  outcome: Outcome;
  evidence: string;
}
type Input = OperationResolution | ReadResolution;
interface Intent {
  id: string;
  request_id: string;
  call_id: string;
  operation_id: string | null;
  call_revision: number;
  request_digest: string;
  context_json: string;
  context_digest: string;
  input_json: string;
  state: 'prepared' | 'native_settled' | 'committed';
  native_receipt_json: string | null;
  revision: number;
}
interface ControlRow {
  id: string;
  resolution_id: string;
  resource_id: string;
  control_json: string;
  result_json: string | null;
  state: 'prepared' | 'returned' | 'outcome_unknown';
}
function blocked(): never {
  throw new ServiceError(
    'toolkit_resolution_blocked',
    'Native Toolkit operator resolution is unavailable, stale or unconfirmed',
  );
}
function callRow(store: Store, id: string): ToolkitCall {
  const row = store.db.prepare('SELECT * FROM toolkit_calls WHERE id=?').get(id);
  if (!row) blocked();
  return row as unknown as ToolkitCall;
}
function validInput(request: string, input: Input): void {
  if (
    typeof request !== 'string' ||
    !request ||
    request.length > 128 ||
    !['succeeded', 'failed_definite'].includes(input.outcome) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(input.binding) ||
    typeof input.evidence !== 'string' ||
    !input.evidence ||
    input.evidence.length > 4096 ||
    Buffer.from(input.evidence).toString('utf8') !== input.evidence
  )
    blocked();
}
function snapshot(store: Store, resources: ToolkitResources, call: ToolkitCall, input: Input) {
  const request = toolkitRequest(JSON.parse(call.request_json)),
    resource = resources.get(call.resource_id),
    admission = resources.authority?.bySession(call.session_id);
  if (!admission) blocked();
  const binding = agentpodBinding(JSON.parse(admission.binding)),
    pin = object(JSON.parse(call.action_pin));
  if (
    call.state !== 'outcome_unknown' ||
    call.id !== digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]) ||
    call.request_digest !== digest(request) ||
    call.context_digest !== toolkitCallContext(call) ||
    resource.input_digest !== digest(JSON.parse(resource.spec)) ||
    resource.root_digest !== request.root_digest ||
    resource.profile_digest !== request.profile_digest ||
    resource.session_id !== call.session_id ||
    admission.digest !== request.root_digest ||
    digest(binding) !== request.root_digest ||
    admission.binding !== canonical(binding) ||
    request.approval !== !!call.operation_id
  )
    blocked();
  let operation: null | { id: string; revision: number; binding: string } = null;
  if (call.operation_id) {
    const op = store.db
      .prepare('SELECT * FROM operations WHERE id=?')
      .get(call.operation_id) as unknown as Operation | undefined;
    if (
      !op ||
      input.kind !== 'operation-resolution' ||
      input.id !== op.id ||
      input.revision !== op.revision ||
      input.binding !== op.operation_digest ||
      op.state !== 'outcome_unknown' ||
      op.kind !== 'mcp' ||
      operationBinding(op) !== op.operation_digest ||
      op.session_id !== call.session_id ||
      op.attempt_id !== call.attempt_id ||
      op.worker_epoch !== call.worker_epoch ||
      op.tool_call_id !== call.tool_call_id ||
      op.target !== 'toolkit/' + request.service + '/' + request.action ||
      op.value !== canonical(request.args) ||
      op.target_version !== call.context_digest
    )
      blocked();
    operation = { id: op.id, revision: op.revision, binding: op.operation_digest };
  } else if (
    input.kind !== 'toolkit-read-resolution' ||
    input.id !== call.id ||
    input.revision !== call.revision ||
    input.binding !== call.context_digest ||
    pin.kind !== 'read' ||
    pin.policy !== 'agent'
  )
    blocked();
  const stop = resources.stopProof(resource.id);
  return {
    version: 1,
    binding,
    call: {
      id: call.id,
      session_id: call.session_id,
      worker_epoch: call.worker_epoch,
      attempt_id: call.attempt_id,
      tool_call_id: call.tool_call_id,
      resource_id: call.resource_id,
      request_digest: call.request_digest,
      context_digest: call.context_digest,
      action_pin: call.action_pin,
      request_json: call.request_json,
      revision: call.revision,
      receipt_digest: digest(call.receipt_json),
      cancel_requested: call.cancel_requested,
    },
    resource: {
      id: resource.id,
      input_digest: resource.input_digest,
      profile_digest: resource.profile_digest,
      state_dir: resource.state_dir,
    },
    stop,
    operation,
  };
}
function intentRow(store: Store, id: string): Intent {
  const row = store.db.prepare('SELECT * FROM toolkit_resolutions WHERE id=?').get(id);
  if (!row) blocked();
  return row as unknown as Intent;
}
function validateIntent(store: Store, resources: ToolkitResources, intent: Intent): ToolkitCall {
  const input = object(JSON.parse(intent.input_json)) as unknown as Input;
  validInput(intent.request_id, input);
  const call = callRow(store, intent.call_id),
    context = snapshot(store, resources, call, input);
  if (
    intent.call_revision !== call.revision ||
    intent.operation_id !== call.operation_id ||
    intent.request_digest !== call.request_digest ||
    canonical(context) !== intent.context_json ||
    digest(context) !== intent.context_digest ||
    intent.id !== digest({ request: intent.request_id, input, context })
  )
    blocked();
  return call;
}
/** Invoked again by the actual cleanup role before OS spawn and at its native
 * callback. The immutable human intent alone cannot bypass process/job ownership. */
export function assertToolkitAcknowledgement(
  store: Store,
  resources: ToolkitResources,
  resourceId: string,
  control: ToolkitControl,
): void {
  const intent = intentRow(store, control.decision_id),
    call = validateIntent(store, resources, intent),
    request = toolkitRequest(JSON.parse(call.request_json));
  if (
    intent.state !== 'prepared' ||
    control.root_digest !== request.root_digest ||
    control.profile_digest !== request.profile_digest ||
    control.invocation_id !== request.invocation_id ||
    control.request_digest !== call.request_digest ||
    control.stop_proof_digest !== digest(resources.stopProof(call.resource_id))
  )
    blocked();
  // During preparation the resource does not exist yet. Every subsequent
  // launch/PID/callback check requires a durable exact job before any stdin.
  if (store.db.prepare('SELECT 1 FROM toolkit_resources WHERE id=?').get(resourceId)) {
    const job = store.db
      .prepare('SELECT * FROM toolkit_resolution_controls WHERE resource_id=?')
      .get(resourceId) as unknown as ControlRow | undefined;
    if (
      !job ||
      job.resolution_id !== intent.id ||
      job.control_json !== canonical(control) ||
      job.state !== 'prepared'
    )
      blocked();
  }
}
function receipt(value: unknown, call: ToolkitCall, intent: Intent): Record<string, unknown> {
  const r = object(value);
  if (
    Object.keys(r).some(
      (k) =>
        ![
          'id',
          'request_digest',
          'state',
          'decision_id',
          'result',
          'cancellation_requested',
          'resolution_id',
          'resolution_stop_digest',
        ].includes(k),
    ) ||
    r.id !== call.id ||
    r.request_digest !== call.request_digest ||
    Buffer.byteLength(canonical(r)) > 270000 ||
    typeof r.state !== 'string' ||
    (r.result !== undefined &&
      (typeof r.result !== 'string' ||
        Buffer.byteLength(r.result) > 262144 ||
        r.state !== 'returned')) ||
    (r.state === 'returned' && (typeof r.result !== 'string' || !r.result)) ||
    (r.cancellation_requested !== undefined && typeof r.cancellation_requested !== 'boolean') ||
    (r.decision_id !== undefined &&
      (typeof r.decision_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(r.decision_id)))
  )
    blocked();
  if (r.state === 'outcome_acknowledged') {
    if (
      r.resolution_id !== intent.id ||
      r.resolution_stop_digest !== digest(JSON.parse(intent.context_json).stop)
    )
      blocked();
  } else if (r.resolution_id !== undefined || r.resolution_stop_digest !== undefined) blocked();
  return r;
}
const terminal = new Set(['returned', 'denied', 'cancelled', 'outcome_acknowledged']);

/** Local operator attestation and native non-success acknowledgement are distinct
 * durable facts. No model/worker route creates these intents. Failed or interrupted
 * progress never clears the parent fence; reconnect resumes the same decision. */
export class ToolkitResolutions {
  private active = new Map<string, Promise<unknown>>();
  private closing = false;
  private unregister: () => void;
  constructor(
    readonly store: Store,
    readonly managed: ManagedWork,
    readonly resources: ToolkitResources,
    readonly owners: ToolkitOwners,
  ) {
    this.unregister = managed.registerMcpResolutionController('native-toolkit-operator', {
      owns: (op) => this.owns(op.id),
      assertResolution: (op, request, input) => this.commit(request, input, op),
    });
  }
  owns(operation: string): boolean {
    return !!this.store.db
      .prepare('SELECT 1 FROM toolkit_calls WHERE operation_id=?')
      .get(operation);
  }
  inspect(call: string): unknown {
    const current = callRow(this.store, call);
    const resolution =
      this.store.db
        .prepare(
          'SELECT id,request_id,input_json,state,native_receipt_json FROM toolkit_resolutions WHERE call_id=?',
        )
        .get(call) ?? null;
    return {
      call: {
        id: current.id,
        session_id: current.session_id,
        revision: current.revision,
        context_digest: current.context_digest,
        state: current.state,
        operation_id: current.operation_id,
      },
      resolution,
    };
  }
  async resolveOperation(
    id: string,
    request: string,
    revision: number,
    binding: string,
    outcome: Outcome,
    evidence: string,
  ): Promise<Operation> {
    const input: OperationResolution = {
      kind: 'operation-resolution',
      id,
      revision,
      binding,
      outcome,
      evidence,
    };
    validInput(request, input);
    const saved = this.store.cachedRequest('local-operator', request, input);
    if (saved !== undefined) return saved as Operation;
    const row = this.store.db.prepare('SELECT id FROM toolkit_calls WHERE operation_id=?').get(id);
    if (!row) blocked();
    return this.resolve(String(row.id), request, input) as Promise<Operation>;
  }
  async resolveRead(
    id: string,
    request: string,
    revision: number,
    binding: string,
    outcome: Outcome,
    evidence: string,
  ): Promise<unknown> {
    const input: ReadResolution = {
      kind: 'toolkit-read-resolution',
      id,
      revision,
      binding,
      outcome,
      evidence,
    };
    validInput(request, input);
    const saved = this.store.cachedRequest('local-operator', request, input);
    if (saved !== undefined) return saved;
    return this.resolve(id, request, input);
  }
  private async resolve(callId: string, request: string, input: Input): Promise<unknown> {
    if (this.closing) blocked();
    const saved = this.store.db
      .prepare('SELECT * FROM toolkit_resolutions WHERE request_id=? OR call_id=?')
      .all(request, callId) as unknown as Intent[];
    let intent: Intent;
    if (saved.length) {
      if (
        saved.length !== 1 ||
        saved[0]!.request_id !== request ||
        saved[0]!.call_id !== callId ||
        saved[0]!.input_json !== canonical(input)
      )
        throw new ServiceError(
          'request_conflict',
          'A different native resolution is already bound to this request or call',
        );
      intent = saved[0]!;
    } else {
      const call = callRow(this.store, callId);
      // Validate human revision/binding before signalling its owned process.
      if (input.kind === 'operation-resolution') {
        const op = this.managed.operation(input.id);
        if (
          op.state !== 'outcome_unknown' ||
          op.revision !== input.revision ||
          op.operation_digest !== input.binding ||
          operationBinding(op) !== input.binding ||
          call.operation_id !== op.id
        )
          blocked();
      } else if (
        call.operation_id ||
        call.revision !== input.revision ||
        call.context_digest !== input.binding ||
        call.state !== 'outcome_unknown'
      )
        blocked();
      await this.resources.stop(call.resource_id);
      intent = this.store.transaction(() => {
        const prior = this.store.db
          .prepare('SELECT * FROM toolkit_resolutions WHERE request_id=? OR call_id=?')
          .all(request, callId) as unknown as Intent[];
        if (prior.length) {
          if (
            prior.length !== 1 ||
            prior[0]!.request_id !== request ||
            prior[0]!.call_id !== callId ||
            prior[0]!.input_json !== canonical(input)
          )
            throw new ServiceError(
              'request_conflict',
              'A different native resolution is already bound to this request or call',
            );
          return prior[0]!;
        }
        const current = callRow(this.store, callId),
          context = snapshot(this.store, this.resources, current, input),
          id = digest({ request, input, context });
        this.store.db
          .prepare(
            'INSERT INTO toolkit_resolutions(id,request_id,call_id,operation_id,call_revision,request_digest,context_json,context_digest,input_json,state) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            id,
            request,
            current.id,
            current.operation_id,
            current.revision,
            current.request_digest,
            canonical(context),
            digest(context),
            canonical(input),
            'prepared',
          );
        this.store.event(call.session_id, 'toolkit.resolution.prepared', {
          call_id: call.id,
          resolution_id: id,
        });
        return intentRow(this.store, id);
      });
    }
    const prior = this.active.get(intent.id);
    if (prior) return prior;
    const task = this.progress(intent.id, input).finally(() => {
      this.active.delete(intent.id);
    });
    this.active.set(intent.id, task);
    return task;
  }
  private async control(
    intent: Intent,
    action: ToolkitControl['action'],
  ): Promise<Record<string, unknown>> {
    if (this.closing) blocked();
    const call = validateIntent(this.store, this.resources, intent),
      request = toolkitRequest(JSON.parse(call.request_json)),
      input: ToolkitControl = {
        version: 1,
        action,
        root_digest: request.root_digest,
        profile_digest: request.profile_digest,
        invocation_id: request.invocation_id,
        request_digest: call.request_digest,
        stop_proof_digest: digest(this.resources.stopProof(call.resource_id)),
        decision_id: action === 'acknowledge' ? intent.id : '',
      },
      admission = this.owners.cleanup(call.resource_id).materialize(this.resources),
      id = randomUUID(),
      process = this.resources.control(id, admission, input);
    let recorded = false;
    try {
      this.store.transaction(() =>
        this.store.db
          .prepare('INSERT INTO toolkit_resolution_controls VALUES(?,?,?,?,?,?)')
          .run(id, intent.id, id, canonical(input), null, 'prepared'),
      );
      recorded = true;
      this.owners.registerControl(id, admission);
      const result = await process.run();
      await this.resources.stop(id);
      const native = receipt(result.receipt, call, intent);
      this.store.transaction(() => {
        validateIntent(this.store, this.resources, intentRow(this.store, intent.id));
        this.store.db
          .prepare(
            "UPDATE toolkit_resolution_controls SET state='returned',result_json=? WHERE id=?",
          )
          .run(canonical(result), id);
      });
      return native;
    } catch (error) {
      if (recorded) {
        try {
          this.store.transaction(() =>
            this.store.db
              .prepare(
                "UPDATE toolkit_resolution_controls SET state='outcome_unknown' WHERE id=? AND state='prepared'",
              )
              .run(id),
          );
        } catch {}
      }
      throw error;
    } finally {
      await this.resources.stop(id);
    }
  }
  private async progress(id: string, input: Input): Promise<unknown> {
    let intent = intentRow(this.store, id);
    const call = validateIntent(this.store, this.resources, intent);
    // Stop every recorded old control before a fresh native inspection. Missing
    // PID or stop uncertainty prevents replacement, even after a free flock.
    for (const row of this.store.db
      .prepare('SELECT * FROM toolkit_resolution_controls WHERE resolution_id=? ORDER BY rowid')
      .all(id) as unknown as ControlRow[]) {
      await this.resources.stop(row.resource_id);
      if (row.state === 'prepared')
        this.store.transaction(() =>
          this.store.db
            .prepare("UPDATE toolkit_resolution_controls SET state='outcome_unknown' WHERE id=?")
            .run(row.id),
        );
    }
    if (intent.state === 'prepared') {
      let r = await this.control(intent, 'inspect');
      if (['claiming', 'dispatching'].includes(String(r.state)))
        r = await this.control(intent, 'fence');
      if (['prepared', 'awaiting_decision', 'approved'].includes(String(r.state)))
        r = await this.control(intent, 'cancel');
      if (r.state === 'outcome_unknown') r = await this.control(intent, 'acknowledge');
      if (!terminal.has(String(r.state))) blocked();
      this.store.transaction(() => {
        const current = intentRow(this.store, id);
        validateIntent(this.store, this.resources, current);
        this.store.db
          .prepare(
            "UPDATE toolkit_resolutions SET state='native_settled',native_receipt_json=?,revision=revision+1 WHERE id=?",
          )
          .run(canonical(r), id);
        this.store.event(call.session_id, 'toolkit.resolution.native_settled', {
          call_id: call.id,
          resolution_id: id,
          native_state: r.state,
        });
      });
    }
    if (this.closing) blocked();
    intent = intentRow(this.store, id);
    if (input.kind === 'operation-resolution')
      return this.managed.resolve(
        input.id,
        intent.request_id,
        input.revision,
        input.binding,
        input.outcome,
        input.evidence,
      );
    return this.store.request('local-operator', intent.request_id, input, () => {
      this.commit(intent.request_id, input);
      return {
        call_id: call.id,
        resolution_id: id,
        state: 'operator_attested',
        outcome: input.outcome,
        source: 'local-operator',
        evidence: input.evidence,
      };
    });
  }
  private commit(request: string, input: Input, op?: Operation): void {
    if (!this.store.db.isTransaction || this.closing) blocked();
    const row = this.store.db
      .prepare('SELECT * FROM toolkit_resolutions WHERE request_id=?')
      .get(request) as unknown as Intent | undefined;
    if (
      !row ||
      row.state !== 'native_settled' ||
      row.input_json !== canonical(input) ||
      (op && row.operation_id !== op.id)
    )
      blocked();
    const call = validateIntent(this.store, this.resources, row),
      native = receipt(JSON.parse(row.native_receipt_json!), call, row);
    if (!terminal.has(String(native.state))) blocked();
    for (const job of this.store.db
      .prepare('SELECT resource_id FROM toolkit_resolution_controls WHERE resolution_id=?')
      .all(row.id))
      this.resources.stopProof(String(job.resource_id));
    this.store.db
      .prepare("UPDATE toolkit_resolutions SET state='committed',revision=revision+1 WHERE id=?")
      .run(row.id);
    this.store.event(call.session_id, 'toolkit.resolution.committed', {
      call_id: call.id,
      resolution_id: row.id,
      operation_id: row.operation_id,
      outcome: input.outcome,
      source: 'operator-attestation',
    });
  }
  stop(): void {
    this.closing = true;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.active.values());
    this.unregister();
  }
}
