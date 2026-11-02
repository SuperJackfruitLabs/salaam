// A station root worker's tools: read-only board reads, and the protected station workspace whose
// patches a person approves and whose checks run isolated.
import { Type } from 'typebox';
import type { Approval, Operation } from '../../core/protocol.js';
import type { BoardRead } from '../board-reads.js';
import type { StationCall } from '../station.js';
import type { House } from './context.js';

export function registerStationTools(h: House): void {
  registerBoard(h);
  registerStation(h);
}

/** salaam_board: read-only reads of this card, its runs and the library. */
function registerBoard(h: House): void {
  const { pi, c, bridge } = h;
  if (c.station && !c.child)
    pi.registerTool({
      name: 'salaam_board',
      label: 'This card, its runs and the library',
      description:
        "Read-only: read this run's own card and handoff (card), its earlier runs (attempts), or search and open library items (library_search {query}, library_get {item_id}). Served by the board through Salaam; you never name a card, board or credential, and it never asks for approval because it changes nothing.",
      parameters: Type.Object({
        action: Type.Union(
          ['card', 'attempts', 'library_search', 'library_get'].map((a) => Type.Literal(a)),
        ),
        query: Type.Optional(Type.String({ maxLength: 500 })),
        item_id: Type.Optional(Type.String({ pattern: '^itm_[0-9a-f]{16}$' })),
      }),
      async execute(toolCallId, params, signal) {
        type Read = BoardRead;
        let read = await bridge<Read>('board.read', { tool_call_id: toolCallId, args: params });
        const deadline = Date.now() + 90_000;
        while (read.state === 'pending') {
          if (signal?.aborted) throw Error('Board read cancelled');
          if (Date.now() > deadline)
            return {
              content: [
                { type: 'text', text: 'The board did not answer in time; carry on without it.' },
              ],
              details: { read_id: read.id, state: 'timeout', ok: false as boolean | undefined },
              isError: true,
            };
          await new Promise((r) => setTimeout(r, 500));
          read = await bridge<Read>('board.status', { read_id: read.id });
        }
        return {
          content: [
            { type: 'text', text: read.ok ? (read.text ?? '') : (read.error ?? 'Refused') },
          ],
          details: { read_id: read.id, state: read.state, ok: read.ok },
          isError: !read.ok,
        };
      },
    });
}

/** salaam_station: the protected station workspace. */
function registerStation(h: House): void {
  const { pi, c, bridge } = h;
  if (c.station && !c.child)
    pi.registerTool({
      name: 'salaam_station',
      label: 'Protected station workspace',
      description:
        'Inspect/list/read the declared station workspace progressively. Patch requires exact expected_tree, expected_hash (null for a new file), content (null to delete), an optional one-line reason shown to the person approving it, and an operation-bound human approval. Check runs in an isolated OS identity with no network against a read-only filtered snapshot, and succeeds only while the original root revision stays current. No arbitrary mounts, environment, credentials or control sockets are exposed.',
      parameters: Type.Object({
        action: Type.Union(
          ['inspect', 'list', 'search', 'read', 'patch', 'check'].map((a) => Type.Literal(a)),
        ),
        path: Type.Optional(Type.String({ maxLength: 512 })),
        query: Type.Optional(Type.String({ maxLength: 256 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        expected_tree: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
        expected_hash: Type.Optional(
          Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()]),
        ),
        content: Type.Optional(Type.Union([Type.String({ maxLength: 16384 }), Type.Null()])),
        // One line, for the person approving the patch: why this write.
        reason: Type.Optional(Type.String({ maxLength: 300 })),
        command: Type.Optional(Type.String({ maxLength: 8192 })),
      }),
      async execute(toolCallId, params, signal, _update, ctx) {
        if (['inspect', 'list', 'search', 'read'].includes(params.action)) {
          const result = await bridge('station.read', { tool_call_id: toolCallId, args: params });
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: { result } };
        }
        type Result = {
          call: StationCall;
          operation?: Operation;
          approval?: Approval;
          result: unknown;
        };
        const created = await bridge<Result>('station.prepare', {
          tool_call_id: toolCallId,
          args: params,
        });
        if (created.approval && created.operation && created.approval.state === 'pending')
          await ctx.ui.confirm(
            `salaam-approval:${created.approval.id}:${created.operation.operation_digest}`,
            `${created.operation.target}\n${created.operation.value}\nBinding: ${created.operation.target_version}`,
            { signal },
          );
        let result = await bridge<Result>('station.run', { call_id: created.call.id });
        while (['prepared', 'dispatching'].includes(result.call.state)) {
          if (signal?.aborted) throw Error('Station work cancelled');
          await new Promise((r) => setTimeout(r, 75));
          result = await bridge<Result>(
            result.call.state === 'prepared' ? 'station.run' : 'station.status',
            { call_id: created.call.id },
          );
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ state: result.call.state, result: result.result }),
            },
          ],
          details: { call_id: result.call.id, state: result.call.state, result: result.result },
          isError: result.call.state !== 'returned',
        };
      },
    });
}
