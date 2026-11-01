import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { GatewayRequest, GatewayResponse } from './container.js';
import { ServiceError } from '../core/protocol.js';

export interface AnthropicHarnessPolicy {
  model: string;
  output: number;
  token: string;
  credential: () => Promise<string>;
  admit: (id: string, inputBytes: number, output: number) => void;
  fetch?: typeof fetch;
}
/** Text/custom-tool-only Anthropic gateway. The caller owns durable root admission and usage reconciliation. */
export class AnthropicHarnessGateway {
  constructor(readonly policy: AnthropicHarnessPolicy) {
    if (
      !policy.model ||
      !Number.isSafeInteger(policy.output) ||
      policy.output < 1 ||
      policy.output > 8192 ||
      policy.token.length < 32
    )
      throw new Error('Invalid harness model policy');
  }
  async request(request: GatewayRequest): Promise<GatewayResponse> {
    const supplied =
      request.headers['x-api-key'] ?? request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (
      typeof supplied !== 'string' ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(this.policy.token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.policy.token))
    )
      throw new ServiceError('harness_gateway_auth', 'Unowned gateway request');
    if (
      request.method !== 'POST' ||
      !['/v1/messages', '/v1/messages?beta=true'].includes(request.path) ||
      request.body.length > 2 * 1024 * 1024
    )
      throw new ServiceError(
        'harness_gateway_scope',
        'Gateway route is outside its admitted scope',
      );
    let body: Record<string, any>;
    try {
      body = JSON.parse(request.body.toString('utf8'));
    } catch {
      throw new ServiceError('harness_gateway_payload', 'Invalid model payload');
    }
    if (
      !body ||
      Array.isArray(body) ||
      body.model !== this.policy.model ||
      !Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1 ||
      !Array.isArray(body.messages) ||
      body.messages.length > 256 ||
      body.mcp_servers ||
      body.container ||
      body.tools?.some(
        (t: any) => !t || t.type !== undefined || typeof t.name !== 'string' || !t.input_schema,
      )
    )
      throw new ServiceError(
        'harness_gateway_payload',
        'Model route or tool authority differs from its admission',
      );
    const content = (blocks: unknown, role: string): boolean =>
      typeof blocks === 'string' ||
      (Array.isArray(blocks) &&
        blocks.every(
          (b: any) =>
            b &&
            typeof b === 'object' &&
            ((b.type === 'text' && typeof b.text === 'string') ||
              (role === 'assistant' &&
                (b.type === 'thinking' ||
                  b.type === 'redacted_thinking' ||
                  b.type === 'tool_use')) ||
              (role === 'user' && b.type === 'tool_result' && content(b.content ?? '', 'tool'))),
        ));
    if (
      body.messages.some(
        (m: any) => !m || !['user', 'assistant'].includes(m.role) || !content(m.content, m.role),
      ) ||
      (body.system !== undefined && !content(body.system, 'system'))
    )
      throw new ServiceError(
        'harness_gateway_payload',
        'Only admitted text and custom tool data may leave the workspace',
      );
    body.max_tokens = Math.min(body.max_tokens, this.policy.output);
    if (body.thinking?.type === 'enabled' && body.thinking.budget_tokens >= body.max_tokens)
      throw new ServiceError(
        'harness_gateway_payload',
        'Harness thinking budget exceeds its admitted output cap',
      );
    const credential = await this.policy.credential();
    if (!credential) throw new Error('Harness provider credential unavailable');
    const id = 'harness-model-request:' + randomUUID();
    this.policy.admit(id, request.body.length, body.max_tokens);
    const response = await (this.policy.fetch ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': credential,
        ...(request.headers['anthropic-beta']
          ? { 'anthropic-beta': request.headers['anthropic-beta'] }
          : {}),
      },
      body: JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    const chunks = async function* () {
      let size = 0;
      try {
        if (!reader) return;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 8 * 1024 * 1024)
            throw new Error('Harness provider response exceeded its bound');
          yield chunk.value;
        }
      } finally {
        await reader?.cancel();
      }
    };
    return {
      status: response.status,
      content_type: response.headers.get('content-type') ?? 'application/json',
      body: chunks(),
    };
  }
}
