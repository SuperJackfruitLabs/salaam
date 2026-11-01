import type { Store } from '../store/store.js';
import type { ToolkitCall } from './calls.js';
import { toolkitRequest } from './protocol.js';
import { canonical, digest, object, ServiceError, textDigest } from '../core/protocol.js';

const hash = /^[a-f0-9]{64}$/;
const name = /^[A-Za-z0-9_.:-]{1,128}$/;
const states = [
  'prepared',
  'awaiting_decision',
  'approved',
  'denied',
  'claiming',
  'dispatching',
  'returned',
  'outcome_unknown',
  'outcome_acknowledged',
  'cancelled',
] as const;
const bindingKeys = [
  'root_digest',
  'profile_digest',
  'invocation_id',
  'receipt_id',
  'request_digest',
] as const;
export interface ToolkitEvidenceBinding {
  root_digest: string;
  profile_digest: string;
  invocation_id: string;
  receipt_id: string;
  request_digest: string;
}
export interface ToolkitEvidence extends ToolkitEvidenceBinding {
  version: 1;
  evidence_digest: string;
  state: (typeof states)[number];
  decision_id?: string;
  cancellation_requested: boolean;
  resolution_id?: string;
  resolution_stop_digest?: string;
  root_revoked: boolean;
  authority: false;
  product_effect_verified: false;
}
function invalid(): never {
  throw new ServiceError('invalid_execution_evidence', 'Toolkit evidence is inconsistent');
}

/** Native managed-evidence-v1 decoder. Matching hashes establish consistency,
 * never product-effect authenticity. Does not invoke Toolkit or grant authority. */
export function toolkitEvidence(value: unknown, expected: ToolkitEvidenceBinding): ToolkitEvidence {
  try {
    const e = object(value);
    const allowed = [
      'version',
      'evidence_digest',
      ...bindingKeys,
      'state',
      'decision_id',
      'cancellation_requested',
      'resolution_id',
      'resolution_stop_digest',
      'root_revoked',
      'authority',
      'product_effect_verified',
    ];
    if (
      Object.keys(e).some((k) => !allowed.includes(k)) ||
      e.version !== 1 ||
      e.authority !== false ||
      e.product_effect_verified !== false ||
      typeof e.root_revoked !== 'boolean' ||
      typeof e.cancellation_requested !== 'boolean' ||
      !states.includes(e.state as ToolkitEvidence['state']) ||
      typeof e.evidence_digest !== 'string' ||
      !hash.test(e.evidence_digest)
    )
      invalid();
    for (const key of bindingKeys) {
      if (
        typeof e[key] !== 'string' ||
        !(key === 'invocation_id' ? name : hash).test(e[key]) ||
        e[key] !== expected[key]
      )
        invalid();
    }
    if (
      e.receipt_id !== digest(['stk.managed-mcp.v1', e.root_digest, e.invocation_id]) ||
      (e.decision_id !== undefined &&
        (typeof e.decision_id !== 'string' || !name.test(e.decision_id)))
    )
      invalid();
    if (e.state === 'outcome_acknowledged') {
      if (
        typeof e.resolution_id !== 'string' ||
        !name.test(e.resolution_id) ||
        typeof e.resolution_stop_digest !== 'string' ||
        !hash.test(e.resolution_stop_digest)
      )
        invalid();
    } else if (e.resolution_id !== undefined || e.resolution_stop_digest !== undefined) invalid();
    const { evidence_digest, ...body } = e;
    if (digest(body) !== evidence_digest) invalid();
    return { ...e } as unknown as ToolkitEvidence;
  } catch {
    invalid();
  }
}

/** Projects only committed local history in the caller's SQLite snapshot.
 * Legacy or unresolved calls yield null. Private operator text, results, config,
 * and stop paths never leave this helper; no control or executor is invoked. */
export function committedToolkitResolutionEvidence(
  store: Store,
  callId: string,
  expectedRootDigest: string,
) {
  if (!store.db.isTransaction) throw Error('Evidence requires a consistent journal snapshot');
  const row = store.db
    .prepare("SELECT * FROM toolkit_resolutions WHERE call_id=? AND state='committed'")
    .get(callId);
  if (!row) return null;
  try {
    const call = store.db.prepare('SELECT * FROM toolkit_calls WHERE id=?').get(callId);
    if (!call) invalid();
    const c = call as unknown as ToolkitCall;
    const request = toolkitRequest(JSON.parse(c.request_json));
    const context = object(JSON.parse(String(row.context_json)));
    const boundCall = object(context.call);
    const input = object(JSON.parse(String(row.input_json)));
    const receipt = object(JSON.parse(String(row.native_receipt_json)));
    if (
      request.root_digest !== expectedRootDigest ||
      digest(context.binding) !== expectedRootDigest ||
      c.id !== digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]) ||
      c.request_digest !== digest(request) ||
      row.call_revision !== c.revision ||
      row.request_digest !== c.request_digest ||
      row.operation_id !== c.operation_id ||
      row.context_digest !== digest(context) ||
      row.id !== digest({ request: row.request_id, input, context }) ||
      boundCall.receipt_digest !== digest(c.receipt_json) ||
      !['succeeded', 'failed_definite'].includes(String(input.outcome)) ||
      typeof input.evidence !== 'string' ||
      !input.evidence ||
      input.evidence.length > 4096 ||
      receipt.id !== c.id ||
      receipt.request_digest !== c.request_digest ||
      !['returned', 'denied', 'cancelled', 'outcome_acknowledged'].includes(String(receipt.state))
    )
      invalid();
    for (const key of [
      'id',
      'session_id',
      'worker_epoch',
      'attempt_id',
      'tool_call_id',
      'resource_id',
      'request_digest',
      'context_digest',
      'action_pin',
      'request_json',
      'revision',
      'cancel_requested',
    ] as const) {
      if (boundCall[key] !== c[key]) invalid();
    }
    if (receipt.state === 'outcome_acknowledged') {
      if (
        receipt.resolution_id !== row.id ||
        receipt.resolution_stop_digest !== digest(context.stop)
      )
        invalid();
    } else if (receipt.resolution_id !== undefined || receipt.resolution_stop_digest !== undefined)
      invalid();
    return {
      resolution_id: String(row.id),
      call_revision: c.revision,
      request_digest: c.request_digest,
      source: 'operator-attestation' as const,
      outcome: input.outcome as 'succeeded' | 'failed_definite',
      evidence_digest: textDigest(input.evidence),
      native_state: String(receipt.state),
      native_receipt_digest: textDigest(canonical(receipt)),
      authority: false as const,
      product_effect_verified: false as const,
    };
  } catch {
    invalid();
  }
}
