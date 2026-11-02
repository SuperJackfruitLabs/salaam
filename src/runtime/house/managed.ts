// The readiness probe and the operation-bound managed tools (review and effect): each call is
// prepared, decided by a person through the durable approval ledger, then run by the service.
import { Type } from 'typebox';
import { workerTools, type Approval, type Operation } from '../../core/protocol.js';
import type { House } from './context.js';

export function registerProbe(h: House): void {
  const { pi, c, bridge, fail } = h;
  if (
    workerTools(
      !!c.effects,
      !!c.child,
      c.coding,
      c.worker_binding?.binding.tools,
      false,
      false,
      false,
      !!c.local,
      !!c.localCoding,
    ).includes('salaam_probe')
  )
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
}

export function registerManagedTool(
  h: House,
  name: 'salaam_review' | 'salaam_effect',
  kind: 'review' | 'effect',
): void {
  const { pi, bridge, fail } = h;
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
            ctx.executeTool(name, { target, value: params.value ?? 'offline fixture' }, { signal }),
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
}
