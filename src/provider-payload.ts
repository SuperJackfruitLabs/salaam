import { getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { canonical, object } from './protocol.js';
import { getProviderModel, validateClaudePayload } from './provider-config.js';
import type { ProviderRoute } from './provider-route.js';

const common = ['model', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'metadata'];
const allowedFields: Record<string, string[]> = {
  'anthropic-messages': [
    ...common,
    'messages',
    'system',
    'max_tokens',
    'betas',
    'thinking',
    'output_config',
    'top_k',
    'stop_sequences',
  ],
  'openai-completions': [
    ...common,
    'messages',
    'max_tokens',
    'max_completion_tokens',
    'store',
    'stream_options',
    'reasoning',
    'reasoning_effort',
    'thinking',
    'chat_template_args',
    'enable_thinking',
    'tool_stream',
    'prompt_cache_key',
    'prompt_cache_retention',
    'frequency_penalty',
    'presence_penalty',
    'repetition_penalty',
    'min_p',
    'top_k',
    'stop',
  ],
  'mistral-conversations': [
    ...common,
    'messages',
    'maxTokens',
    'max_tokens',
    'toolChoice',
    'reasoningEffort',
    'reasoning_effort',
    'promptMode',
    'prompt_mode',
    'promptCacheKey',
    'prompt_cache_key',
  ],
  'openai-responses': [
    ...common,
    'input',
    'store',
    'max_output_tokens',
    'include',
    'reasoning',
    'prompt_cache_key',
    'prompt_cache_options',
    'prompt_cache_retention',
    'service_tier',
    'text',
    'parallel_tool_calls',
    'instructions',
  ],
  'azure-openai-responses': [
    ...common,
    'input',
    'store',
    'max_output_tokens',
    'include',
    'reasoning',
    'prompt_cache_key',
    'service_tier',
    'text',
    'parallel_tool_calls',
  ],
  'openai-codex-responses': [
    ...common,
    'input',
    'store',
    'include',
    'reasoning',
    'prompt_cache_key',
    'service_tier',
    'text',
    'parallel_tool_calls',
    'instructions',
  ],
  'google-generative-ai': ['model', 'contents', 'config'],
  'google-vertex': ['model', 'contents', 'config'],
  'bedrock-converse-stream': [
    'modelId',
    'messages',
    'system',
    'inferenceConfig',
    'toolConfig',
    'additionalModelRequestFields',
    'requestMetadata',
  ],
  'pi-messages': ['model', 'context', 'options'],
};
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key) && value[key] !== undefined))
    throw new Error('Unsupported provider execution feature');
}
function cap(value: unknown, route: ProviderRoute) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > route.max_tokens)
    throw new Error('Unapproved provider output limit');
}
function inventory(
  values: unknown,
  names: string[],
  kind: 'function' | 'google' | 'bedrock' | 'pi',
) {
  if (!Array.isArray(values)) throw new Error('Provider tool inventory missing');
  const actual: string[] = [];
  for (const value of values) {
    const tool = object(value);
    if (kind === 'google') {
      if (
        Object.keys(tool).some((key) => key !== 'functionDeclarations') ||
        !Array.isArray(tool.functionDeclarations)
      )
        throw new Error('Provider server tools disabled');
      actual.push(...tool.functionDeclarations.map((entry) => String(object(entry).name)));
    } else if (kind === 'bedrock') {
      if (Object.keys(tool).some((key) => key !== 'toolSpec'))
        throw new Error('Provider server tools disabled');
      actual.push(String(object(tool.toolSpec).name));
    } else if (kind === 'function') {
      if (tool.type !== 'function') throw new Error('Provider server tools disabled');
      actual.push(String(tool.name ?? object(tool.function).name));
    } else actual.push(String(tool.name));
  }
  if (canonical(actual.sort()) !== canonical([...names].sort()))
    throw new Error('Unapproved provider tool inventory');
}
function lastText(messages: unknown, frame: string, parts: string, role = 'user') {
  if (!Array.isArray(messages) || !messages.length) throw new Error('Provider messages missing');
  const last = object(messages.at(-1));
  const content = last[parts];
  const blocks = Array.isArray(content)
    ? content.filter(
        (block) => !(Object.keys(object(block)).length === 1 && object(block).cachePoint),
      )
    : [];
  const text =
    typeof content === 'string' ? content : blocks.length ? object(blocks.at(-1)).text : undefined;
  if (last.role !== role || text !== frame)
    throw new Error('Required task context missing from provider payload');
}
/** Validate the API-specific payload after extension hooks. No hosted tools or hidden continuations. */
export function validateProviderPayload(
  value: unknown,
  route: ProviderRoute,
  frame: string,
  tools: string[],
  allowUncapped = false,
) {
  const p = object(value),
    api = getProviderModel(route)?.api;
  keys(p, allowedFields[String(api)] ?? []);
  for (const key of [
    'fallbacks',
    'fallback_models',
    'models',
    'route',
    'mcp_servers',
    'container',
    'context_management',
    'previous_response_id',
    'conversation',
    'background',
    'environment',
    'agents',
    'built_in_tools',
    'cachedContent',
  ])
    if (p[key] !== undefined && p[key] !== false)
      throw new Error('Unsupported provider execution feature');
  const deployment =
    route.provider === 'azure'
      ? (route.connection?.configuration.AZURE_OPENAI_DEPLOYMENT_NAME_MAP?.split(',')
          .map((entry) => entry.trim().split('='))
          .find(([id]) => id === route.model)?.[1]
          ?.trim() ?? route.model)
      : route.model;
  if (api === 'anthropic-messages') return validateClaudePayload(p, route, frame, tools);
  if (api === 'google-generative-ai' || api === 'google-vertex') {
    if (p.model !== deployment) throw new Error('Unapproved provider model');
    const config = object(p.config);
    keys(config, [
      'maxOutputTokens',
      'temperature',
      'topP',
      'topK',
      'systemInstruction',
      'tools',
      'toolConfig',
      'thinkingConfig',
      'abortSignal',
      'httpOptions',
    ]);
    if (
      config.httpOptions !== undefined &&
      canonical(config.httpOptions) !==
        canonical({ retryOptions: { attempts: 1 }, timeout: 120000 })
    )
      throw new Error('Unapproved Google HTTP controls');
    for (const key of ['cachedContent', 'automaticFunctionCalling', 'responseModalities'])
      if (config[key] !== undefined) throw new Error('Unsupported Google execution feature');
    cap(config.maxOutputTokens, route);
    lastText(p.contents, frame, 'parts');
    inventory(config.tools ?? [], tools, 'google');
  } else if (api === 'bedrock-converse-stream') {
    if (p.modelId !== route.model) throw new Error('Unapproved provider model');
    keys(object(p.inferenceConfig), ['maxTokens', 'temperature', 'topP', 'stopSequences']);
    keys(object(p.additionalModelRequestFields ?? {}), [
      'thinking',
      'reasoningConfig',
      'reasoning_effort',
      'reasoning',
      'output_config',
      'anthropic_beta',
    ]);
    cap(object(p.inferenceConfig).maxTokens, route);
    lastText(p.messages, frame, 'content');
    inventory(object(p.toolConfig).tools ?? [], tools, 'bedrock');
    if (p.guardrailConfig || p.promptVariables || p.performanceConfig)
      throw new Error('Unsupported Bedrock execution feature');
  } else if (api === 'pi-messages') {
    if (p.model !== deployment) throw new Error('Unapproved provider model');
    keys(object(p.options), [
      'temperature',
      'maxTokens',
      'reasoning',
      'cacheRetention',
      'sessionId',
      'toolChoice',
    ]);
    cap(object(p.options).maxTokens, route);
    const context = object(p.context);
    lastText(context.messages, frame, 'content');
    inventory(getCurrentTools((context as unknown as TranscriptContext).messages), tools, 'pi');
  } else if (
    ['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(String(api))
  ) {
    if (p.model !== deployment) throw new Error('Unapproved provider model');
    if (p.stream !== true) throw new Error('Provider streaming required');
    if (!allowUncapped || p.max_output_tokens !== undefined) cap(p.max_output_tokens, route);
    lastText(p.input, frame, 'content');
    inventory(p.tools ?? [], tools, 'function');
    if (p.store !== false) throw new Error('Provider storage disabled');
  } else if (api === 'openai-completions' || api === 'mistral-conversations') {
    if (p.model !== deployment || p.stream !== true) throw new Error('Unapproved provider model');
    cap(p.max_completion_tokens ?? p.max_tokens ?? p.maxTokens, route);
    lastText(p.messages, frame, 'content');
    inventory(p.tools ?? [], tools, 'function');
  } else throw new Error('Unsupported provider chat API');
}
