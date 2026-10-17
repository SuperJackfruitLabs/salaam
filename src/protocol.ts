import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = [
  'persistent-session',
  'managed-policy',
  'task-context',
  'provider-admission',
] as const;
export const TOOLS = ['salaam_probe'] as const;
export type WorkerState = 'stopped' | 'starting' | 'ready' | 'unhealthy' | 'exited';
export interface Session {
  id: string;
  cwd: string;
  revision: number;
  state: WorkerState;
  epoch: number;
  pi_session_id: string;
  pi_session_file: string | null;
  pi_cursor: string | null;
  pi_leaf: string | null;
  error: string | null;
  capabilities: string[];
  seq: number;
}
export interface DurableEvent {
  schema_version: 1;
  event_id: string;
  session_id: string;
  seq: number;
  kind: string;
  causation_id: string | null;
  payload: unknown;
}
export interface Manifest {
  protocol_version: number;
  bundle_digest: string;
  policy_digest: string;
  session_id: string;
  pi_session_id: string;
  epoch: number;
  capabilities: string[];
  tools: string[];
  active_tools: string[];
  provider: string;
  context_digest: string;
}
export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    throw new ServiceError('invalid_json', 'Value is not canonical JSON', 400);
  return JSON.stringify(value);
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function textDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ServiceError('invalid_body', 'Expected an object', 400);
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new ServiceError('invalid_field', `Invalid ${name}`, 400);
  return value;
}
export function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ServiceError('invalid_field', `Invalid ${name}`, 400);
  return value as number;
}
