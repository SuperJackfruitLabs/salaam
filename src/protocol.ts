import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 1;
export const CAPABILITIES = [
  'persistent-session',
  'managed-policy',
  'task-context',
  'provider-admission',
  'durable-approvals',
  'operation-ledger',
  'child-work',
  'usage-ledger',
] as const;
export const TOOLS = [
  'salaam_probe',
  'salaam_review',
  'spawn_child',
  'inspect_child',
  'consume_child_result',
] as const;
export function workerTools(effects: boolean, child = false): string[] {
  return child ? ['salaam_probe'] : [...TOOLS, ...(effects ? ['salaam_effect'] : [])].sort();
}
export interface ChildTask {
  id: string;
  parent_session: string;
  parent_attempt: string;
  step_key: string;
  input_digest: string;
  child_session: string;
  child_attempt: string;
  authority: string;
  budget: number;
  state: 'accepted' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  result_id: string | null;
  artifact_id: string | null;
  acknowledged: number;
}
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
export type AttemptState =
  'accepted' | 'dispatching' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface Attempt {
  id: string;
  session_id: string;
  submission_id: string;
  state: AttemptState;
  worker_epoch: number | null;
  error: string | null;
  result: string | null;
  continues_attempt_id: string | null;
  resolved_by: string | null;
}
export interface Submission {
  id: string;
  session_id: string;
  text: string;
  state: AttemptState;
  attempt_id: string;
}
export interface ControlView {
  client_id: string | null;
  epoch: number;
  expires_at: number;
}
export interface ControlLease extends ControlView {
  token: string;
}
export interface Controller {
  client_id: string;
  token: string;
}
export interface SessionSnapshot extends Session {
  control: ControlView;
  attempts: (Attempt & { result_truncated: boolean })[];
  submissions: (Submission & { text_truncated: boolean })[];
  messages: { entry_id: string; role: string; text: string; truncated: boolean }[];
  history_truncated: boolean;
  approvals: Approval[];
  operations: Operation[];
  children: ChildTask[];
}
export type OperationState =
  | 'prepared'
  | 'dispatching'
  | 'succeeded'
  | 'failed_definite'
  | 'outcome_unknown'
  | 'cancelled_before_dispatch';
export interface Operation {
  id: string;
  session_id: string;
  attempt_id: string;
  worker_epoch: number;
  tool_call_id: string;
  kind: 'review' | 'effect';
  action_key: string;
  argument_digest: string;
  operation_digest: string;
  target: string;
  value: string;
  target_version: string;
  policy_digest: string;
  connector: string;
  replay: 'lookup' | 'opaque' | 'read-only';
  revision: number;
  state: OperationState;
  receipt: string | null;
  error: string | null;
  resolution: string | null;
  value_truncated?: boolean;
  receipt_available?: boolean;
}
export interface Approval {
  id: string;
  operation_id: string;
  session_id: string;
  worker_epoch: number;
  operation_digest: string;
  revision: number;
  actor_scope: string;
  policy_digest: string;
  expires_at: number;
  state: 'pending' | 'decided' | 'expired' | 'invalidated';
  decision: 'approve' | 'deny' | null;
  decided_by: string | null;
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
