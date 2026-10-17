import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { call } from './transport.js';
import { CAPABILITIES, PROTOCOL_VERSION, textDigest } from './protocol.js';

interface WorkerConfig {
  socket: string;
  token: string;
  session: string;
  epoch: number;
  bundle: string;
  policy: string;
  frame: string;
}
export default function house(pi: ExtensionAPI): void {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG ?? 'null') as WorkerConfig | null;
  if (!config) throw new Error('Missing Salaam worker configuration');
  const c = config;
  const bridge = <T = unknown>(method: string, data: unknown = {}) =>
    call<T>(
      c.socket,
      `/worker/${c.session}/${method}`,
      { epoch: c.epoch, ...(data as object) },
      c.token,
      2000,
    );
  let timer: NodeJS.Timeout | undefined;
  let shutdown: (() => void) | undefined;
  const fail = async () => {
    try {
      await bridge('failure', { reason: 'Required extension or bridge failed' });
    } catch {
      /* supervisor also detects bridge loss */
    }
    shutdown?.();
  };
  pi.registerTool({
    name: 'salaam_probe',
    label: 'Salaam readiness probe',
    description: 'Verify the managed tool gate without external effects.',
    parameters: Type.Object({ nested: Type.Optional(Type.Boolean()) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(toolCallId, params, signal, _update, ctx) {
      if (params.nested) {
        const outcome = await ctx.executeTool('salaam_probe', {}, { signal });
        if (outcome.isError) {
          await fail();
          throw new Error('Nested managed probe failed');
        }
        return { ...outcome.result, isError: outcome.isError };
      }
      await bridge('tool', { tool: 'salaam_probe', tool_call_id: toolCallId });
      return {
        content: [{ type: 'text', text: 'managed probe granted' }],
        details: { granted: true },
      };
    },
  });
  pi.on('tool_call', async (event) => {
    try {
      await bridge('policy', { tool: event.toolName });
    } catch {
      void fail();
      return { block: true, reason: 'Salaam policy gate unavailable' };
    }
  });
  pi.on('context', async (event) => ({
    messages: [
      ...event.messages,
      {
        role: 'custom' as const,
        customType: 'salaam-task-state',
        content: c.frame,
        display: false,
        timestamp: Date.now(),
      },
    ],
  }));
  pi.registerProvider('salaam-proof', {
    baseUrl: 'http://unused.invalid',
    apiKey: 'local-fixture',
    api: 'salaam-scripted',
    models: [
      {
        id: 'scripted',
        name: 'Salaam offline proof provider',
        reasoning: false,
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const response: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: 'stop',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      void (async () => {
        try {
          if (options?.signal?.aborted) throw new Error('Aborted');
          const last = context.messages.at(-1);
          const frame =
            last?.role === 'user'
              ? typeof last.content === 'string'
                ? last.content
                : last.content.map((x) => (x.type === 'text' ? x.text : '')).join('')
              : '';
          // Check actual outgoing context, not the hook's return or a version in user text.
          if (frame !== c.frame) throw new Error('Required task context missing');
          const payload = await options?.onPayload?.({ messages: context.messages }, model);
          if (
            payload !== undefined &&
            JSON.stringify(payload) !== JSON.stringify({ messages: context.messages })
          )
            throw new Error('Proof payload replacement is unsupported');
          await bridge('model', {
            context_digest: textDigest(frame),
            provider: model.provider,
            model: model.id,
          });
          stream.push({ type: 'start', partial: response });
          const realUser = context.messages.findLastIndex(
            (x) =>
              x.role === 'user' &&
              (typeof x.content === 'string'
                ? x.content !== c.frame
                : !x.content.some((p) => p.type === 'text' && p.text === c.frame)),
          );
          const hasResult = context.messages
            .slice(realUser + 1)
            .some((x) => x.role === 'toolResult' && x.toolName === 'salaam_probe');
          if (!hasResult) {
            const source = context.messages[realUser];
            const nested =
              source?.role === 'user' && JSON.stringify(source.content).includes('nested');
            const toolCall: ToolCall = {
              type: 'toolCall' as const,
              id: `probe-${Date.now()}`,
              name: 'salaam_probe',
              arguments: nested ? { nested: true } : {},
            };
            response.content.push(toolCall);
            response.stopReason = 'toolUse';
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: response });
            stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: response });
            stream.push({ type: 'done', reason: 'toolUse', message: response });
          } else {
            response.content.push({ type: 'text', text: '' });
            stream.push({ type: 'text_start', contentIndex: 0, partial: response });
            const source = context.messages[realUser];
            const input =
              source?.role === 'user'
                ? typeof source.content === 'string'
                  ? source.content
                  : source.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
                : '';
            const text = /^Run the (nested )?Salaam readiness probe\.$/.test(input)
              ? 'Salaam readiness probe complete.'
              : 'Offline reply: ' + input;
            response.content[0] = { type: 'text', text };
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: response });
            stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: response });
            stream.push({ type: 'done', reason: 'stop', message: response });
          }
          stream.end();
        } catch (error) {
          response.stopReason = 'error';
          response.errorMessage = (error as Error).message;
          stream.push({ type: 'error', reason: 'error', error: response });
          stream.end();
          await fail();
        }
      })();
      return stream;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    shutdown = () => ctx.shutdown();
    await bridge('handshake', {
      protocol_version: PROTOCOL_VERSION,
      bundle_digest: c.bundle,
      policy_digest: c.policy,
      session_id: c.session,
      epoch: c.epoch,
      pi_session_id: ctx.sessionManager.getSessionId(),
      capabilities: [...CAPABILITIES],
      tools: pi
        .getAllTools()
        .filter((tool) => tool.exposure !== 'hidden')
        .map((tool) => tool.name)
        .sort(),
      active_tools: pi.getActiveTools().sort(),
      provider: 'salaam-proof',
      context_digest: textDigest(c.frame),
    });
    timer = setInterval(() => {
      void bridge('heartbeat').catch(() => {
        clearInterval(timer);
        shutdown?.();
      });
    }, 500);
    timer.unref();
  });
  pi.on('session_shutdown', () => {
    clearInterval(timer);
  });
}
