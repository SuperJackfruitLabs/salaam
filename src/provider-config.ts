import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model, AuthResult } from '@earendil-works/pi-ai';
import { ServiceError, object, canonical } from './protocol.js';
import {
  OFFLINE_ROUTE,
  REASONING_LEVELS,
  type ProviderRoute,
  type ReasoningLevel,
} from './provider-route.js';
// Constructing the pinned catalog is offline; never refresh it implicitly during a turn.
export const PI_PROVIDERS = builtinProviders();
export function getProvider(id: string) {
  return PI_PROVIDERS.find((provider) => provider.id === id);
}
export function getProviderModel(
  route: Pick<ProviderRoute, 'provider' | 'model'>,
): Model<Api> | undefined {
  return getProvider(route.provider)
    ?.getModels()
    .find((model) => model.id === route.model);
}
export function getClaudeModel(id: string) {
  return getProviderModel({ provider: 'anthropic', model: id });
}
export const ROUTING_FIELDS = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
] as const;
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export function providerRoute(
  provider = 'offline',
  model?: string,
  maxTokens?: number,
  workspace?: string,
  connection?: ProviderRoute['connection'],
  reasoning?: ReasoningLevel,
): ProviderRoute {
  if (provider === 'offline') {
    if (model || maxTokens !== undefined || workspace || reasoning !== undefined)
      throw new ServiceError('invalid_provider', 'Offline mode does not take provider options');
    return { ...OFFLINE_ROUTE };
  }
  const catalog = getProvider(provider);
  if (!catalog)
    throw new ServiceError(
      'invalid_provider',
      'Provider must be offline or a pinned Pi provider; run salaam providers list',
    );
  const id = model ?? (provider === 'anthropic' ? DEFAULT_CLAUDE_MODEL : undefined);
  if (!id)
    throw new ServiceError('invalid_model', 'Select --model from salaam models list ' + provider);
  const entry = getProviderModel({ provider, model: id });
  if (!entry)
    throw new ServiceError(
      'invalid_model',
      'This route supports pinned Pi chat models; run salaam models list ' + provider,
    );
  if (
    reasoning !== undefined &&
    (!REASONING_LEVELS.includes(reasoning) || (reasoning !== 'off' && !entry.reasoning))
  )
    throw new ServiceError(
      'invalid_reasoning',
      'Reasoning level is invalid or the selected model does not support reasoning',
    );
  const cap = maxTokens ?? Math.min(4096, entry.maxTokens);
  if (!Number.isSafeInteger(cap) || cap < 128 || cap > Math.min(8192, entry.maxTokens))
    throw new ServiceError(
      'invalid_limit',
      'Max output tokens must be 128–' + Math.min(8192, entry.maxTokens),
    );
  if (reasoning && reasoning !== 'off' && cap < 2048)
    throw new ServiceError(
      'invalid_reasoning',
      'Reasoning requires an output allowance of at least 2,048 tokens',
    );
  if (workspace && (provider !== 'anthropic' || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspace)))
    throw new ServiceError('invalid_workspace', 'Invalid Anthropic workspace ID');
  if (connection) {
    if (
      Object.keys(connection).some((key) => !['endpoint', 'configuration'].includes(key)) ||
      Object.keys(connection.configuration).some(
        (key) => !ROUTING_FIELDS.includes(key as (typeof ROUTING_FIELDS)[number]),
      )
    )
      throw new ServiceError('invalid_provider', 'Unsupported provider configuration');
    const url = new URL(connection.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      Object.values(connection.configuration).some(
        (value) => typeof value !== 'string' || value.length > 4096 || /[^\x20-\x7e]/.test(value),
      )
    )
      throw new ServiceError('invalid_provider', 'Invalid provider connection');
  }
  return {
    provider,
    ...(reasoning !== undefined ? { reasoning } : {}),
    model: id,
    max_tokens: cap,
    ...(workspace ? { workspace_id: workspace } : {}),
    ...(connection ? { connection } : {}),
  };
}
/** Validate the final serialized HTTP payload, after all Pi payload hooks. */
export function validateClaudePayload(
  value: unknown,
  route: ProviderRoute,
  frame: string,
  tools: string[],
): void {
  const payload = object(value);
  if (
    payload.model !== route.model ||
    payload.stream !== true ||
    !Number.isSafeInteger(payload.max_tokens) ||
    Number(payload.max_tokens) < 1 ||
    Number(payload.max_tokens) > route.max_tokens
  )
    throw new Error('Unapproved Claude model or output limit');
  if (!Array.isArray(payload.messages) || !payload.messages.length)
    throw new Error('Claude messages missing');
  if (
    payload.messages.some(
      (message) => !['user', 'assistant'].includes(String(object(message).role)),
    )
  )
    throw new Error('Inline Claude system/tool controls are disabled');
  const last = object(payload.messages.at(-1));
  const content = last.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? object(content.at(-1)).text
        : null;
  if (last.role !== 'user' || text !== frame)
    throw new Error('Required task context missing from Claude payload');
  if (!Array.isArray(payload.tools)) throw new Error('Claude tool inventory missing');
  const names = payload.tools.map((value) => String(object(value).name)).sort();
  if (
    canonical(names) !== canonical([...tools].sort()) ||
    payload.tools.some(
      (value) => object(value).type !== undefined && object(value).type !== 'custom',
    )
  )
    throw new Error('Unapproved Claude tool inventory');
  // No server-side tools, model fallbacks or provider-managed agents may bypass Salaam.
  for (const key of [
    'fallbacks',
    'fallback_models',
    'mcp_servers',
    'container',
    'context_management',
  ])
    if (payload[key] !== undefined) throw new Error('Unsupported Claude execution feature');
}

export function providerHasOutputCap(route: ProviderRoute, auth: AuthResult): boolean {
  const model = getProviderModel(route);
  return (
    model?.api !== 'openai-codex-responses' &&
    !(
      model?.compat &&
      'supportsMaxOutputTokens' in model.compat &&
      model.compat.supportsMaxOutputTokens === false
    ) &&
    !(route.provider === 'openai' && !!auth.auth.apiKey && !auth.auth.apiKey.startsWith('sk-'))
  );
}
