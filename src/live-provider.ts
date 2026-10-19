import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthResult,
} from '@earendil-works/pi-ai';
import { zstdDecompressSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { digest, object, textDigest, canonical } from './protocol.js';
import {
  getProvider,
  getProviderModel,
  providerHasOutputCap,
  type ProviderRoute,
} from './provider-config.js';
import { ProviderUsageReceipt } from './provider-usage.js';
import { credentialStrings, providerOutcome, providerRefusalEvent } from './acp-outcome.js';
import { materialize, generationOptions } from './provider-model.js';
import { validateProviderPayload } from './provider-payload.js';
import { installProviderTransport, withProviderTransport } from './provider-transport.js';

function freezeModel<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
function jsonBody(value: unknown, encoding?: string | null): unknown {
  if (encoding) {
    if (encoding !== 'zstd' || !(value instanceof Uint8Array))
      throw new Error('Unsupported provider body encoding');
    value = zstdDecompressSync(value, { maxOutputLength: 1048576 });
  }
  if (typeof value === 'string') return JSON.parse(value);
  if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString('utf8'));
  throw new Error('Provider JSON body missing');
}
export function registerLiveProvider(
  pi: ExtensionAPI,
  route: ProviderRoute,
  frame: () => string,
  tools: string[],
  bridge: (method: string, data: unknown) => Promise<unknown>,
  fail: () => Promise<void>,
) {
  const catalog = getProviderModel(route),
    provider = getProvider(route.provider);
  if (!catalog || !provider) throw new Error('Pinned provider model missing');
  const rawFetch = installProviderTransport() ?? globalThis.fetch;
  pi.registerProvider(route.provider, {
    baseUrl: route.connection?.endpoint || catalog.baseUrl || 'https://salaam-configured.invalid',
    apiKey: 'salaam-resolves-auth',
    api: catalog.api,
    models: [
      {
        ...catalog,
        baseUrl:
          route.connection?.endpoint || catalog.baseUrl || 'https://salaam-configured.invalid',
        maxTokens: route.max_tokens,
      },
    ],
    streamSimple(model, context, options) {
      const output = createAssistantMessageEventStream(),
        source = 'salaam-request:' + randomUUID(),
        receipt = new ProviderUsageReceipt();
      let failed = false,
        refusal = false,
        dispatched = false,
        status: number | undefined,
        last: AssistantMessage | undefined;
      const normalize = (message: AssistantMessage): AssistantMessage => ({
        ...message,
        responseId: source,
      });
      void (async () => {
        try {
          if (model.provider !== route.provider || model.id !== route.model)
            throw new Error('Unapproved provider route');
          const auth = (await bridge('provider.auth', {})) as AuthResult;
          if (route.provider === 'amazon-bedrock') {
            for (const name of Object.keys(process.env))
              if (name.startsWith('AWS_')) delete process.env[name];
            Object.assign(
              process.env,
              Object.fromEntries(
                Object.entries(auth.env ?? {}).filter(([key]) => key.startsWith('AWS_')),
              ),
            );
          }
          const native = freezeModel(
            materialize({ ...catalog, maxTokens: route.max_tokens }, auth),
          );
          let approved: unknown, approvedDigest: string | undefined;
          const validate = (payload: unknown) =>
            validateProviderPayload(
              payload,
              route,
              frame(),
              tools,
              !providerHasOutputCap(route, auth),
            );
          const admit = async (payload: unknown) => {
            if (dispatched) throw new Error('Provider request replay denied');
            validate(payload);
            if (!approvedDigest) throw new Error('Provider payload not approved');
            dispatched = true;
            await bridge('model', {
              source_key: source,
              provider: route.provider,
              model: route.model,
              context_digest: textDigest(frame()),
              payload_digest: digest(payload),
              payload,
            });
          };
          const endpoint = (url: URL) => {
            const base = new URL(native.baseUrl);
            if (url.origin !== base.origin || url.username || url.password || url.hash)
              throw new Error('Unapproved provider endpoint');
            const prefix = base.pathname.replace(/\/$/, '');
            if (native.api === 'google-generative-ai' || native.api === 'google-vertex') {
              if (
                !url.pathname.startsWith(prefix + '/') ||
                !url.pathname.endsWith('/' + route.model + ':streamGenerateContent') ||
                url.searchParams.get('alt') !== 'sse'
              )
                throw new Error('Unapproved Google endpoint');
            } else if (native.api === 'bedrock-converse-stream') {
              if (decodeURIComponent(url.pathname) !== '/model/' + route.model + '/converse-stream')
                throw new Error('Unapproved Bedrock endpoint');
            } else {
              const suffixes =
                native.api === 'anthropic-messages'
                  ? ['/v1/messages', '/messages']
                  : native.api === 'mistral-conversations'
                    ? ['/v1/chat/completions']
                    : native.api === 'openai-completions'
                      ? ['/chat/completions']
                      : native.api === 'pi-messages'
                        ? ['/messages']
                        : native.api === 'openai-codex-responses'
                          ? ['/codex/responses']
                          : ['/responses'];
              if (!suffixes.some((suffix) => url.pathname === prefix + suffix))
                throw new Error('Unapproved provider path');
            }
          };
          const wirePayload = (payload: unknown): unknown => {
            if (native.api === 'google-generative-ai' || native.api === 'google-vertex') {
              const p = object(payload);
              if (p.cachedContent !== undefined) throw new Error('Cached Google context disabled');
              return {
                model: route.model,
                contents: p.contents,
                config: { ...object(p.generationConfig), tools: p.tools, toolConfig: p.toolConfig },
              };
            }
            if (native.api === 'bedrock-converse-stream')
              return { ...object(payload), modelId: route.model };
            return payload;
          };
          const transport = {
            fetch: async (input: string | URL | Request, init?: RequestInit) => {
              try {
                const url = new URL(input instanceof Request ? input.url : String(input));
                endpoint(url);
                const request = input instanceof Request ? input : undefined;
                if ((init?.method ?? request?.method) !== 'POST')
                  throw new Error('Provider POST required');
                const raw = init?.body ?? (request ? await request.clone().text() : undefined);
                const payload = jsonBody(
                  raw,
                  new Headers(init?.headers ?? request?.headers).get('content-encoding'),
                );
                validate(wirePayload(payload));
                const expectedWire =
                  native.api === 'anthropic-messages'
                    ? Object.fromEntries(
                        Object.entries(object(approved)).filter(([key]) => key !== 'betas'),
                      )
                    : approved;
                if (
                  !['google-generative-ai', 'google-vertex', 'mistral-conversations'].includes(
                    native.api,
                  ) &&
                  digest(payload) !== digest(expectedWire)
                )
                  throw new Error('Provider payload changed after validation');
                // The SDK translates Google/Mistral parameters. Validate the final wire controls too.
                await admit(approved);
              } catch {
                failed = true;
                throw new Error('Provider request denied by Salaam');
              }
              const response = await rawFetch(input, { ...init, redirect: 'error' });
              status = response.status;
              return response;
            },
            bedrock: async (request: {
              protocol: string;
              hostname: string;
              path: string;
              method: string;
              body?: unknown;
            }) => {
              try {
                endpoint(new URL(request.protocol + '//' + request.hostname + request.path));
                if (request.method !== 'POST') throw new Error('Provider POST required');
                const payload = wirePayload(jsonBody(request.body));
                validate(payload);
                // AWS serializes undefined fields away. Compare the canonical JSON representation.
                if (canonical(payload) !== canonical(JSON.parse(JSON.stringify(approved))))
                  throw new Error('Bedrock payload changed after validation');
                await admit(approved);
              } catch {
                failed = true;
                throw new Error('Provider request denied by Salaam');
              }
            },
          };
          const headers = { ...options?.headers };
          for (const name of Object.keys(headers))
            if (
              [
                'authorization',
                'x-api-key',
                'api-key',
                'x-goog-api-key',
                'cf-aig-authorization',
                'anthropic-workspace-id',
              ].includes(name.toLowerCase())
            )
              delete headers[name];
          Object.assign(headers, auth.auth.headers);
          if (route.workspace_id) headers['anthropic-workspace-id'] = route.workspace_id;
          const upstream = withProviderTransport(transport, () =>
            provider.streamSimple(native, context, {
              ...options,
              headers,
              apiKey: auth.auth.apiKey,
              env: auth.env ?? {},
              ...generationOptions(native, context, route.max_tokens),
              transport: 'sse',
              maxRetries: 0,
              timeoutMs: 120000,
              fetch: ['google-generative-ai', 'google-vertex', 'bedrock-converse-stream'].includes(
                native.api,
              )
                ? undefined
                : transport.fetch,
              onPayload: async (payload, rawModel) => {
                try {
                  const replacement = await options?.onPayload?.(payload, rawModel);
                  const actual = replacement === undefined ? payload : replacement;
                  validate(actual);
                  if (native.api === 'google-generative-ai' || native.api === 'google-vertex')
                    object(actual).config = {
                      ...object(object(actual).config),
                      httpOptions: { retryOptions: { attempts: 1 }, timeout: 120000 },
                    };
                  approved = JSON.parse(JSON.stringify(actual));
                  approvedDigest = digest(approved);
                  return actual;
                } catch {
                  failed = true;
                  throw new Error('Provider payload denied');
                }
              },
              onProviderStreamEvent: async (event, rawModel) => {
                refusal ||= providerRefusalEvent(catalog.api, event);
                receipt.observe(catalog.api, event);
                await options?.onProviderStreamEvent?.(event, rawModel);
              },
              onResponse: async (response, rawModel) => {
                status = response.status;
                await options?.onResponse?.(response, rawModel);
              },
            }),
          );
          for await (const event of upstream) {
            if ('partial' in event) last = normalize(event.partial);
            if (event.type === 'done') {
              if (!dispatched) throw new Error('Provider returned without admission');
              const message = normalize(event.message);
              last = message;
              if (receipt.complete)
                await bridge('usage', {
                  source_key: source,
                  usage: message.usage,
                  provider_response_id: event.message.responseId ?? null,
                });
              if (refusal) {
                const outcome = providerOutcome('refusal', '', route);
                Object.assign(message, { salaamFailure: outcome.failure });
                message.stopReason = 'error';
                message.errorMessage = outcome.failure!.message;
                output.push({ type: 'error', reason: 'error', error: message });
              } else output.push({ ...event, message });
            } else if (event.type === 'error') {
              const message = normalize(event.error);
              const code = /^(?:Error:\s*)?(\d{3})\b/.exec(message.errorMessage ?? '')?.[1];
              status ??= code ? Number(code) : undefined;
              delete message.diagnostics;
              message.content = [];
              const outcome = providerOutcome(
                refusal ? 'refusal' : options?.signal?.aborted ? 'aborted' : 'error',
                message.errorMessage ?? '',
                route,
                status,
                credentialStrings(auth),
              );
              Object.assign(message, { salaamFailure: outcome.failure });
              message.errorMessage = outcome.failure!.message;
              output.push({ ...event, error: message });
            } else
              output.push(
                ('partial' in event
                  ? { ...event, partial: last! }
                  : event) as AssistantMessageEvent,
              );
          }
          output.end();
          if (failed) await fail();
        } catch {
          const error: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: catalog.api,
            provider: route.provider,
            model: route.model,
            timestamp: Date.now(),
            responseId: source,
            stopReason: options?.signal?.aborted ? 'aborted' : 'error',
            usage: last?.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            errorMessage: options?.signal?.aborted
              ? 'Provider request cancelled'
              : 'Provider required control failed',
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
