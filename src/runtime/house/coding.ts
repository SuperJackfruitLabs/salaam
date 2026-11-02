// An owned coding workspace's tools: guarded file reads and patches, and durable isolated commands.
import { Type } from 'typebox';
import { ServiceError, type CodingBinding } from '../../core/protocol.js';
import type { House } from './context.js';

/** Errors the model reads as a tool result; any other one is a required-control failure. */
const normal = (error: unknown) =>
  error instanceof ServiceError &&
  [
    'unsafe_path',
    'workspace_changed',
    'workspace_busy',
    'workspace_limit',
    'workspace_conflict',
    'not_found',
    'binary_file',
    'line_limit',
    'invalid_field',
    'request_conflict',
    'command_conflict',
    'command_limit',
    'invalid_cursor',
  ].includes(error.code);

export function registerCodingTools(h: House): void {
  if (h.c.coding) {
    registerFiles(h, h.c.coding);
    registerCommand(h, h.c.coding);
  }
}

/** salaam_files: inspect, read and patch the owned workspace. */
function registerFiles(h: House, coding: CodingBinding): void {
  const { pi, bridge, fail } = h;
  if (coding.files)
    pi.registerTool({
      name: 'salaam_files',
      label: 'Guarded workspace files',
      description:
        'Inspect/list/search/read an owned workspace or patch one UTF-8 file. Read returns one-based line references and a file hash. Before patching, inspect/read current revision and hash. expected_hash=null creates a new file, content=null deletes one. The source checkout and Git metadata stay outside this workspace.',
      parameters: Type.Object({
        action: Type.Union(
          ['inspect', 'list', 'search', 'read', 'patch'].map((value) => Type.Literal(value)),
        ),
        path: Type.Optional(Type.String({ maxLength: 512 })),
        query: Type.Optional(Type.String({ maxLength: 256 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        expected_revision: Type.Optional(Type.Integer({ minimum: 0 })),
        expected_hash: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        content: Type.Optional(Type.Union([Type.String({ maxLength: 262144 }), Type.Null()])),
      }),
      async execute(id, params) {
        try {
          const result = await bridge<Record<string, unknown>>('coding.files', {
            tool_call_id: id,
            args: params,
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
            isError: params.action === 'patch' && result.state !== 'applied',
          };
        } catch (error) {
          if (!normal(error)) {
            await fail();
            throw error;
          }
          return {
            content: [{ type: 'text', text: (error as Error).message }],
            details: { error: (error as ServiceError).code },
            isError: true,
          };
        }
      },
    });
}

/** salaam_command: durable commands in a disposable copy of the workspace. */
function registerCommand(h: House, coding: CodingBinding): void {
  const { pi, bridge, fail } = h;
  if (coding.commands)
    pi.registerTool({
      name: 'salaam_command',
      label: 'Durable isolated command',
      description:
        'Start/status/logs/cancel a command in a bounded, network-disabled disposable copy of the owned workspace. Use a stable step_key for retries: the same key returns the original run, never resends work. Supply the inspected expected_revision. Command edits are disposable; use salaam_files patch for durable changes. Commands are limited to 30 seconds and 64 KiB output. Start waits for the recorded outcome; clients may detach and inspect its stable run_id.',
      parameters: Type.Object({
        action: Type.Union(
          ['start', 'status', 'logs', 'cancel'].map((value) => Type.Literal(value)),
        ),
        step_key: Type.Optional(Type.String({ maxLength: 128 })),
        command: Type.Optional(Type.String({ maxLength: 8192 })),
        cwd: Type.Optional(Type.String({ maxLength: 512 })),
        expected_revision: Type.Optional(Type.Integer({ minimum: 0 })),
        run_id: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      async execute(id, params, signal) {
        try {
          let result = await bridge<Record<string, unknown>>('coding.command', {
            tool_call_id: id,
            args: params,
          });
          if (params.action === 'start') {
            while (
              ![
                'succeeded',
                'failed',
                'cancelled',
                'timed_out',
                'output_limited',
                'interrupted',
                'outcome_unknown',
              ].includes(String(result.state))
            ) {
              if (signal?.aborted)
                throw new Error('Command tool detached; inspect the durable run');
              await new Promise((resolve) => setTimeout(resolve, 100));
              result = await bridge<Record<string, unknown>>('coding.command', {
                tool_call_id: id,
                args: { action: 'status', run_id: result.id },
              });
            }
            const logs = await bridge('coding.command', {
              tool_call_id: id,
              args: { action: 'logs', run_id: result.id, offset: 0 },
            });
            result = { ...result, logs };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            details: result,
            isError: params.action === 'start' && result.state !== 'succeeded',
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!normal(error)) {
            await fail();
            throw error;
          }
          return {
            content: [{ type: 'text', text: (error as Error).message }],
            details: { error: (error as ServiceError).code },
            isError: true,
          };
        }
      },
    });
}
