import { AsyncLocalStorage } from 'node:async_hooks';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

export interface ProviderTransport {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  bedrock(request: {
    protocol: string;
    hostname: string;
    path: string;
    method: string;
    body?: unknown;
    headers: Record<string, string>;
  }): Promise<void>;
}
const scope = new AsyncLocalStorage<ProviderTransport>();
let installed = false;
let underlyingFetch: typeof globalThis.fetch;
/** Worker-local SDK interception, scoped to the active model call (not auth refresh). */
export function installProviderTransport() {
  if (installed) return underlyingFetch;
  installed = true;
  const originalFetch = (underlyingFetch = globalThis.fetch);
  globalThis.fetch = (input, init) =>
    scope.getStore()?.fetch(input, init) ??
    Promise.reject(new Error('Unadmitted worker network request'));
  const send = BedrockRuntimeClient.prototype.send;
  BedrockRuntimeClient.prototype.send = function (
    this: BedrockRuntimeClient,
    ...args: Parameters<typeof send>
  ) {
    const gate = scope.getStore();
    if (gate) {
      // Pi 1.3.0 doesn't forward maxRetries to this SDK. Disable SDK retries explicitly.
      this.config.retryStrategy = async () => ({
        mode: 'standard',
        retry: async (next, request) => next(request),
      });
      const handler = this.config.requestHandler;
      const handle = handler.handle.bind(handler);
      handler.handle = async (request, options) => {
        await gate.bedrock(request);
        return handle(request, options);
      };
    }
    return Reflect.apply(send, this, args);
  } as typeof send;
  return originalFetch;
}
export function withProviderTransport<T>(transport: ProviderTransport, fn: () => T): T {
  return scope.run(transport, fn);
}
