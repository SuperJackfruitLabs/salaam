// A specialist child's tools, as its worker binding grants them: the admitted repository snapshot,
// the team inbox, and structured review findings.
import { Type } from 'typebox';
import { ServiceError } from '../../core/protocol.js';
import type { House } from './context.js';

export function registerSpecialistTools(h: House): void {
  registerRepository(h);
  registerTeam(h);
  registerFindings(h);
}

/** salaam_repository: the admitted repository snapshot. */
function registerRepository(h: House): void {
  const { pi, c, bridge, fail } = h;
  if (c.worker_binding?.binding.tools.includes('salaam_repository')) {
    pi.registerTool({
      name: 'salaam_repository',
      label: 'Repository snapshot',
      description:
        'Inspect, list, search or read the exact admitted immutable repository snapshot. Reviewers may also inspect its diff. Paths and line references refer to this snapshot; no host file access, edits or commands are available.',
      parameters: Type.Object({
        action: Type.Union(
          ['inspect', 'list', 'search', 'read', 'diff'].map((x) => Type.Literal(x)),
        ),
        path: Type.Optional(Type.String({ maxLength: 512 })),
        query: Type.Optional(Type.String({ maxLength: 256 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(id, args) {
        try {
          const result = await bridge('specialist.read', { tool_call_id: id, args });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: result,
          };
        } catch (error) {
          if (
            error instanceof ServiceError &&
            ['not_found', 'binary_file', 'line_limit', 'unsafe_path', 'invalid_field'].includes(
              error.code,
            )
          )
            return {
              content: [{ type: 'text' as const, text: error.message }],
              details: { error: error.code },
              isError: true,
            };
          await fail();
          throw error;
        }
      },
    });
  }
}

/** salaam_team: the team inbox. */
function registerTeam(h: House): void {
  const { pi, c, bridge } = h;
  if (c.worker_binding?.binding.tools.includes('salaam_team')) {
    pi.registerTool({
      name: 'salaam_team',
      label: 'Team inbox',
      description:
        'Send, receive or acknowledge durable messages within this task. Messages never start or continue workers; delivery and acknowledgement are distinct.',
      parameters: Type.Object({
        action: Type.Union(['send', 'receive', 'ack'].map((a) => Type.Literal(a))),
        request_id: Type.String({ maxLength: 128 }),
        recipient: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ maxLength: 4096 })),
        message_id: Type.Optional(Type.String()),
      }),
      async execute(_id, args) {
        const { action, ...body } = args;
        const result = await bridge('team.' + action, body);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }
}

/** salaam_findings: structured review findings. */
function registerFindings(h: House): void {
  const { pi, c, bridge } = h;
  if (c.worker_binding?.binding.tools.includes('salaam_findings')) {
    pi.registerTool({
      name: 'salaam_findings',
      label: 'Record review findings',
      description:
        'Publish final structured analysis over the admitted snapshot. Locations and source evidence are checked. Analysis cannot complete or verify a task.',
      parameters: Type.Object({
        findings: Type.Array(
          Type.Object({
            path: Type.String({ maxLength: 512 }),
            line: Type.Integer({ minimum: 1 }),
            end_line: Type.Optional(Type.Integer({ minimum: 1 })),
            severity: Type.Union(['critical', 'high', 'medium', 'low'].map((x) => Type.Literal(x))),
            message: Type.String({ maxLength: 2048 }),
          }),
          { maxItems: 32 },
        ),
      }),
      async execute(_id, args) {
        const result = await bridge('specialist.report', args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
        };
      },
    });
  }
}
