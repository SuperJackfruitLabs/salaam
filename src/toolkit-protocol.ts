import { canonical, object, ServiceError } from './protocol.js';

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
