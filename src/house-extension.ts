import { randomUUID } from 'node:crypto';
import { registerClaude } from './claude-provider.js';
import { OFFLINE_ROUTE, type ProviderRoute } from './provider-config.js';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { call } from './transport.js';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  workerTools,
  textDigest,
  digest,
  type Approval,
  type Operation,
} from './protocol.js';

interface WorkerConfig {
  socket: string;
  token: string;
  session: string;
  epoch: number;
  bundle: string;
  policy: string;
  frame: string;
  effects?: boolean;
  child?: boolean;
  route?: ProviderRoute;
}
export default function house(pi: ExtensionAPI): void {
  const config = JSON.parse(process.env.SALAAM_WORKER_CONFIG ?? 'null') as WorkerConfig | null;
  if (!config) throw new Error('Missing Salaam worker configuration');
  const c = config;
  const route = c.route ?? { ...OFFLINE_ROUTE };
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
  const managedTool = (name: 'salaam_review' | 'salaam_effect', kind: 'review' | 'effect') =>
    pi.registerTool({
      name,
      label: kind === 'review' ? 'Approved read-only review' : 'Approved fixture effect',
      description:
        'Request an operation-bound human decision; execute only the service-authorized operation.',
      parameters: Type.Object({
        target: Type.Optional(Type.String({ maxLength: 256 })),
        targets: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { maxItems: 8 })),
        value: Type.Optional(Type.String({ maxLength: 4096 })),
      }),
      annotations: { readOnlyHint: kind === 'review', openWorldHint: kind === 'effect' },
      async execute(toolCallId, params, signal, _update, ctx) {
        if (params.targets) {
          const outcomes = await Promise.all(
            params.targets.map((target) =>
              ctx.executeTool(
                name,
                { target, value: params.value ?? 'offline fixture' },
                { signal },
              ),
            ),
          );
          for (const outcome of outcomes) {
            if (!outcome.isError || signal?.aborted) continue;
            const operationId = outcome.result.details?.operation_id;
            const operation =
              typeof operationId === 'string'
                ? await bridge<Operation>('operation.status', { operation_id: operationId })
                : undefined;
            // A definite/uncertain operation outcome is normal tool failure.
            // A missing execution/gate result is a required-control failure.
            if (!operation || !['failed_definite', 'outcome_unknown'].includes(operation.state)) {
              await fail();
              throw new Error('Required nested managed tool path failed');
            }
          }
          return {
            content: outcomes.flatMap((outcome) => outcome.result.content),
            details: { results: outcomes.map((outcome) => outcome.result.details) },
            isError: outcomes.some((outcome) => outcome.isError),
          };
        }
        if (!params.target) throw new Error('A target is required');
        const created = await bridge<{ operation: Operation; approval: Approval }>(
          'operation.prepare',
          {
            tool_call_id: toolCallId,
            kind,
            target: params.target,
            value: params.value ?? 'offline fixture',
          },
        );
        // The dialog is a presentation channel. Only the durable ledger decision
        // can authorize dispatch, even if an unsolicited raw UI reply says yes.
        await ctx.ui.confirm(
          `salaam-approval:${created.approval.id}:${created.operation.operation_digest}`,
          `${kind}: ${params.target}\n${params.value ?? 'offline fixture'}\nVersion: ${created.operation.target_version}`,
          { signal },
        );
        let operation = await bridge<Operation>('operation.run', {
          operation_id: created.operation.id,
        });
        while (['prepared', 'dispatching'].includes(operation.state)) {
          if (signal?.aborted) throw new Error('Managed operation cancelled');
          await new Promise((resolve) => setTimeout(resolve, 75));
          operation = await bridge<Operation>(
            operation.state === 'prepared' ? 'operation.run' : 'operation.status',
            { operation_id: created.operation.id },
          );
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `${operation.target}: ${operation.state}${operation.error ? ': ' + operation.error : ''}`,
            },
          ],
          details: {
            operation_id: operation.id,
            state: operation.state,
            receipt: operation.receipt ? JSON.parse(operation.receipt) : null,
          },
          isError: ['failed_definite', 'outcome_unknown'].includes(operation.state),
        };
      },
    });
  if (!c.child) {
    pi.registerTool({
      name: 'spawn_child',
      label: 'Spawn read-only child',
      description:
        'Reserve a request budget and start an independent read-only child. Reuse the same step key for retries.',
      parameters: Type.Object({
        step_key: Type.Optional(Type.String({ maxLength: 128 })),
        prompt: Type.Optional(Type.String({ maxLength: 32768 })),
        budget: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        authority: Type.Optional(Type.Array(Type.String())),
        tasks: Type.Optional(
          Type.Array(Type.Object({ step_key: Type.String(), prompt: Type.String() }), {
            maxItems: 2,
          }),
        ),
        wait: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal) {
        const tasks = params.tasks ?? [
          { step_key: params.step_key ?? '', prompt: params.prompt ?? '' },
        ];
        let children = await Promise.all(
          tasks.map((task) =>
            bridge<import('./protocol.js').ChildTask>('child.spawn', {
              ...task,
              budget: params.budget ?? 2,
              authority: params.authority ?? ['salaam_probe'],
            }),
          ),
        );
        while (params.wait && children.some((x) => x.state === 'accepted')) {
          if (signal?.aborted) throw new Error('Parent cancelled');
          await new Promise((resolve) => setTimeout(resolve, 50));
          children = await Promise.all(
            children.map((x) =>
              bridge<import('./protocol.js').ChildTask>('child.inspect', { child_id: x.id }),
            ),
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(children) }],
          details: { children },
        };
      },
    });
    pi.registerTool({
      name: 'inspect_child',
      label: 'Inspect child inbox',
      description: 'List durable child tasks and stable result IDs, or inspect one child.',
      parameters: Type.Object({ child_id: Type.Optional(Type.String()) }),
      async execute(_id, params) {
        const result = await bridge(params.child_id ? 'child.inspect' : 'child.list', params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
      },
    });
    pi.registerTool({
      name: 'consume_child_result',
      label: 'Read or acknowledge child result',
      description:
        'Read the same durable result repeatedly. Set acknowledge only after processing it; reading alone never acknowledges.',
      parameters: Type.Object({
        child_id: Type.String(),
        result_id: Type.String(),
        acknowledge: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        const result = await bridge('child.consume', params);
        if (params.acknowledge)
          await bridge('child.ack', { ...params, request_id: `ack:${params.result_id}` });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
      },
    });
    managedTool('salaam_review', 'review');
  }
  if (c.effects) managedTool('salaam_effect', 'effect');
  pi.on('tool_call', async (event) => {
    try {
      await bridge('policy', { tool: event.toolName });
    } catch {
      void fail();
      return { block: true, reason: 'Salaam policy gate unavailable' };
    }
  });
  if (!c.child)
    pi.registerTool({
      name: 'salaam_history',
      label: 'Retrieve Salaam evidence',
      description:
        'List append-order history or retrieve an older entry/evidence artifact. Results are bounded; follow next_offset.',
      parameters: Type.Object({
        artifact_id: Type.Optional(Type.String()),
        entry_id: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      async execute(_id, params) {
        const result = await bridge('history', params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  pi.on('session_before_compact', async (event) => {
    try {
      const plan = await bridge<{ id: string; task_version: number; summary: string }>(
        'compaction.plan',
      );
      if (event.signal.aborted) return { cancel: true };
      const lastUser = event.branchEntries.findLast(
        (entry) => entry.type === 'message' && entry.message.role === 'user',
      );
      if (!lastUser) return { cancel: true };
      return {
        compaction: {
          summary: plan.summary,
          firstKeptEntryId: lastUser.id,
          tokensBefore: event.preparation.tokensBefore,
          details: {
            salaam_compaction: plan.id,
            task_version: plan.task_version,
            strategy: 'explicit-task-checkpoint-v1',
          },
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      };
    } catch {
      await fail();
      return { cancel: true }; // Never fall through to unadmitted default summarization.
    }
  });
  pi.on('context', async (event) => {
    c.frame = (await bridge<{ frame: string }>('context')).frame;
    return {
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
    };
  });
  if (route.provider === 'anthropic')
    registerClaude(pi, route, () => c.frame, workerTools(!!c.effects, !!c.child), bridge, fail);
  else
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
        const sourceKey = 'salaam-request:' + randomUUID();
        const response: AssistantMessage = {
          role: 'assistant',
          responseId: sourceKey,
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
            const wirePayload = JSON.parse(JSON.stringify({ messages: context.messages }));
            await bridge('model', {
              source_key: sourceKey,
              context_digest: textDigest(frame),
              payload: wirePayload,
              payload_digest: digest(wirePayload),
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
              .some(
                (x) =>
                  x.role === 'toolResult' &&
                  [
                    'salaam_probe',
                    'salaam_review',
                    'salaam_effect',
                    'spawn_child',
                    'inspect_child',
                    'consume_child_result',
                    'salaam_history',
                  ].includes(x.toolName),
              );
            const source = context.messages[realUser];
            const input =
              source?.role === 'user'
                ? typeof source.content === 'string'
                  ? source.content
                  : source.content
                      .filter((p) => p.type === 'text')
                      .map((p) => (p.type === 'text' ? p.text : ''))
                      .join('')
                : '';
            const history = /^\[history\]\s+(\S+)$/.exec(input);
            const next = input === '[next]';
            const children = /^\[children(?:-nowait)?\]\s+(.+)$/.exec(input);
            const inbox = input.startsWith('[inbox]');
            const consume = /^\[consume\]\s+(\S+)\s+(\S+)(?:\s+(ack))?$/.exec(input);
            const managed = /^\[(review|effect)\]\s+(.+)$/.exec(input);
            const effectDisabled = managed?.[1] === 'effect' && !c.effects;
            if (!hasResult && !effectDisabled) {
              const nested =
                source?.role === 'user' && JSON.stringify(source.content).includes('nested');
              const toolCall: ToolCall = {
                type: 'toolCall' as const,
                id: `tool-${randomUUID()}`,
                name:
                  history && !c.child
                    ? 'salaam_history'
                    : children && !c.child
                      ? 'spawn_child'
                      : inbox && !c.child
                        ? 'inspect_child'
                        : consume && !c.child
                          ? 'consume_child_result'
                          : managed?.[1] === 'effect'
                            ? 'salaam_effect'
                            : managed
                              ? 'salaam_review'
                              : 'salaam_probe',
                arguments:
                  history && !c.child
                    ? { artifact_id: history[1]! }
                    : children && !c.child
                      ? {
                          tasks: children[1]!.split(',').map((step) => ({
                            step_key: step.trim(),
                            prompt: 'Read-only child: ' + step.trim(),
                          })),
                          budget: 2,
                          wait: !input.startsWith('[children-nowait]'),
                        }
                      : inbox && !c.child
                        ? {}
                        : consume && !c.child
                          ? {
                              child_id: consume[1]!,
                              result_id: consume[2]!,
                              acknowledge: !!consume[3],
                            }
                          : managed
                            ? {
                                targets: managed[2]!.split(',').map((target) => target.trim()),
                                value: 'offline fixture',
                              }
                            : nested
                              ? { nested: true }
                              : {},
              };
              response.content.push(toolCall);
              response.stopReason = 'toolUse';
              stream.push({ type: 'toolcall_start', contentIndex: 0, partial: response });
              stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: response });
              await bridge('usage', { source_key: sourceKey, usage: response.usage });
              stream.push({ type: 'done', reason: 'toolUse', message: response });
            } else {
              response.content.push({ type: 'text', text: '' });
              stream.push({ type: 'text_start', contentIndex: 0, partial: response });
              const text = effectDisabled
                ? 'External effect connector is disabled; no effect was dispatched.'
                : /^Run the (nested )?Salaam readiness probe\.$/.test(input)
                  ? 'Salaam readiness probe complete.'
                  : /^\[(review|effect)\]/.test(input)
                    ? 'Offline managed operations settled; inspect their ledger outcomes.'
                    : next
                      ? 'Next explicit work: ' +
                        JSON.parse(c.frame.slice('SALAAM_TASK_STATE '.length))
                          .facts.filter(
                            (f: { kind: string; superseded_by: string | null }) =>
                              f.kind === 'outstanding' && !f.superseded_by,
                          )
                          .map((f: { text: string }) => f.text)
                          .join('; ')
                      : 'Offline reply: ' + input;
              response.content[0] = { type: 'text', text };
              stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: response });
              stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: response });
              await bridge('usage', { source_key: sourceKey, usage: response.usage });
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
      provider: route.provider,
      route,
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
