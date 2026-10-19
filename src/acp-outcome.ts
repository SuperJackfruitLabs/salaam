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
    name === 'salaam_command'
      ? ['start', 'cancel'].includes(action)
        ? 'execute'
        : ['status', 'logs'].includes(action)
          ? 'read'
          : 'other'
      : name === 'salaam_files' && action === 'patch'
        ? args.content === null
          ? 'delete'
          : 'edit'
        : ['salaam_files', 'salaam_repository'].includes(name) &&
            ['search', 'list'].includes(action)
          ? 'search'
          : ['salaam_files', 'salaam_repository'].includes(name) &&
              ['read', 'inspect', ...(name === 'salaam_repository' ? ['diff'] : [])].includes(
                action,
              )
            ? 'read'
            : ['salaam_history', 'inspect_child', 'consume_child_result'].includes(name)
              ? 'read'
              : 'other';
  const locations: { path: string; line?: number }[] = [];
  if (
    name === 'salaam_files' &&
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
