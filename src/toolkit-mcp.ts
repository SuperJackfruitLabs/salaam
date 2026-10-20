import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import type { ManagedStdioTransport } from './mcp-stdio.js';
import { admittedMcpSchema } from './mcp-schema.js';
import { mcpCatalogDigest, McpInputFailure } from './mcp-http.js';
import { toolkitRequest, type ToolkitRequest } from './toolkit-protocol.js';
import type { ToolkitActionPin } from './toolkit-calls.js';
import { canonical, digest, object, ServiceError } from './protocol.js';

export interface ToolkitActionReview extends ToolkitActionPin {
  category: string;
  action: string;
}
export interface ToolkitCatalogReview {
  catalog_digest: string;
  actions: readonly ToolkitActionReview[];
}
interface Action {
  review: ToolkitActionReview;
  detail: Record<string, unknown>;
  schema: Record<string, unknown>;
  validate: JsonSchemaValidator<unknown>;
}
export class ToolkitProtocolFailure extends ServiceError {
  constructor() {
    super(
      'toolkit_protocol_failed',
      'Required native Toolkit protocol or catalogue is unavailable',
    );
  }
}
const names = [
  'discover_server_categories',
  'get_category_actions',
  'get_action_details',
  'execute_action',
];
const nameShape = /^[A-Za-z0-9_.:-]{1,128}$/;
const hashShape = /^[a-f0-9]{64}$/;
function bad(): never {
  throw new ToolkitProtocolFailure();
}
function closed(value: unknown, fields: string): Record<string, unknown> {
  const v = object(value);
  if (Object.keys(v).sort().join(',') !== fields.split(',').sort().join(',')) bad();
  return v;
}
function textResult(result: CallToolResult): unknown {
  if (
    Object.keys(result).some((k) => !['content', 'isError'].includes(k)) ||
    result.content.length !== 1 ||
    result.content[0]?.type !== 'text' ||
    Object.keys(result.content[0]).sort().join(',') !== 'text,type' ||
    Buffer.byteLength(result.content[0].text) > 270000
  )
    bad();
  return JSON.parse(result.content[0].text);
}

export function toolkitCatalogReview(value: unknown): ToolkitCatalogReview {
  const review = structuredClone(object(value)) as unknown as ToolkitCatalogReview;
  if (
    Object.keys(review).sort().join(',') !== 'actions,catalog_digest' ||
    typeof review.catalog_digest !== 'string' ||
    !hashShape.test(review.catalog_digest) ||
    !Array.isArray(review.actions) ||
    !review.actions.length ||
    review.actions.length > 256
  )
    bad();
  const unique = new Set<string>();
  for (const r of review.actions) {
    closed(r, 'category,action,kind,policy,digest');
    if (
      typeof r.category !== 'string' ||
      typeof r.action !== 'string' ||
      typeof r.digest !== 'string' ||
      !nameShape.test(r.category) ||
      !nameShape.test(r.action) ||
      !hashShape.test(r.digest) ||
      !['read', 'write', 'destructive'].includes(r.kind) ||
      !['agent', 'approval'].includes(r.policy) ||
      (r.kind !== 'read' && r.policy !== 'approval') ||
      unique.has(r.category + '/' + r.action)
    )
      bad();
    unique.add(r.category + '/' + r.action);
  }
  return review;
}

/** Actual pinned SDK/catalogue consumer. The transport must already belong to
 * ToolkitResources and ToolkitOwners; this class grants no effect authority.
 * A caller uses ToolkitCalls for durable delivery and native callback grants. */
export class ToolkitMcp {
  private readonly client = new Client(
    { name: 'salaam-managed-toolkit', version: '1' },
    { capabilities: {} },
  );
  private readonly review: ToolkitCatalogReview;
  private readonly actions = new Map<string, Action>();
  private ready = false;
  private invalid = false;
  private busy = false;
  private connecting?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    readonly transport: ManagedStdioTransport,
    review: ToolkitCatalogReview,
    private readonly failed: () => void,
  ) {
    this.review = toolkitCatalogReview(review);
    this.client.onerror = () => this.fail();
    this.client.onclose = () => {
      if (!this.closing) this.fail();
    };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => this.fail());
  }
  private fail(): void {
    if (this.invalid || this.closing) return;
    this.invalid = true;
    this.ready = false;
    try {
      this.failed();
    } catch {}
    void this.close().catch(() => {});
  }
  private usable(): void {
    if (!this.ready || this.invalid || this.closing) bad();
  }
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.invalid || this.closing) return Promise.reject(new ToolkitProtocolFailure());
    this.connecting = this.initialize().catch(async () => {
      this.fail();
      await this.close();
      throw new ToolkitProtocolFailure();
    });
    return this.connecting;
  }
  private async initialize(): Promise<void> {
    const timeout = this.transport.launch.limits.timeout_ms,
      signal = AbortSignal.timeout(timeout),
      options = { timeout, signal, resetTimeoutOnProgress: false };
    await this.client.connect(this.transport, options);
    const caps = this.client.getServerCapabilities(),
      server = this.client.getServerVersion();
    if (
      server?.name !== 'supertoolkit-managed' ||
      !server.version ||
      canonical(caps) !==
        canonical({
          tools: {},
          experimental: {
            'salaam.dev/toolkit': {
              version: 1,
              boundedGrants: true,
              nativeKinds: true,
              lifecycleControl: true,
            },
          },
        })
    )
      bad();
    const catalog = await this.client.request(
      { method: 'tools/list' },
      ListToolsResultSchema,
      options,
    );
    if (
      Object.keys(catalog).join(',') !== 'tools' ||
      catalog.tools.length !== names.length ||
      catalog.tools.some((t, i) => t.name !== names[i]) ||
      mcpCatalogDigest(catalog.tools) !== this.review.catalog_digest
    )
      bad();
    for (const tool of catalog.tools) admittedMcpSchema(tool.inputSchema);
    for (const r of this.review.actions) {
      const result = await this.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'get_action_details',
            arguments: { category: r.category, action: r.action },
          },
        },
        CallToolResultSchema,
        options,
      );
      if (result.isError) bad();
      const detail = closed(textResult(result), 'category,action,summary,params,kind,policy');
      if (
        detail.category !== r.category ||
        detail.action !== r.action ||
        detail.kind !== r.kind ||
        detail.policy !== r.policy ||
        digest(detail) !== r.digest ||
        typeof detail.summary !== 'string' ||
        (detail.params !== null && !Array.isArray(detail.params))
      )
        bad();
      const properties: Record<string, { type: 'string'; maxLength: number; description: string }> =
          Object.create(null),
        required: string[] = [];
      const params = (detail.params ?? []) as unknown[];
      if (params.length > 64) bad();
      for (const value of params) {
        const p = closed(value, 'Name,Required,In,Slashes,Summary');
        if (
          typeof p.Name !== 'string' ||
          !nameShape.test(p.Name) ||
          Object.hasOwn(properties, p.Name) ||
          typeof p.Required !== 'boolean' ||
          ![0, 1, 2].includes(Number(p.In)) ||
          typeof p.In !== 'number' ||
          typeof p.Slashes !== 'boolean' ||
          typeof p.Summary !== 'string'
        )
          bad();
        properties[p.Name] = { type: 'string', maxLength: 16384, description: p.Summary };
        if (p.Required) required.push(p.Name);
      }
      const schema = { type: 'object' as const, properties, required, additionalProperties: false };
      this.actions.set(r.category + '/' + r.action, {
        review: r,
        detail,
        schema,
        validate: admittedMcpSchema(schema),
      });
    }
    signal.throwIfAborted();
    if (this.invalid || this.closing) bad();
    this.ready = true;
  }
  catalog(category?: string, action?: string): unknown {
    this.usable();
    if (category === undefined) {
      if (action !== undefined) throw new McpInputFailure();
      return [...new Set(this.review.actions.map((r) => r.category))].map((category) => ({
        category,
        kind: 'native',
      }));
    }
    if (action === undefined) {
      const actions = this.review.actions.filter((r) => r.category === category);
      if (!actions.length) throw new McpInputFailure();
      return actions.map(({ action, kind, policy }) => ({ action, kind, policy }));
    }
    const admitted = this.action(category, action);
    return structuredClone({ ...admitted.detail, inputSchema: admitted.schema });
  }
  private action(category: string, name: string): Action {
    this.usable();
    const action = this.actions.get(category + '/' + name);
    if (!action) throw new McpInputFailure();
    return action;
  }
  pin(category: string, action: string): ToolkitActionPin {
    const { kind, policy, digest } = this.action(category, action).review;
    return { kind, policy, digest };
  }
  validate(request: ToolkitRequest): void {
    const action = this.action(request.service, request.action);
    if (
      request.approval !== (action.review.policy === 'approval') ||
      !action.validate(request.args).valid
    )
      throw new McpInputFailure();
  }
  async invoke(
    input: ToolkitRequest,
    signal: AbortSignal,
  ): Promise<{
    receipt: Record<string, unknown>;
    is_error: boolean;
    outcome?: { protocol_result: 'returned'; is_error: boolean; status: number; body: string };
  }> {
    const request = toolkitRequest(input);
    this.validate(request);
    if (this.busy)
      throw new ServiceError('toolkit_busy', 'Native Toolkit invocation is already active');
    signal.throwIfAborted();
    this.busy = true;
    try {
      const result = await this.client.request(
        {
          method: 'tools/call',
          params: {
            name: 'execute_action',
            arguments: { category: request.service, action: request.action, args: request.args },
            _meta: {
              'salaam.dev/toolkit': {
                version: 1,
                invocation_id: request.invocation_id,
                expires_at_ms: request.expires_at_ms,
              },
            },
          },
        },
        CallToolResultSchema,
        { signal, timeout: this.transport.launch.limits.timeout_ms, resetTimeoutOnProgress: false },
      );
      const envelope = object(textResult(result));
      const receipt = Object.hasOwn(envelope, 'error')
        ? (() => {
            closed(envelope, 'error,receipt');
            if (envelope.error !== 'managed_toolkit_unavailable' || !result.isError) bad();
            return object(envelope.receipt);
          })()
        : envelope;
      if (
        Object.keys(receipt).some(
          (k) =>
            ![
              'id',
              'request_digest',
              'state',
              'decision_id',
              'result',
              'cancellation_requested',
            ].includes(k),
        ) ||
        receipt.id !== digest(['stk.managed-mcp.v1', request.root_digest, request.invocation_id]) ||
        receipt.request_digest !== digest(request) ||
        !['awaiting_decision', 'denied', 'cancelled', 'returned', 'outcome_unknown'].includes(
          String(receipt.state),
        ) ||
        (receipt.decision_id !== undefined &&
          (typeof receipt.decision_id !== 'string' || !nameShape.test(receipt.decision_id))) ||
        (receipt.cancellation_requested !== undefined &&
          typeof receipt.cancellation_requested !== 'boolean')
      )
        bad();
      if (receipt.state === 'returned') {
        if (
          typeof receipt.result !== 'string' ||
          !receipt.result ||
          Buffer.byteLength(receipt.result) > 262144 ||
          Object.hasOwn(envelope, 'error')
        )
          bad();
        const outcome = closed(JSON.parse(receipt.result), 'protocol_result,is_error,status,body');
        if (
          outcome.protocol_result !== 'returned' ||
          !Number.isSafeInteger(outcome.status) ||
          Number(outcome.status) < 100 ||
          Number(outcome.status) > 599 ||
          typeof outcome.is_error !== 'boolean' ||
          outcome.is_error !== (Number(outcome.status) < 200 || Number(outcome.status) >= 300) ||
          typeof outcome.body !== 'string' ||
          Buffer.byteLength(outcome.body) > 196608 ||
          !!result.isError !== outcome.is_error
        )
          bad();
        return {
          receipt,
          is_error: outcome.is_error,
          outcome: outcome as unknown as {
            protocol_result: 'returned';
            is_error: boolean;
            status: number;
            body: string;
          },
        };
      }
      if (
        receipt.result !== undefined ||
        !result.isError ||
        (receipt.state === 'awaiting_decision' && !request.approval)
      )
        bad();
      return { receipt, is_error: true };
    } catch {
      this.fail();
      throw new ToolkitProtocolFailure();
    } finally {
      this.busy = false;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ready = false;
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.client.close();
      } finally {
        await this.transport.close();
      }
    });
    return this.closing;
  }
}
