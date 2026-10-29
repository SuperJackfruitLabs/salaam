import { isAbsolute, resolve, sep } from 'node:path';
import { ServiceError } from './protocol.js';
import type { ProviderRoute } from './provider-config.js';

export type FailureKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'bad_request'
  | 'context_exhausted'
  | 'timeout'
  | 'provider_unavailable'
  | 'refusal'
  | 'max_tokens'
  | 'cancelled'
  | 'node_offline'
  | 'harness_exited'
  | 'harness_disconnected'
  | 'unknown';
export interface AcpFailure {
  version: 1;
  kind: FailureKind;
  code: string;
  message: string;
  sessionId?: string;
  requestId?: string;
  attemptId?: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable?: boolean;
  truncated?: boolean;
}
export interface AttemptOutcome {
  version: 1;
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'error' | 'interrupted';
  failure?: AcpFailure;
}
export class AcpFailureError extends Error {
  constructor(readonly failure: AcpFailure) {
    super(failure.message);
  }
}
export function parseAcpFailure(value: unknown): AcpFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  const fields = [
    'version',
    'kind',
    'code',
    'message',
    'sessionId',
    'requestId',
    'attemptId',
    'provider',
    'model',
    'httpStatus',
    'retryable',
    'truncated',
  ];
  const kinds = [
    'quota',
    'rate_limit',
    'auth',
    'bad_request',
    'context_exhausted',
    'timeout',
    'provider_unavailable',
    'refusal',
    'max_tokens',
    'cancelled',
    'node_offline',
    'harness_exited',
    'harness_disconnected',
    'unknown',
  ];
  if (
    Object.keys(v).some((k) => !fields.includes(k)) ||
    v.version !== 1 ||
    !kinds.includes(String(v.kind)) ||
    typeof v.code !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(v.code) ||
    typeof v.message !== 'string' ||
    !v.message.length ||
    v.message.length > 16384
  )
    return;
  for (const [key, max] of [
    ['sessionId', 128],
    ['attemptId', 128],
    ['requestId', 128],
    ['provider', 128],
    ['model', 256],
  ] as const)
    if (
      v[key] !== undefined &&
      (typeof v[key] !== 'string' || !(v[key] as string).length || (v[key] as string).length > max)
    )
      return;
  for (const key of ['sessionId', 'attemptId'])
    if (
      v[key] !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(v[key]))
    )
      return;
  if (
    v.httpStatus !== undefined &&
    (!Number.isInteger(v.httpStatus) || Number(v.httpStatus) < 100 || Number(v.httpStatus) > 599)
  )
    return;
  for (const k of ['retryable', 'truncated'])
    if (v[k] !== undefined && typeof v[k] !== 'boolean') return;
  return v as unknown as AcpFailure;
}
export function credentialStrings(value: unknown): string[] {
  if (typeof value === 'string') return value.length >= 8 ? [value] : [];
  return value && typeof value === 'object' ? Object.values(value).flatMap(credentialStrings) : [];
}
export function providerRefusalEvent(api: string, value: unknown): boolean {
  const r = (v: unknown): Record<string, any> =>
    v && typeof v === 'object' ? (v as Record<string, any>) : {};
  const e = r(value);
  if (api === 'anthropic-messages') return r(e.delta).stop_reason === 'refusal';
  if (api === 'google-generative-ai' || api === 'google-vertex')
    return (
      Array.isArray(e.candidates) &&
      e.candidates.some((c: unknown) =>
        ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII'].includes(
          r(c).finishReason,
        ),
      )
    );
  if (api === 'bedrock-converse-stream')
    return ['guardrail_intervened', 'content_filtered'].includes(r(e.messageStop).stopReason);
  if (api === 'openai-completions')
    return (
      Array.isArray(e.choices) &&
      e.choices.some(
        (c: unknown) => r(c).finish_reason === 'content_filter' || !!r(r(c).delta).refusal,
      )
    );
  if (['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(api))
    return (
      ['response.refusal.delta', 'response.refusal.done'].includes(e.type) ||
      (Array.isArray(r(e.response).output) &&
        r(e.response).output.some(
          (o: unknown) =>
            Array.isArray(r(o).content) &&
            r(o).content.some((p: unknown) => r(p).type === 'refusal'),
        ))
    );
  return false;
}
export function redactFailureText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
  return text.slice(0, 16384);
}
const TYPES: Record<string, FailureKind> = {
  authentication_error: 'auth',
  invalid_api_key: 'auth',
  insufficient_quota: 'quota',
  billing_error: 'quota',
  rate_limit_error: 'rate_limit',
  rate_limit_exceeded: 'rate_limit',
  context_length_exceeded: 'context_exhausted',
  overloaded_error: 'provider_unavailable',
  api_error: 'provider_unavailable',
  invalid_request_error: 'bad_request',
  permission_error: 'auth',
};
export function providerOutcome(
  reason: string,
  raw: string,
  route: ProviderRoute,
  status?: number,
  secrets: string[] = [],
): AttemptOutcome {
  if (!['error', 'aborted', 'length', 'refusal'].includes(reason))
    return { version: 1, stopReason: 'end_turn' };
  const match = /^(?:Error:\s*)?(\d{3})\b/.exec(raw) ?? /\(HTTP (\d{3})\)/.exec(raw);
  status ??= match ? Number(match[1]) : undefined;
  if (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
    status = undefined;
  let type: string | undefined, detail: string | undefined;
  const at = raw.indexOf('{');
  if (at >= 0) {
    try {
      const payload = JSON.parse(raw.slice(at));
      const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
      type =
        typeof error.type === 'string'
          ? error.type
          : typeof error.code === 'string'
            ? error.code
            : undefined;
      if (typeof error.message === 'string' && !secrets.some((s) => s && error.message.includes(s)))
        detail = redactFailureText(error.message, secrets);
    } catch {
      /* Unstructured provider bodies never become protocol metadata. */
    }
  }
  const kind: FailureKind =
    reason === 'length'
      ? 'max_tokens'
      : reason === 'refusal'
        ? 'refusal'
        : reason === 'aborted'
          ? 'unknown'
          : (type && TYPES[type]) ||
            (
              {
                400: 'bad_request',
                401: 'auth',
                402: 'quota',
                403: 'auth',
                408: 'timeout',
                413: 'context_exhausted',
                429: 'rate_limit',
                500: 'provider_unavailable',
                502: 'provider_unavailable',
                503: 'provider_unavailable',
                504: 'timeout',
              } as Record<number, FailureKind>
            )[status ?? 0] ||
            'unknown';
  const stopReason =
    reason === 'length'
      ? 'max_tokens'
      : reason === 'refusal'
        ? 'refusal'
        : reason === 'aborted'
          ? 'interrupted'
          : 'error';
  const fallback =
    reason === 'length'
      ? 'Provider reached its output limit'
      : reason === 'refusal'
        ? 'Provider refused this request'
        : reason === 'aborted'
          ? 'Provider request interrupted'
          : `Provider request failed${status ? ` (HTTP ${status})` : ''}`;
  // Unknown provider bodies may echo secrets that were never part of our auth
  // result (for example an unauthenticated gateway's upstream diagnostics).
  // Preserve explanatory text only for a recognized structured error type.
  const message = (type && TYPES[type] ? detail : undefined) || fallback;
  return {
    version: 1,
    stopReason,
    failure: {
      version: 1,
      kind,
      code:
        reason === 'aborted'
          ? 'provider_interrupted'
          : kind === 'unknown'
            ? 'provider_error'
            : 'provider_' + kind,
      message,
      provider: route.provider,
      model: route.model,
      ...(status ? { httpStatus: status } : {}),
      ...(kind === 'unknown'
        ? {}
        : { retryable: ['rate_limit', 'provider_unavailable', 'timeout'].includes(kind) }),
    },
  };
}
export function acpFailure(
  error: unknown,
  context: Partial<Pick<AcpFailure, 'sessionId' | 'requestId' | 'attemptId'>> = {},
): AcpFailure {
  if (error instanceof AcpFailureError) return { ...error.failure, ...context };
  const code =
    error instanceof ServiceError && /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : 'adapter_error';
  const kind: FailureKind = [
    'authority_expired',
    'session_revoked',
    'attempt_cancelled',
    'prompt_cancelled',
  ].includes(code)
    ? 'cancelled'
    : ['unauthorized', 'control_required'].includes(code)
      ? 'auth'
      : [
            'invalid_field',
            'invalid_json',
            'request_conflict',
            'reserved_command',
            'invalid_continuation',
          ].includes(code)
        ? 'bad_request'
        : 'unknown';
  const raw = error instanceof Error ? error.message : 'Adapter request failed';
  return {
    version: 1,
    kind,
    code,
    message: redactFailureText(raw) || 'Adapter request failed',
    ...context,
    ...(raw.length > 16384 ? { truncated: true } : {}),
    ...(kind === 'unknown' ? {} : { retryable: false }),
  };
}
/** ACP tool kind for an approval, so a client's modes can tell edits apart:
 * AgentPod's accept-edits approves only kind "edit"; full-auto approves all; ask none. */
export function permissionKind(operationKind: string): 'edit' | 'execute' | 'other' {
  if (operationKind === 'workspace') return 'edit';
  if (operationKind === 'harness') return 'execute';
  return 'other';
}
/** An operator MCP catalog read is a read; a server's `fetch` tool is a fetch; others stay other. */
function operatorMcpKind(action: string, tool: unknown): string {
  if (action === 'catalog') return 'read';
  return action === 'call' && tool === 'fetch' ? 'fetch' : 'other';
}

function toolArgs(input: unknown): Record<string, unknown> {
  try {
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (value && typeof value === 'object' && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  return {};
}

const label = (v: unknown) => (typeof v === 'string' && /^[\w.-]{1,128}$/.test(v) ? v : undefined);

/** One line of what a tool acted on, for a card title: no control characters, at most `max`. */
function shown(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
/** A URL as host and path only: never its login, query or fragment (they may carry a secret). */
function shownUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return undefined;
  }
}
const titled = (verb: string, what: string | undefined) => {
  if (!what) return verb;
  const t = `${verb}: ${what}`;
  return t.length > 80 ? t.slice(0, 79) + '…' : t;
};

/**
 * The ACP title for a tool call, the way a board agent's card reads: the tool and what it acted on
 * ("fetch: host/path", "write: runs/r/answer.md"). Every operator MCP call goes through one wrapper
 * tool, so it is titled by the MCP tool itself. Only plain identifiers, URL host and path, paths,
 * queries and commands are echoed, clipped to one line of 80 characters.
 */
/** A clipped input no longer parses: read the leading plain string fields it still carries. */
function clippedArgs(input: unknown): Record<string, unknown> {
  if (typeof input !== 'string') return {};
  const out: Record<string, unknown> = {};
  for (const key of [
    'action',
    'path',
    'query',
    'pattern',
    'command',
    'server',
    'tool',
    'item_id',
  ]) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,512})"`).exec(input);
    if (m) {
      try {
        out[key] = JSON.parse(`"${m[1]}"`);
      } catch {}
    }
  }
  // A clipped patch is a long one, so a write: a delete (content null) is short and never clipped.
  return out;
}

export function toolTitle(name: string, input: unknown): string {
  const parsed = toolArgs(input);
  const args = Object.keys(parsed).length ? parsed : clippedArgs(input);
  const action = typeof args.action === 'string' ? args.action : '';
  if (name === 'salaam_operator_mcp') {
    const server = label(args.server);
    const tool = label(args.tool);
    if (action === 'call' && server && tool) {
      const a = toolArgs(args.arguments);
      return titled(tool, shownUrl(a.url) ?? shown(a.query ?? a.path ?? a.pattern, 80));
    }
    if (action === 'catalog') return titled('MCP catalog', server);
    if (action === 'call') return titled('MCP call', server ?? tool);
    return 'Operator MCP';
  }
  if (name === 'salaam_board') {
    if (action === 'card') return 'read this card';
    if (action === 'attempts') return 'read this card’s runs';
    if (action === 'library_search') return titled('library_search', shown(args.query, 80));
    if (action === 'library_get') return titled('library_get', shown(args.item_id, 32));
    return name;
  }
  if (['salaam_station', 'salaam_files', 'salaam_repository'].includes(name)) {
    if (action === 'patch')
      return titled(args.content === null ? 'delete' : 'write', shown(args.path, 80));
    if (action === 'inspect' && args.path === undefined) return 'inspect workspace';
    if (action === 'check') return titled('check', shown(args.command, 80));
    if (['read', 'list', 'inspect', 'diff'].includes(action))
      return titled(action, shown(args.path, 80));
    if (action === 'search') return titled('search', shown(args.query ?? args.pattern, 80));
    if (action) return action;
  }
  return name;
}

export function toolMetadata(
  name: string,
  input: unknown,
  root?: string,
): { kind: string; locations: { path: string; line?: number }[] } {
  let args: Record<string, unknown> = {};
  try {
    const value = typeof input === 'string' ? JSON.parse(input) : input;
    if (value && typeof value === 'object' && !Array.isArray(value)) args = value;
  } catch {}
  const action = String(args.action ?? '');
  const kind =
    name === 'salaam_board'
      ? 'read'
      : name === 'salaam_command' || (name === 'salaam_station' && action === 'check')
        ? ['start', 'cancel', 'check'].includes(action)
          ? 'execute'
          : ['status', 'logs'].includes(action)
            ? 'read'
            : 'other'
        : ['salaam_files', 'salaam_station'].includes(name) && action === 'patch'
          ? args.content === null
            ? 'delete'
            : 'edit'
          : ['salaam_files', 'salaam_repository', 'salaam_station'].includes(name) &&
              ['search', 'list'].includes(action)
            ? 'search'
            : ['salaam_files', 'salaam_repository', 'salaam_station'].includes(name) &&
                ['read', 'inspect', ...(name === 'salaam_repository' ? ['diff'] : [])].includes(
                  action,
                )
              ? 'read'
              : ['salaam_history', 'inspect_child', 'consume_child_result'].includes(name)
                ? 'read'
                : name === 'salaam_operator_mcp'
                  ? operatorMcpKind(action, args.tool)
                  : 'other';
  const locations: { path: string; line?: number }[] = [];
  if (
    ['salaam_files', 'salaam_station'].includes(name) &&
    root &&
    isAbsolute(root) &&
    typeof args.path === 'string' &&
    args.path &&
    !isAbsolute(args.path) &&
    !/[\\\0]/.test(args.path) &&
    !args.path.split('/').some((p) => ['..', '.git', ''].includes(p))
  ) {
    const path = resolve(root, args.path);
    if (path.startsWith(root.replace(/\/$/, '') + sep)) locations.push({ path });
  }
  return { kind, locations };
}

/** A durable task's steps as the ACP `plan` session update: the whole list, replaced on every
 * change (https://agentclientprotocol.com/protocol/agent-plan). ACP has only pending,
 * in_progress and completed, so a step that stopped says so in its text instead. */
export function planUpdate(
  task: { steps: { title: string; state: string }[] } | null | undefined,
): {
  sessionUpdate: 'plan';
  entries: { content: string; priority: 'medium'; status: string }[];
} | null {
  if (!task?.steps.length) return null;
  return {
    sessionUpdate: 'plan',
    entries: task.steps.map((step) => {
      const status =
        step.state === 'completed'
          ? 'completed'
          : step.state === 'running' || step.state === 'awaiting_review'
            ? 'in_progress'
            : 'pending';
      const stopped = ['cancelled', 'failed', 'interrupted'].includes(step.state);
      return {
        content: stopped ? `${step.title} (${step.state})` : step.title,
        priority: 'medium' as const,
        status,
      };
    }),
  };
}
