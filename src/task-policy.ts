import { integer, object, ServiceError, string } from './protocol.js';
import { filePath } from './workspaces.js';
import type { TaskCheck, TaskLimits, CompletionGate, TaskPolicy } from './records.js';

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
    const c = g.critic;
    const critic =
      c === null
        ? null
        : (() => {
            const v = object(c);
            if (Object.keys(v).join(',') !== 'rubric')
              throw new ServiceError('invalid_plan', 'A critic names only its rubric', 400);
            return { rubric: string(v.rubric, 'critic rubric', 4096) };
          })();
    if (
      Object.keys(g).sort().join(',') !== 'critic,hooks' ||
      !Array.isArray(hooks) ||
      hooks.length > 8 ||
      (!critic && hooks.length < 1)
    )
      throw new ServiceError(
        'invalid_plan',
        'A completion gate has a critic or 1–8 hooks, and at most 8 hooks',
        400,
      );
    const hookKeys = new Set<string>();
    completion_gate = { critic, hooks: hooks.map((v) => check(v, hookKeys, 'Hook')) };
    if (
      requiredChecks({ acceptance, completion_gate }).length !==
      new Set(requiredChecks({ acceptance, completion_gate }).map((c) => c.key)).size
    )
      throw new ServiceError('invalid_plan', 'A hook collides with an acceptance check', 400);
  }
  return { acceptance, deliverables, limits, ...(completion_gate ? { completion_gate } : {}) };
}
