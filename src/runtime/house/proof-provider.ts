// The offline proof provider: a scripted model that admits each request over the bridge and
// answers with the tool call or reply its fixture prompt asks for.
import { randomUUID } from 'node:crypto';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { ServiceError, textDigest, digest } from '../../core/protocol.js';
import type { House, WorkerConfig } from './context.js';

export function registerProofProvider(h: House): void {
  const { pi, c, bridge, fail } = h;
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
          const { hasResult, source, input } = latestRequest(context.messages, c.frame);
          const script = readScript(input, c);
          const { effectDisabled, localWrite, localRead } = script;
          if (!hasResult && !effectDisabled && (!c.local || localRead || localWrite)) {
            const nested =
              source?.role === 'user' && JSON.stringify(source.content).includes('nested');
            const toolCall: ToolCall = {
              type: 'toolCall' as const,
              id: `tool-${randomUUID()}`,
              ...scriptedCall(script, input, c, nested),
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
            const text = scriptedText(script, input, c.frame);
            response.content[0] = { type: 'text', text };
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: response });
            stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: response });
            await bridge('usage', { source_key: sourceKey, usage: response.usage });
            stream.push({ type: 'done', reason: 'stop', message: response });
          }
          stream.end();
        } catch (error) {
          const cancelled =
            options?.signal?.aborted ||
            (error instanceof ServiceError && error.code === 'attempt_cancelled');
          response.stopReason = cancelled ? 'aborted' : 'error';
          response.errorMessage = (error as Error).message;
          stream.push({
            type: 'error',
            reason: cancelled ? 'aborted' : 'error',
            error: response,
          });
          stream.end();
          if (!cancelled) await fail();
        }
      })();
      return stream;
    },
  });
}

/** Tools the scripted model calls; once one has answered the latest request, it replies. */
const SCRIPTED_TOOLS = [
  'salaam_probe',
  'salaam_review',
  'salaam_effect',
  'spawn_child',
  'inspect_child',
  'consume_child_result',
  'salaam_history',
  'salaam_files',
  'salaam_command',
  'salaam_mcp',
  'salaam_operator_mcp',
  'salaam_toolkit',
  'salaam_station',
  'salaam_workspace',
  'salaam_local',
];

/** The latest real user message (not the task frame), its text, and whether a scripted tool has
 * already answered it. */
function latestRequest(messages: Context['messages'], frame: string) {
  const realUser = messages.findLastIndex(
    (x) =>
      x.role === 'user' &&
      (typeof x.content === 'string'
        ? x.content !== frame
        : !x.content.some((p) => p.type === 'text' && p.text === frame)),
  );
  const hasResult = messages
    .slice(realUser + 1)
    .some((x) => x.role === 'toolResult' && SCRIPTED_TOOLS.includes(x.toolName));
  const source = messages[realUser];
  const input =
    source?.role === 'user'
      ? typeof source.content === 'string'
        ? source.content
        : source.content
            .filter((p) => p.type === 'text')
            .map((p) => (p.type === 'text' ? p.text : ''))
            .join('')
      : '';
  return { hasResult, source, input };
}

/** The fixture prompt's request, as the scripted model reads it. */
function readScript(input: string, c: WorkerConfig) {
  const history = /^\[history\]\s+(\S+)$/.exec(input);
  const next = input === '[next]';
  const children = /^\[children(?:-nowait)?\]\s+(.+)$/.exec(input);
  const inbox = input.startsWith('[inbox]');
  const consume = /^\[consume\]\s+(\S+)\s+(\S+)(?:\s+(ack))?$/.exec(input);
  const managed = /^\[(review|effect)\]\s+(.+)$/.exec(input);
  const coding = /^\[(files|command)\]\s+(.+)$/.exec(input);
  const mcp = c.mcp && !c.child ? /^\[mcp\]\s+(.+)$/.exec(input) : null;
  const declared =
    c.operator_mcp?.length && !c.child ? /^\[operator-mcp\]\s+(.+)$/.exec(input) : null;
  const station = c.station && !c.child ? /^\[station\]\s+(.+)$/.exec(input) : null;
  const toolkit = c.toolkit && !c.child ? /^\[toolkit\]\s+(.+)$/.exec(input) : null;
  const effectDisabled = managed?.[1] === 'effect' && !c.effects;
  const localWrite = c.localCoding ? /^\[local\]\s+(.+)$/.exec(input) : null;
  const localRead = c.local ? /^\[workspace\]\s+(.+)$/.exec(input) : null;
  return {
    history,
    next,
    children,
    inbox,
    consume,
    managed,
    coding,
    mcp,
    declared,
    station,
    toolkit,
    effectDisabled,
    localWrite,
    localRead,
  };
}
type Script = ReturnType<typeof readScript>;

/** The tool call a fixture prompt asks for, the first that applies; the probe otherwise. */
function scriptedCall(
  script: Script,
  input: string,
  c: WorkerConfig,
  nested: boolean,
): Pick<ToolCall, 'name' | 'arguments'> {
  const {
    history,
    children,
    inbox,
    consume,
    managed,
    coding,
    mcp,
    declared,
    station,
    toolkit,
    localWrite,
    localRead,
  } = script;
  return {
    name: localWrite
      ? 'salaam_local'
      : localRead
        ? 'salaam_workspace'
        : station
          ? 'salaam_station'
          : declared
            ? 'salaam_operator_mcp'
            : toolkit
              ? 'salaam_toolkit'
              : mcp
                ? 'salaam_mcp'
                : coding && c.coding && !c.child
                  ? coding[1] === 'files'
                    ? 'salaam_files'
                    : 'salaam_command'
                  : history && !c.child
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
    arguments: localWrite
      ? JSON.parse(localWrite[1]!)
      : localRead
        ? JSON.parse(localRead[1]!)
        : station
          ? JSON.parse(station[1]!)
          : declared
            ? JSON.parse(declared[1]!)
            : toolkit
              ? JSON.parse(toolkit[1]!)
              : mcp
                ? JSON.parse(mcp[1]!)
                : coding && c.coding && !c.child
                  ? JSON.parse(coding[2]!)
                  : history && !c.child
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
}

/** The scripted model's reply when it calls no tool. */
function scriptedText(script: Script, input: string, frame: string): string {
  const { effectDisabled, next } = script;
  return effectDisabled
    ? 'External effect connector is disabled; no effect was dispatched.'
    : /^Run the (nested )?Salaam readiness probe\.$/.test(input)
      ? 'Salaam readiness probe complete.'
      : /^\[(review|effect)\]/.test(input)
        ? 'Offline managed operations settled; inspect their ledger outcomes.'
        : next
          ? 'Next explicit work: ' +
            JSON.parse(frame.slice('SALAAM_TASK_STATE '.length))
              .facts.filter(
                (f: { kind: string; superseded_by: string | null }) =>
                  f.kind === 'outstanding' && !f.superseded_by,
              )
              .map((f: { text: string }) => f.text)
              .join('; ')
          : 'Offline reply: ' + input;
}
