import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { admittedMcpSchema } from './mcp-schema.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpAssignment, McpProfile, McpServerPin } from './mcp-protocol.js';
import { redactMcpData } from './mcp-protocol.js';
import { canonical, digest, object, ServiceError } from './protocol.js';
import { traceParent } from './execution-trace.js';

/** Pin the complete definition: descriptions/annotations can affect context too. */
export const mcpToolDigest = (tool: unknown): string => digest(object(tool));
export function mcpCatalogDigest(tools: readonly unknown[]): string {
  const definitions = tools
    .map(object)
    .sort((a, b) =>
      String(a.name) < String(b.name) ? -1 : String(a.name) > String(b.name) ? 1 : 0,
    );
  return digest(definitions);
}
export class McpHttpFailure extends ServiceError {
  constructor(readonly sent: boolean) {
    super('mcp_call_failed', 'Managed MCP call did not return a valid bounded result');
  }
}
export class McpInputFailure extends ServiceError {
  readonly sent = false;
  constructor() {
    super('invalid_mcp_arguments', 'MCP arguments do not match the admitted tool schema', 400);
  }
}
class PinnedTransport extends StreamableHTTPClientTransport {
  constructor(
    url: URL,
    readonly version: string,
    options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  ) {
    super(url, options);
  }
  override setProtocolVersion(version: string): void {
    if (version !== this.version) throw new McpHttpFailure(false);
    super.setProtocolVersion(version);
  }
}
export interface McpReturnedResult {
  protocol_result: 'returned';
  is_error: boolean;
  content: { type: 'text'; text: string }[];
  structured_content?: unknown;
}

/** One explicitly assigned server, no OAuth provider, redirects, task handoff or write replay. */
export class ManagedHttpMcp {
  private readonly client = new Client(
    { name: 'salaam-managed-mcp', version: '1' },
    { capabilities: {} },
  );
  private readonly transport: PinnedTransport;
  private readonly stopped = new AbortController();
  private readonly server: McpAssignment['servers'][number];
  private readonly pin: McpServerPin;
  private readonly limits: McpProfile['limits'];
  private readonly secrets = new Set<string>();
  private connecting?: Promise<void>;
  private ready = false;
  private invalid = false;
  private busy = false;
  private sent = false;
  private definitions: Record<string, unknown>[] = [];
  private callSignal?: AbortSignal;
  private beforeSend?: () => void;
  private callTrace?: string;
  private validators = new Map<
    string,
    { input: JsonSchemaValidator<unknown>; output?: JsonSchemaValidator<unknown> }
  >();
  constructor(
    server: McpAssignment['servers'][number],
    pin: McpServerPin,
    limits: McpProfile['limits'],
    fetcher: typeof fetch = globalThis.fetch,
  ) {
    this.server = structuredClone(server);
    this.pin = structuredClone(pin);
    this.limits = { ...limits };
    for (const h of server.headers) this.secrets.add(h.value);
    this.transport = new PinnedTransport(new URL(server.url), pin.protocol_version, {
      fetch: (url, init) => this.boundedFetch(fetcher, url, init),
      requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
      },
    });
    this.client.onerror = () => {
      this.invalid = true;
    };
    this.client.onclose = () => {
      this.ready = false;
    };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.invalid = true;
    });
  }
  private options(signal?: AbortSignal) {
    return {
      timeout: this.limits.timeout_ms,
      maxTotalTimeout: this.limits.timeout_ms,
      resetTimeoutOnProgress: false,
      signal: signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal,
    };
  }
  connect(): Promise<void> {
    this.connecting ??= this.establish();
    return this.connecting;
  }
  private async establish(): Promise<void> {
    try {
      const deadline = AbortSignal.timeout(this.limits.timeout_ms);
      await this.client.connect(this.transport, this.options(deadline));
      if (!this.client.getServerCapabilities()?.tools) throw new McpHttpFailure(false);
      const definitions = await this.catalog(deadline);
      for (const pin of this.pin.tools) {
        const tool = definitions.find((t) => t.name === pin.name)!;
        // Only compile definitions after their complete catalog and individual pins match.
        // A fresh validator per schema prevents unrelated tools sharing an AJV $id cache.
        this.validators.set(pin.name, {
          input: admittedMcpSchema(tool.inputSchema as JsonSchemaType),
          ...(tool.outputSchema
            ? {
                output: admittedMcpSchema(tool.outputSchema as JsonSchemaType),
              }
            : {}),
        });
      }
      if (this.invalid || this.stopped.signal.aborted) throw new McpHttpFailure(false);
      this.definitions = definitions.filter((t) => this.pin.tools.some((p) => p.name === t.name));
      this.ready = true;
    } catch {
      await this.close();
      throw new McpHttpFailure(false);
    }
  }
  describe(): Record<string, unknown>[] {
    if (!this.ready || this.invalid || this.stopped.signal.aborted) throw new McpHttpFailure(false);
    return this.redact(this.definitions) as Record<string, unknown>[];
  }
  private async catalog(signal?: AbortSignal) {
    // Avoid Client.listTools() compiling output validators from unreviewed remote schemas.
    const result = await this.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
      this.options(signal),
    );
    if (
      result.nextCursor ||
      result.tools.length > 256 ||
      new Set(result.tools.map((t) => t.name)).size !== result.tools.length ||
      mcpCatalogDigest(result.tools) !== this.pin.catalog_digest
    ) {
      this.invalid = true;
      throw new McpHttpFailure(false);
    }
    for (const pin of this.pin.tools) {
      const tool = result.tools.find((t) => t.name === pin.name);
      if (
        !tool ||
        mcpToolDigest(tool) !== pin.schema_digest ||
        tool.execution?.taskSupport === 'required'
      ) {
        this.invalid = true;
        throw new McpHttpFailure(false);
      }
    }
    return result.tools;
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend: () => void,
    traceparent?: string,
  ): Promise<McpReturnedResult> {
    if (
      !this.ready ||
      this.invalid ||
      this.busy ||
      this.stopped.signal.aborted ||
      !this.pin.tools.some((t) => t.name === name)
    )
      throw new McpHttpFailure(false);
    this.busy = true;
    this.sent = false;
    this.beforeSend = beforeSend;
    // Telemetry is optional. Malformed correlation never becomes a required
    // execution control or a permission failure.
    try {
      this.callTrace = traceparent === undefined ? undefined : traceParent(traceparent);
    } catch {
      this.callTrace = undefined;
    }
    try {
      const parameters = JSON.parse(canonical(object(args))) as Record<string, unknown>;
      const validators = this.validators.get(name)!;
      const encoded = JSON.stringify({ name, arguments: parameters });
      if (
        Buffer.byteLength(encoded) + 256 > this.limits.request_bytes ||
        this.redact(encoded) !== encoded
      )
        throw new McpHttpFailure(false);
      if (!validators.input(parameters).valid) throw new McpInputFailure();
      this.callSignal = AbortSignal.any([signal, AbortSignal.timeout(this.limits.timeout_ms)]);
      this.callSignal.throwIfAborted();
      await this.catalog(this.callSignal);
      this.callSignal.throwIfAborted();
      if (this.invalid) throw new McpHttpFailure(false);
      const result = CallToolResultSchema.parse(
        await this.client.callTool(
          { name, arguments: parameters },
          CallToolResultSchema,
          this.options(this.callSignal),
        ),
      );
      if (
        validators.output &&
        ((!result.structuredContent && !result.isError) ||
          (result.structuredContent !== undefined &&
            !validators.output(result.structuredContent).valid))
      )
        throw new McpHttpFailure(this.sent);
      return this.result(result);
    } catch (error) {
      if (error instanceof McpInputFailure) throw error;
      throw new McpHttpFailure(this.sent);
    } finally {
      this.busy = false;
      this.callSignal = undefined;
      this.beforeSend = undefined;
      this.callTrace = undefined;
    }
  }
  private redact(value: unknown): unknown {
    return redactMcpData(value, [...this.secrets]);
  }
  private result(result: CallToolResult): McpReturnedResult {
    if (
      Object.hasOwn(result, 'task') ||
      Object.hasOwn(result, 'toolResult') ||
      (result._meta && Object.hasOwn(result._meta, 'io.modelcontextprotocol/related-task')) ||
      (!result.isError && result.content.length === 0 && result.structuredContent === undefined)
    )
      throw new McpHttpFailure(this.sent);
    if (result.content.some((c) => c.type !== 'text')) throw new McpHttpFailure(this.sent);
    const content = result.content.map((c) => ({
      type: 'text' as const,
      text: String(this.redact((c as { text: string }).text)),
    }));
    return {
      protocol_result: 'returned',
      is_error: result.isError === true,
      content,
      ...(result.structuredContent !== undefined
        ? { structured_content: this.redact(result.structuredContent) }
        : {}),
    };
  }
  private async boundedFetch(
    fetcher: typeof fetch,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== this.server.url || this.stopped.signal.aborted) throw new McpHttpFailure(false);
    // This profile uses POST responses (JSON or SSE), not an unsolicited GET stream.
    // Refresh the catalog before each call instead of admitting background server work.
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    if (init?.method !== 'POST') throw new McpHttpFailure(false);
    let isCall = false;
    if (init?.body !== undefined) {
      if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > this.limits.request_bytes)
        throw new McpHttpFailure(false);
      const message = object(JSON.parse(init.body));
      isCall = message.method === 'tools/call';
    }
    const headers = new Headers(init?.headers);
    headers.delete('Authorization');
    headers.delete('Cookie');
    for (const header of this.server.headers) headers.set(header.name, header.value);
    headers.delete('traceparent');
    headers.delete('tracestate');
    if (isCall && this.callTrace) headers.set('traceparent', this.callTrace);
    const signal = AbortSignal.any([
      this.stopped.signal,
      ...(this.callSignal ? [this.callSignal] : []),
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(this.limits.timeout_ms),
    ]);
    signal.throwIfAborted();
    if (isCall) {
      if (this.sent || !this.busy || !this.beforeSend) throw new McpHttpFailure(this.sent);
      // The caller rechecks its live lease and commits the dispatch marker here.
      // No await may separate that durable gate from this single transport handoff.
      this.beforeSend();
      this.sent = true;
    }
    const response = await fetcher(url, {
      ...init,
      headers,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
    if (response.url && response.url !== url) {
      await response.body?.cancel();
      throw new McpHttpFailure(this.sent);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // SDK errors must never contain a server's untrusted error body.
      return new Response(null, { status: response.status });
    }
    const safeHeaders = new Headers();
    for (const name of ['content-type', 'mcp-session-id']) {
      const value = response.headers.get(name);
      if (value !== null) {
        if (value.length > 256 || /[^\x20-\x7e]/.test(value)) {
          await response.body?.cancel();
          throw new McpHttpFailure(this.sent);
        }
        safeHeaders.set(name, value);
        if (name === 'mcp-session-id' && value) this.secrets.add(value);
      }
    }
    if (!response.body)
      return new Response(null, { status: response.status, headers: safeHeaders });
    const reader = response.body.getReader();
    let bytes = 0,
      finished = false,
      abort: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        abort = () => {
          if (finished) return;
          finished = true;
          controller.error(new McpHttpFailure(this.sent));
          reader.cancel().catch(() => {});
          signal.removeEventListener('abort', abort);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      pull: async (controller) => {
        try {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) {
            finished = true;
            signal.removeEventListener('abort', abort);
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > this.limits.response_bytes) {
            finished = true;
            signal.removeEventListener('abort', abort);
            controller.error(new McpHttpFailure(this.sent));
            await reader.cancel();
            return;
          }
          controller.enqueue(chunk.value);
        } catch {
          if (!finished) {
            finished = true;
            signal.removeEventListener('abort', abort);
            controller.error(new McpHttpFailure(this.sent));
          }
        }
      },
      cancel: async () => {
        finished = true;
        signal.removeEventListener('abort', abort);
        await reader.cancel();
      },
    });
    return new Response(stream, { status: response.status, headers: safeHeaders });
  }
  async close(): Promise<void> {
    this.ready = false;
    this.stopped.abort();
    await this.client.close();
  }
}
