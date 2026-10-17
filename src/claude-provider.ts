import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderHeaders,
} from '@earendil-works/pi-ai';
import { streamSimple as streamClaude } from '@earendil-works/pi-ai/api/anthropic-messages';
import { randomUUID } from 'node:crypto';
import { digest, textDigest } from './protocol.js';
import { getClaudeModel, validateClaudePayload, type ProviderRoute } from './provider-config.js';

export function registerClaude(
  pi: ExtensionAPI,
  route: ProviderRoute,
  frame: () => string,
  tools: string[],
  bridge: (method: string, data: unknown) => Promise<unknown>,
  fail: () => Promise<void>,
): void {
  const catalog = getClaudeModel(route.model);
  if (!catalog) throw new Error('Pinned Claude model missing');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Claude API key unavailable to worker');
  pi.registerProvider('anthropic', {
    baseUrl: 'https://api.anthropic.com',
    apiKey: '$ANTHROPIC_API_KEY',
    api: 'anthropic-messages',
    models: [{ ...catalog, maxTokens: route.max_tokens }],
    streamSimple(model, context, options) {
      const output = createAssistantMessageEventStream();
      const source = 'salaam-request:' + randomUUID();
      let dispatched = false,
        gateFailed = false,
        status: number | undefined;
      let last: AssistantMessage | undefined;
      const normalize = (message: AssistantMessage): AssistantMessage => ({
        ...message,
        responseId: source,
      });
      void (async () => {
        try {
          if (model.provider !== route.provider || model.id !== route.model)
            throw new Error('Unapproved Claude route');
          const native: Model<'anthropic-messages'> = {
            ...catalog,
            provider: 'anthropic',
            api: 'anthropic-messages',
            baseUrl: 'https://api.anthropic.com',
            compat: {
              ...catalog.compat,
              supportsMidConvoSystemMessages: false,
              supportsMidConvoToolChanges: false,
              supportsMidConvoEffort: false,
            },
          };
          const headers: ProviderHeaders = {};
          for (const [name, value] of Object.entries(options?.headers ?? {}))
            headers[name.toLowerCase()] = value;
          delete headers.authorization;
          delete headers['x-api-key'];
          delete headers['anthropic-workspace-id'];
          if (route.workspace_id) headers['anthropic-workspace-id'] = route.workspace_id;
          let approvedDigest: string | undefined;
          const upstream = streamClaude(native, context, {
            ...options,
            apiKey: key,
            env: {},
            headers,
            maxTokens: route.max_tokens,
            reasoning: 'low',
            maxRetries: 0,
            timeoutMs: 120000,
            onPayload: async (payload, rawModel) => {
              const replacement = await options?.onPayload?.(payload, rawModel);
              const actual = replacement === undefined ? payload : replacement;
              try {
                validateClaudePayload(actual, route, frame(), tools);
                approvedDigest = digest(actual);
              } catch {
                gateFailed = true;
                throw new Error('Claude payload denied');
              }
              return actual;
            },
            onResponse: async (response, rawModel) => {
              status = response.status;
              await options?.onResponse?.(response, rawModel);
            },
            fetch: async (input, init) => {
              try {
                const url = new URL(input instanceof Request ? input.url : String(input));
                if (
                  url.href !== 'https://api.anthropic.com/v1/messages?beta=true' &&
                  url.href !== 'https://api.anthropic.com/v1/messages'
                )
                  throw new Error('Unapproved Claude endpoint');
                if (init?.method !== 'POST' || typeof init.body !== 'string' || dispatched)
                  throw new Error('Claude request replay denied');
                const sentHeaders = new Headers(init.headers);
                if (sentHeaders.get('x-api-key') !== key || sentHeaders.has('authorization'))
                  throw new Error('Unapproved Claude authentication');
                const payload = JSON.parse(init.body);
                validateClaudePayload(payload, route, frame(), tools);
                if (approvedDigest !== digest(payload))
                  throw new Error('Claude payload changed after validation');
                dispatched = true;
                await bridge('model', {
                  source_key: source,
                  provider: 'anthropic',
                  model: route.model,
                  context_digest: textDigest(frame()),
                  payload_digest: approvedDigest,
                  payload,
                });
              } catch {
                gateFailed = true;
                throw new Error('Claude request denied by Salaam');
              }
              return globalThis.fetch(input, { ...init, redirect: 'error' });
            },
          });
          for await (const event of upstream) {
            if ('partial' in event) last = normalize(event.partial);
            if (event.type === 'done') {
              const message = normalize(event.message);
              last = message;
              await bridge('usage', {
                source_key: source,
                usage: message.usage,
                provider_response_id: event.message.responseId ?? null,
              });
              output.push({ ...event, message });
            } else if (event.type === 'error') {
              const message = normalize(event.error);
              const code = /^(?:Error:\s*)?(\d{3})\b/.exec(message.errorMessage ?? '')?.[1];
              status = status ?? (code ? Number(code) : undefined);
              delete message.diagnostics;
              message.errorMessage = options?.signal?.aborted
                ? 'Claude request cancelled'
                : `Claude request failed${status ? ` (HTTP ${status})` : ''}`;
              message.content = [];
              last = message;
              output.push({ ...event, error: message });
            } else
              output.push(
                ('partial' in event
                  ? { ...event, partial: last! }
                  : event) as AssistantMessageEvent,
              );
          }
          output.end();
          if (gateFailed) await fail();
        } catch {
          const error: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: 'anthropic-messages',
            provider: 'anthropic',
            model: route.model,
            timestamp: Date.now(),
            stopReason: options?.signal?.aborted ? 'aborted' : 'error',
            usage: last?.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            responseId: source,
            errorMessage: options?.signal?.aborted
              ? 'Claude request cancelled'
              : 'Claude required control failed',
          };
          output.push({
            type: 'error',
            reason: error.stopReason === 'aborted' ? 'aborted' : 'error',
            error,
          });
          output.end();
          if (!options?.signal?.aborted) await fail();
        }
      })();
      return output;
    },
  });
}
