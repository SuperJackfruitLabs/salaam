import { canonical, object, ServiceError } from '../core/index.js';
import type { AgentPodBinding } from '../core/index.js';

/** The AgentPod authority members toolkit work reads. The composition point passes AgentPod's
 * authority, which implements it. */
export interface ToolkitAuthority {
  bySession(session: string): { binding: string; digest: string; expires_at: number };
  binding(session: string): AgentPodBinding;
  leaseWindow(session: string, expectedBindingDigest: string, maximumMs: number): number;
}

export interface ToolkitRequest {
  version: 1;
  root_digest: string;
  invocation_id: string;
  profile_digest: string;
  service: string;
  action: string;
  args: Record<string, string>;
  approval: boolean;
  expires_at_ms: number;
}
export interface ToolkitControl {
  version: 1;
  action: 'inspect' | 'fence' | 'cancel' | 'acknowledge' | 'revoke';
  root_digest: string;
  profile_digest: string;
  invocation_id: string;
  request_digest: string;
  stop_proof_digest: string;
  decision_id: string;
}

/** Toolkit-owned supervisor control shape. A hash is not a stop receipt: the
 * private owner must confirm actual durable resource settlement and the exact
 * resolution decision, including when the old work authority has expired. */
export function toolkitControl(value: unknown): ToolkitControl {
  try {
    const c = object(value);
    const root = c.action === 'revoke';
    if (!['inspect', 'fence', 'cancel', 'acknowledge', 'revoke'].includes(String(c.action)))
      invalid();
    const out: ToolkitControl = {
      version: 1,
      action: c.action as ToolkitControl['action'],
      root_digest: hash(c.root_digest),
      profile_digest: hash(c.profile_digest),
      invocation_id: root ? '' : name(c.invocation_id),
      request_digest: root ? '' : hash(c.request_digest),
      stop_proof_digest: hash(c.stop_proof_digest),
      decision_id: c.action === 'acknowledge' ? name(c.decision_id) : '',
    };
    if (canonical(out) !== canonical(value) || Buffer.byteLength(canonical(out)) > 4096) invalid();
    return out;
  } catch {
    throw new ServiceError(
      'invalid_toolkit_control',
      'Unsupported managed Toolkit recovery control',
      400,
    );
  }
}
const nameShape = /^[A-Za-z0-9_.:-]{1,128}$/;
function invalid(): never {
  throw new ServiceError('invalid_toolkit_request', 'Unsupported managed Toolkit invocation', 400);
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !nameShape.test(value)) invalid();
  return value;
}

/** Canonical Toolkit-owned shape only; the caller must bind fresh root authority,
 * reviewed profile and exact operation bytes before issuing any broker grant. */
export function toolkitRequest(value: unknown): ToolkitRequest {
  try {
    const r = object(value),
      input = object(r.args);
    if (
      r.version !== 1 ||
      typeof r.approval !== 'boolean' ||
      !Number.isSafeInteger(r.expires_at_ms) ||
      Number(r.expires_at_ms) <= 0 ||
      Object.keys(input).length > 64
    )
      invalid();
    const args = Object.fromEntries(
      Object.entries(input).map(([key, value]) => {
        name(key);
        if (
          typeof value !== 'string' ||
          Buffer.byteLength(value) > 16384 ||
          Buffer.from(value).toString('utf8') !== value
        )
          invalid();
        return [key, value];
      }),
    );
    const out: ToolkitRequest = {
      version: 1,
      root_digest: hash(r.root_digest),
      invocation_id: name(r.invocation_id),
      profile_digest: hash(r.profile_digest),
      service: name(r.service),
      action: name(r.action),
      args,
      approval: r.approval,
      expires_at_ms: r.expires_at_ms as number,
    };
    if (canonical(out) !== canonical(value) || Buffer.byteLength(canonical(out)) > 65536) invalid();
    return out;
  } catch {
    invalid();
  }
}
