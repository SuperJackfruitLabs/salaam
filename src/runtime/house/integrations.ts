// Tools that reach reviewed integrations: the station's managed MCP servers, the operator's
// declared MCP servers, and the native Toolkit.
import { Type } from 'typebox';
import type { Approval, Operation } from '../../core/protocol.js';
import type { McpCall } from '../../mcp/work.js';
import type { McpReturnedResult } from '../../mcp/http.js';
import type { ToolkitCall } from '../../toolkit/calls.js';
import type { House } from './context.js';

export function registerIntegrationTools(h: House): void {
  registerMcp(h);
  registerOperatorMcp(h);
  registerToolkit(h);
}

/** salaam_mcp: the station’s reviewed MCP tools. */
function registerMcp(h: House): void {
  const { pi, c, bridge } = h;
  if (c.mcp && !c.child)
    pi.registerTool({
      name: 'salaam_mcp',
      label: 'Managed station tools',
      description:
        'Discover reviewed station MCP tools progressively. Use catalog to list servers, then a server to list tools, then server+tool for its schema. Use call with that exact schema. Mutation replies are protocol results; they do not verify the external effect.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('catalog'), Type.Literal('call')]),
        server: Type.Optional(Type.String({ maxLength: 128 })),
        tool: Type.Optional(Type.String({ maxLength: 128 })),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(toolCallId, params, signal, _update, ctx) {
        if (params.action === 'catalog') {
          const result = await bridge('mcp.catalog', { server: params.server, tool: params.tool });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: { catalog: result },
          };
        }
        type Result = {
          call: McpCall;
          operation?: Operation;
          approval?: Approval;
          result: McpReturnedResult | null;
        };
        const created = await bridge<Result>('mcp.prepare', {
          tool_call_id: toolCallId,
          args: { server: params.server, tool: params.tool, arguments: params.arguments ?? {} },
        });
        if (
          created.approval &&
          created.operation &&
          created.call.state === 'prepared' &&
          created.approval.state === 'pending'
        )
          await ctx.ui.confirm(
            `salaam-approval:${created.approval.id}:${created.operation.operation_digest}`,
            `${created.operation.target}\n${created.operation.value}\nBinding: ${created.operation.target_version}`,
            { signal },
          );
        let result = await bridge<Result>('mcp.run', { call_id: created.call.id });
        while (['prepared', 'dispatching'].includes(result.call.state)) {
          if (signal?.aborted) throw new Error('Managed MCP invocation cancelled');
          await new Promise((resolve) => setTimeout(resolve, 75));
          result = await bridge<Result>(
            result.call.state === 'prepared' ? 'mcp.run' : 'mcp.status',
            { call_id: created.call.id },
          );
        }
        return {
          content: result.result?.content ?? [
            {
              type: 'text',
              text: `MCP call ${result.call.state}${result.call.error ? ': ' + result.call.error : ''}`,
            },
          ],
          details: {
            call_id: result.call.id,
            state: result.call.state,
            operation_id: result.call.operation_id,
            result_artifact: result.call.result_artifact,
            structured_content: result.result?.structured_content,
          },
          isError: result.call.state !== 'returned' || !!result.result?.is_error,
        };
      },
    });
}

/** salaam_operator_mcp: the MCP servers the operator declared. */
function registerOperatorMcp(h: House): void {
  const { pi, c, bridge } = h;
  if (c.operator_mcp?.length && !c.child)
    pi.registerTool({
      name: 'salaam_operator_mcp',
      label: 'Operator MCP servers',
      description:
        "Use MCP servers the operator declared for this Salaam service. Use catalog with no server to list servers, with a server to list its tools, and with server+tool for that tool's input schema. Then use call with server, tool and arguments matching the schema. A reply is the server's protocol result; it does not verify an external effect.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal('catalog'), Type.Literal('call')]),
        server: Type.Optional(Type.String({ maxLength: 64 })),
        tool: Type.Optional(Type.String({ maxLength: 128 })),
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      async execute(_toolCallId, params) {
        if (params.action === 'catalog') {
          const result = await bridge('operator_mcp.catalog', {
            server: params.server,
            tool: params.tool,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: { catalog: result as unknown, server: params.server, tool: params.tool },
          };
        }
        const result = await bridge<{
          content: { type: 'text'; text: string }[];
          is_error: boolean;
        }>('operator_mcp.call', {
          server: params.server,
          tool: params.tool,
          arguments: params.arguments ?? {},
        });
        return {
          content: result.content.length
            ? result.content
            : [{ type: 'text', text: 'MCP tool returned no content' }],
          details: { catalog: undefined as unknown, server: params.server, tool: params.tool },
          isError: result.is_error,
        };
      },
    });
}

/** salaam_toolkit: reviewed native Toolkit actions. */
function registerToolkit(h: House): void {
  const { pi, c, bridge } = h;
  if (c.toolkit && !c.child)
    pi.registerTool({
      name: 'salaam_toolkit',
      label: 'Salaam native tools',
      description:
        'Discover reviewed native Toolkit categories, then actions, then a named action schema. Call only that schema. Human decisions remain bound to the exact operation; a protocol response never verifies an external effect.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('catalog'), Type.Literal('call')]),
        category: Type.Optional(Type.String({ maxLength: 128 })),
        name: Type.Optional(Type.String({ maxLength: 128 })),
        arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      async execute(toolCallId, params, signal, _update, ctx) {
        if (params.action === 'catalog') {
          const result = await bridge('toolkit.catalog', {
            category: params.category,
            action: params.name,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: { catalog: result },
          };
        }
        type Result = {
          call: ToolkitCall;
          operation?: Operation;
          approval?: Approval;
          result: McpReturnedResult | null;
        };
        const created = await bridge<Result>('toolkit.prepare', {
          tool_call_id: toolCallId,
          args: {
            category: params.category,
            action: params.name,
            arguments: params.arguments ?? {},
          },
        });
        if (created.approval && created.operation && created.approval.state === 'pending')
          await ctx.ui.confirm(
            `salaam-approval:${created.approval.id}:${created.operation.operation_digest}`,
            `${created.operation.target}\n${created.operation.value}\nBinding: ${created.operation.target_version}`,
            { signal },
          );
        let result = await bridge<Result>('toolkit.run', { call_id: created.call.id });
        while (['prepared', 'pending', 'delivered', 'dispatching'].includes(result.call.state)) {
          if (signal?.aborted) throw new Error('Native Toolkit invocation cancelled');
          await new Promise((resolve) => setTimeout(resolve, 75));
          result = await bridge<Result>(
            ['prepared', 'pending'].includes(result.call.state) ? 'toolkit.run' : 'toolkit.status',
            { call_id: created.call.id },
          );
        }
        return {
          content: result.result?.content ?? [
            { type: 'text', text: `Native Toolkit call ${result.call.state}` },
          ],
          details: {
            call_id: result.call.id,
            state: result.call.state,
            operation_id: result.call.operation_id,
            structured_content: result.result?.structured_content,
          },
          isError: result.call.state !== 'returned' || !!result.result?.is_error,
        };
      },
    });
}
