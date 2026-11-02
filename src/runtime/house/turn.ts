// Hooks every turn passes through: the policy gate on each tool call, the history tool, managed
// compaction, and the task frame appended to the context.
import { Type } from 'typebox';
import { ServiceError } from '../../core/protocol.js';
import type { House } from './context.js';

export function registerPolicyGate(h: House): void {
  const { pi, bridge, fail } = h;
  pi.on('tool_call', async (event) => {
    try {
      await bridge('policy', { tool: event.toolName });
    } catch (error) {
      if (!(error instanceof ServiceError && error.code === 'attempt_cancelled')) void fail();
      return { block: true, reason: 'Salaam policy gate unavailable' };
    }
  });
}

export function registerHistory(h: House): void {
  const { pi, c, bridge } = h;
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
}

export function registerCompaction(h: House): void {
  const { pi, bridge, fail } = h;
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
}

export function registerContext(h: House): void {
  const { pi, c, bridge } = h;
  pi.on('context', async (event) => {
    try {
      c.frame = (await bridge<{ frame: string }>('context')).frame;
    } catch (error) {
      // Pi may ask for context while its abort command is in flight. Keep the last admitted
      // frame; the independent model grant remains revoked for this cancelled attempt.
      if (!(error instanceof ServiceError && error.code === 'attempt_cancelled')) throw error;
    }
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
}
