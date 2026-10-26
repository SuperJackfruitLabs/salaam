import { integer, object, ServiceError, string } from './protocol.js';
import { filePath } from './workspaces.js';

export interface TaskCheck {
  key: string;
  command: string;
  cwd: string;
}
export interface TaskLimits {
  /** Explicit opt-in for opaque runtimes. Omission never grants an invocation. */
  invocations?: number;
  requests: number;
  runtime_ms: number;
  concurrency: number;
  token_units: number | null;
  input_token_bound: number;
  output_token_bound: number | null;
  verification_runs: number;
}
/** Item 8: checks required at completion, next to the acceptance checks. The critic is not yet
 * admitted, so it is always null. */
export interface CompletionGate {
  critic: null;
  hooks: TaskCheck[];
}
export interface TaskPolicy {
  acceptance: TaskCheck[];
  deliverables: string[];
  limits: TaskLimits;
  /** Present only when the plan declares one, so a plan without it keeps its exact shape. */
  completion_gate?: CompletionGate;
}
/** Every check completion requires: the acceptance checks, then each hook as hook-<key>. */
export function requiredChecks(
  policy: Pick<TaskPolicy, 'acceptance' | 'completion_gate'>,
): TaskCheck[] {
  return [
    ...policy.acceptance,
    ...(policy.completion_gate?.hooks ?? []).map((h) => ({ ...h, key: 'hook-' + h.key })),
  ];
}
const check = (v: unknown, keys: Set<string>, what: string): TaskCheck => {
  const c = object(v),
    key = string(c.key, what + ' key', 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(key) || keys.has(key))
    throw new ServiceError('invalid_plan', what + ' keys must be unique identifiers', 400);
  keys.add(key);
  return {
    key,
    command: string(c.command, what + ' command', 4096),
    cwd: c.cwd === undefined || c.cwd === '.' ? '.' : filePath(c.cwd),
  };
};
export const DEFAULT_TASK_LIMITS: TaskLimits = {
  requests: 64,
  runtime_ms: 900000,
  concurrency: 3,
  token_units: 16777216,
  input_token_bound: 131072,
  output_token_bound: 8192,
  verification_runs: 32,
};
export function taskPolicy(value: Record<string, unknown>): TaskPolicy {
  const raw = value.acceptance ?? [];
  if (!Array.isArray(raw) || raw.length > 8)
    throw new ServiceError('invalid_plan', 'Supply at most eight acceptance checks', 400);
  const keys = new Set<string>();
  const acceptance = raw.map((v) => check(v, keys, 'Acceptance'));
  const paths = value.deliverables ?? [];
  if (!Array.isArray(paths) || paths.length > 32)
    throw new ServiceError('invalid_plan', 'Supply at most 32 deliverable paths', 400);
  const deliverables = paths.map(filePath);
  if (new Set(deliverables).size !== deliverables.length)
    throw new ServiceError('invalid_plan', 'Duplicate deliverable', 400);
  const input = value.limits === undefined ? {} : object(value.limits),
    limits = { ...DEFAULT_TASK_LIMITS };
  const max: TaskLimits = {
    requests: 1024,
    runtime_ms: 86400000,
    concurrency: 8,
    token_units: 1073741824,
    input_token_bound: 1048576,
    output_token_bound: 8192,
    verification_runs: 256,
  };
  // Explicit opt-out; omitted limits retain the existing capped defaults.
  if (input.token_units === null) {
    limits.token_units = null;
    if (input.output_token_bound === undefined) limits.output_token_bound = null;
  }
  for (const key of Object.keys(limits) as (keyof TaskLimits)[]) {
    if ((key === 'token_units' || key === 'output_token_bound') && input[key] === null) {
      limits[key] = null;
      continue;
    }
    if (input[key] !== undefined) limits[key] = integer(input[key], key);
    const bound = limits[key];
    if (bound !== null && bound !== undefined && (bound < 1 || bound > max[key]!))
      throw new ServiceError('invalid_budget', 'Task limit out of range: ' + key, 400);
  }
  if (limits.output_token_bound === null && limits.token_units !== null)
    throw new ServiceError('invalid_budget', 'A token budget requires an output token bound', 400);
  if (input.invocations !== undefined) {
    const n = integer(input.invocations, 'invocations');
    if (n < 1 || n > 64)
      throw new ServiceError('invalid_budget', 'Invocation limit must be 1–64', 400);
    limits.invocations = n;
  }
  let completion_gate: CompletionGate | undefined;
  if (value.completion_gate !== undefined) {
    const g = object(value.completion_gate);
    const hooks = g.hooks;
    if (
      Object.keys(g).sort().join(',') !== 'critic,hooks' ||
      g.critic !== null ||
      !Array.isArray(hooks) ||
      hooks.length < 1 ||
      hooks.length > 8
    )
      throw new ServiceError(
        'invalid_plan',
        'A completion gate has a null critic and 1–8 hooks',
        400,
      );
    const hookKeys = new Set<string>();
    completion_gate = { critic: null, hooks: hooks.map((v) => check(v, hookKeys, 'Hook')) };
    if (
      requiredChecks({ acceptance, completion_gate }).length !==
      new Set(requiredChecks({ acceptance, completion_gate }).map((c) => c.key)).size
    )
      throw new ServiceError('invalid_plan', 'A hook collides with an acceptance check', 400);
  }
  return { acceptance, deliverables, limits, ...(completion_gate ? { completion_gate } : {}) };
}
