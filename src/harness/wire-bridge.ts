import { randomUUID } from 'node:crypto';
import { AnthropicHarnessGateway } from './model-gateway.js';
import type { GatewayRequest, GatewayResponse } from './container.js';
import { ServiceError } from '../core/protocol.js';

type Json = Record<string, any>;
function invalid(): never {
  throw new ServiceError(
    'harness_wire_unsupported',
    'Payload exceeds the admitted text/custom-tool wire subset',
  );
}
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : invalid();
const list = (value: unknown): Json[] =>
  Array.isArray(value) && value.length <= 512 ? value.map(object) : invalid();
const text = (value: unknown): string => (typeof value === 'string' ? value : invalid());
const id = (value: unknown): string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : invalid();
interface Transcript {
  system: string[];
  messages: Json[];
  tools: Json[];
}
/** Explicit protocol translation to the operator-declared Claude backend, never a Google/OpenAI account claim. */
export class HarnessWireBridge {
  constructor(
    readonly backend: AnthropicHarnessGateway,
    readonly wire: { protocol: 'google' | 'responses'; model: string; tools: readonly string[] },
    readonly onTool?: (intent: { id: string; name: string; arguments: Json }) => void,
  ) {
    if (
      !wire.model ||
      !wire.tools.length ||
      wire.tools.some((n) => !/^[a-zA-Z0-9_-]{1,128}$/.test(n))
    )
      throw Error('Invalid frozen harness wire policy');
  }
  private tool(name: unknown): string {
    const n = text(name);
    if (!this.wire.tools.includes(n)) invalid();
    return n;
  }
  private append(t: Transcript, role: string, content: Json[]): void {
    if (!content.length) return;
    const previous = t.messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else t.messages.push({ role, content });
  }
  private google(body: Json): Transcript {
    if (
      Object.keys(body).some(
        (k) =>
          !['contents', 'systemInstruction', 'tools', 'generationConfig', 'toolConfig'].includes(k),
      )
    )
      invalid();
    const t: Transcript = { system: [], messages: [], tools: [] },
      pending = new Map<string, string>(),
      byName = new Map<string, string[]>();
    if (body.systemInstruction)
      for (const part of list(object(body.systemInstruction).parts)) t.system.push(text(part.text));
    for (const tool of list(body.tools ?? []))
      for (const declaration of list(tool.functionDeclarations ?? [])) {
        const name = text(declaration.name);
        if (!this.wire.tools.includes(name)) continue;
        t.tools.push({
          name,
          description: typeof declaration.description === 'string' ? declaration.description : '',
          input_schema: object(declaration.parametersJsonSchema ?? declaration.parameters),
        });
      }
    for (const [position, message] of list(body.contents).entries()) {
      if (!['user', 'model'].includes(message.role)) invalid();
      const parts: Json[] = [];
      for (const [index, part] of list(message.parts).entries()) {
        if (typeof part.text === 'string') {
          parts.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.functionCall && message.role === 'model') {
          const call = object(part.functionCall),
            name = this.tool(call.name),
            callId = call.id === undefined ? 'google_' + position + '_' + index : id(call.id);
          if (pending.has(callId)) invalid();
          pending.set(callId, name);
          byName.set(name, [...(byName.get(name) ?? []), callId]);
          parts.push({ type: 'tool_use', id: callId, name, input: object(call.args) });
          continue;
        }
        if (part.functionResponse && message.role === 'user') {
          const reply = object(part.functionResponse),
            name = this.tool(reply.name),
            options = byName.get(name) ?? [],
            callId =
              reply.id === undefined
                ? options.length === 1
                  ? options[0]!
                  : invalid()
                : id(reply.id);
          if (pending.get(callId) !== name) invalid();
          pending.delete(callId);
          byName.set(
            name,
            options.filter((n) => n !== callId),
          );
          parts.push({
            type: 'tool_result',
            tool_use_id: callId,
            content: JSON.stringify(reply.response),
          });
          continue;
        }
        invalid();
      }
      this.append(t, message.role === 'model' ? 'assistant' : 'user', parts);
    }
    if (pending.size) invalid();
    return t;
  }
  private responses(body: Json): Transcript {
    if (body.model !== this.wire.model || body.previous_response_id) invalid();
    const t: Transcript = { system: [], messages: [], tools: [] },
      pending = new Set<string>();
    if (body.instructions !== undefined) t.system.push(text(body.instructions));
    for (const tool of list(body.tools ?? [])) {
      if (tool.type !== 'function' || !this.wire.tools.includes(tool.name)) continue;
      t.tools.push({
        name: this.tool(tool.name),
        description: typeof tool.description === 'string' ? tool.description : '',
        input_schema: object(tool.parameters),
      });
    }
    for (const item of list(body.input)) {
      if (item.type === 'message' || item.role) {
        if (!['user', 'assistant', 'system', 'developer'].includes(item.role)) invalid();
        const parts =
          typeof item.content === 'string'
            ? [{ text: item.content }]
            : list(item.content).map((p) => {
                if (!['input_text', 'output_text'].includes(p.type)) invalid();
                return { text: text(p.text) };
              });
        if (['system', 'developer'].includes(item.role))
          t.system.push(parts.map((p) => p.text).join('\n'));
        else
          this.append(
            t,
            item.role,
            parts.map((p) => ({ type: 'text', text: p.text })),
          );
        continue;
      }
      if (item.type === 'function_call') {
        const callId = id(item.call_id);
        if (pending.has(callId)) invalid();
        pending.add(callId);
        let input: Json;
        try {
          input = object(JSON.parse(text(item.arguments)));
        } catch {
          invalid();
        }
        this.append(t, 'assistant', [
          { type: 'tool_use', id: callId, name: this.tool(item.name), input },
        ]);
        continue;
      }
      if (item.type === 'function_call_output') {
        const callId = id(item.call_id);
        if (!pending.delete(callId)) invalid();
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
        this.append(t, 'user', [{ type: 'tool_result', tool_use_id: callId, content: output }]);
        continue;
      }
      // A foreign provider's opaque thinking signature is never forwarded as Claude authority.
      if (item.type === 'reasoning') continue;
      invalid();
    }
    if (pending.size) invalid();
    return t;
  }
  async request(request: GatewayRequest): Promise<GatewayResponse> {
    if (request.method !== 'POST' || request.body.length > 2 * 1024 * 1024) invalid();
    const expected =
      this.wire.protocol === 'google'
        ? '/v1beta/models/' + this.wire.model + ':streamGenerateContent?alt=sse'
        : '/v1/responses';
    if (request.path !== expected) invalid();
    let raw: Json;
    try {
      raw = object(JSON.parse(request.body.toString('utf8')));
    } catch {
      invalid();
    }
    const transcript = this.wire.protocol === 'google' ? this.google(raw) : this.responses(raw);
    const requested =
      this.wire.protocol === 'google'
        ? raw.generationConfig?.maxOutputTokens
        : raw.max_output_tokens;
    if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) invalid();
    const body = {
      model: this.backend.policy.model,
      max_tokens: Math.min(requested ?? this.backend.policy.output, this.backend.policy.output),
      stream: false,
      system: transcript.system.join('\n\n'),
      messages: transcript.messages,
      ...(transcript.tools.length
        ? {
            tools: transcript.tools,
            tool_choice: { type: 'auto', disable_parallel_tool_use: true },
          }
        : {}),
    };
    const result = await this.backend.request({
      ...request,
      path: '/v1/messages',
      body: Buffer.from(JSON.stringify(body)),
    });
    if (result.status !== 200)
      return {
        status: result.status,
        content_type: 'application/json',
        body: Buffer.from(
          JSON.stringify({
            error: {
              code: result.status,
              message: 'Declared model backend rejected this request',
              status: 'FAILED_PRECONDITION',
            },
          }),
        ),
      };
    let bytes: Buffer;
    if (Buffer.isBuffer(result.body)) bytes = result.body;
    else {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of result.body) {
        length += chunk.length;
        if (length > 8 * 1024 * 1024) invalid();
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks);
    }
    const response = object(JSON.parse(bytes.toString('utf8'))),
      content = list(response.content),
      usage = object(response.usage ?? {});
    for (const part of content)
      if (part.type === 'tool_use') {
        this.tool(part.name);
        this.onTool?.({
          id: id(part.id),
          name: this.tool(part.name),
          arguments: structuredClone(object(part.input)),
        });
      } else if (!['text', 'thinking', 'redacted_thinking'].includes(part.type)) invalid();
    if (this.wire.protocol === 'google') {
      const parts = content.flatMap<Json>((p) =>
        p.type === 'text'
          ? [{ text: text(p.text) }]
          : p.type === 'tool_use'
            ? [{ functionCall: { id: id(p.id), name: this.tool(p.name), args: object(p.input) } }]
            : [],
      );
      const payload = {
        candidates: [
          {
            index: 0,
            content: { role: 'model', parts },
            finishReason: response.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: usage.input_tokens ?? 0,
          candidatesTokenCount: usage.output_tokens ?? 0,
          totalTokenCount: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        },
        modelVersion: this.wire.model,
        responseId: response.id,
      };
      return {
        status: 200,
        content_type: 'text/event-stream',
        body: Buffer.from('data: ' + JSON.stringify(payload) + '\n\n'),
      };
    }
    const responseId = 'resp_' + randomUUID().replaceAll('-', ''),
      output: Json[] = content.flatMap<Json>((p) =>
        p.type === 'text'
          ? [
              {
                id: 'msg_' + randomUUID().replaceAll('-', ''),
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: text(p.text), annotations: [] }],
              },
            ]
          : p.type === 'tool_use'
            ? [
                {
                  id: 'fc_' + id(p.id),
                  type: 'function_call',
                  status: 'completed',
                  call_id: id(p.id),
                  name: this.tool(p.name),
                  arguments: JSON.stringify(object(p.input)),
                },
              ]
            : [],
      );
    const complete = {
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: response.stop_reason === 'max_tokens' ? 'incomplete' : 'completed',
      error: null,
      incomplete_details:
        response.stop_reason === 'max_tokens' ? { reason: 'max_output_tokens' } : null,
      model: this.wire.model,
      output,
      usage: {
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        input_tokens_details: { cached_tokens: usage.cache_read_input_tokens ?? 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      parallel_tool_calls: false,
    };
    if (raw.stream !== true)
      return {
        status: 200,
        content_type: 'application/json',
        body: Buffer.from(JSON.stringify(complete)),
      };
    let serial = 0;
    const events: Json[] = [
      { type: 'response.created', response: { ...complete, status: 'in_progress', output: [] } },
    ];
    for (const [index, item] of output.entries()) {
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: {
          ...item,
          status: 'in_progress',
          ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }),
        },
      });
      if (item.type === 'function_call')
        events.push(
          {
            type: 'response.function_call_arguments.delta',
            item_id: item.id,
            output_index: index,
            delta: item.arguments,
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: index,
            arguments: item.arguments,
          },
        );
      else {
        events.push(
          {
            type: 'response.content_part.added',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            delta: item.content[0].text,
          },
          {
            type: 'response.output_text.done',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text: item.content[0].text,
          },
          {
            type: 'response.content_part.done',
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: item.content[0],
          },
        );
      }
      events.push({ type: 'response.output_item.done', output_index: index, item });
    }
    events.push({
      type: complete.status === 'completed' ? 'response.completed' : 'response.incomplete',
      response: complete,
    });
    return {
      status: 200,
      content_type: 'text/event-stream',
      body: Buffer.from(
        events
          .map((event) => {
            const value = { ...event, sequence_number: serial++ };
            return 'event: ' + event.type + '\ndata: ' + JSON.stringify(value) + '\n\n';
          })
          .join(''),
      ),
    };
  }
}
