import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { ServiceError, object, canonical } from './protocol.js';
export function getClaudeModel(id: string) {
  return anthropicProvider()
    .getModels()
    .find((model) => model.id === id);
}

export interface ProviderRoute {
  provider: 'salaam-proof' | 'anthropic';
  model: string;
  max_tokens: number;
  workspace_id?: string;
}
export const OFFLINE_ROUTE: ProviderRoute = {
  provider: 'salaam-proof',
  model: 'scripted',
  max_tokens: 1024,
};
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5-5';
export function providerRoute(
  provider = 'offline',
  model?: string,
  maxTokens?: number,
  workspace?: string,
): ProviderRoute {
  if (provider === 'offline') {
    if (model || maxTokens || workspace)
      throw new ServiceError('invalid_provider', 'Offline mode does not take Claude options');
    return { ...OFFLINE_ROUTE };
  }
  if (provider !== 'anthropic')
    throw new ServiceError('invalid_provider', 'Provider must be offline or anthropic');
  const id = model ?? DEFAULT_CLAUDE_MODEL;
  if (!['claude-sonnet-5-5', 'claude-sonnet-4-6'].includes(id) || !getClaudeModel(id))
    throw new ServiceError(
      'invalid_model',
      'This route supports pinned claude-sonnet-5-5 or claude-sonnet-4-6',
    );
  const cap = maxTokens ?? 4096;
  if (!Number.isSafeInteger(cap) || cap < 128 || cap > 8192)
    throw new ServiceError('invalid_limit', 'Max output tokens must be 128–8192');
  if (workspace && !/^[a-zA-Z0-9_-]{1,128}$/.test(workspace))
    throw new ServiceError('invalid_workspace', 'Invalid Anthropic workspace ID');
  return {
    provider: 'anthropic',
    model: id,
    max_tokens: cap,
    ...(workspace ? { workspace_id: workspace } : {}),
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
