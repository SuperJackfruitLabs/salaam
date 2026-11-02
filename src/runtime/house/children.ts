// A root worker's read-only children: spawn them under a request budget, list or inspect them,
// and read or acknowledge their durable results.
import { Type } from 'typebox';
import type { ChildTask } from '../../core/protocol.js';
import type { House } from './context.js';

export function registerChildTools(h: House): void {
  registerSpawn(h);
  registerInspect(h);
  registerConsume(h);
}

/** spawn_child: start read-only children under a request budget. */
function registerSpawn(h: House): void {
  const { pi, bridge } = h;
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
      profile: Type.Optional(Type.String({ maxLength: 128 })),
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
          bridge<ChildTask>('child.spawn', {
            ...task,
            budget: params.budget ?? 2,
            authority: params.authority ?? (params.profile ? [] : ['salaam_probe']),
            ...(params.profile ? { profile: params.profile } : {}),
          }),
        ),
      );
      while (params.wait && children.some((x) => x.state === 'accepted')) {
        if (signal?.aborted) throw new Error('Parent cancelled');
        await new Promise((resolve) => setTimeout(resolve, 50));
        children = await Promise.all(
          children.map((x) => bridge<ChildTask>('child.inspect', { child_id: x.id })),
        );
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(children) }],
        details: { children },
      };
    },
  });
}

/** inspect_child: list or inspect children. */
function registerInspect(h: House): void {
  const { pi, bridge } = h;
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
}

/** consume_child_result: read or acknowledge a child result. */
function registerConsume(h: House): void {
  const { pi, bridge } = h;
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
}
