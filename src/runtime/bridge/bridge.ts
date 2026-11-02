// The worker bridge: the requests a running Pi worker sends back to Salaam (tool, model, policy and
// operation requests). The supervisor authenticates each one and checks readiness; then the first
// route whose method matches handles it. Each handler gets only the collaborators it needs.
import { ServiceError } from '../../core/index.js';
import type { McpWorkerBinding } from '../../mcp/index.js';
import type { McpServerProvenance, ProviderRoute } from '../../core/index.js';
import type { ToolkitWorkerBinding } from '../../toolkit/index.js';
import type { StationBinding } from '../station.js';

/** What a handler sees of the supervised worker that sent the request. Handlers record what the
 * worker was granted (its provider's output cap, the secrets to redact) on it. */
export interface BridgeWorker {
  readonly epoch: number;
  readonly route: ProviderRoute;
  readonly binding: string;
  readonly attempt?: string;
  readonly compaction?: string;
  readonly mcp?: McpWorkerBinding;
  readonly operatorMcp?: McpServerProvenance[];
  readonly toolkit?: ToolkitWorkerBinding;
  readonly station?: StationBinding;
  providerOutputCap?: boolean;
  secrets?: string[];
}

export interface BridgeRequest {
  /** The worker's session. */
  id: string;
  method: string;
  body: Record<string, unknown>;
  w: BridgeWorker;
}

/** A reply the bridge hands back without awaiting it, as it always has for these calls: if it is
 * a promise that rejects, the worker gets that error as it is, outside the required-control
 * handling (no refusal record, no worker failure). */
export class Unawaited {
  constructor(readonly value: unknown) {}
}
export const unawaited = (value: unknown): Unawaited => new Unawaited(value);

/** Handles one kind of request. Whatever it throws, or the promise it returns rejects with, goes
 * through the required-control handling; a reply wrapped in `unawaited` does not. */
export type BridgeHandler = (request: BridgeRequest) => unknown;

export interface BridgeRoute {
  matches(method: string): boolean;
  handle: BridgeHandler;
}

export const exact =
  (...methods: string[]) =>
  (method: string): boolean =>
    methods.includes(method);
export const prefix =
  (start: string) =>
  (method: string): boolean =>
    method.startsWith(start);

/** Errors a local tool call returns to the model as feedback; any other one fails the worker.
 * Every code src/local/edits.ts can throw belongs here (a failed replacement is not a crash). */
export const LOCAL_TOOL_ERRORS = [
  'local_busy',
  'workspace_read_failed',
  'unsafe_path',
  'edit_mismatch',
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
  'shell_binding',
  'listen_unreachable',
];

/** For each kind of request, the error codes that reach the worker as they are: the model reads
 * them as a tool's result. Any other failure is a broken required control. */
const FEEDBACK: [matches: (method: string) => boolean, codes: readonly string[]][] = [
  [
    prefix('station.'),
    [
      'invalid_field',
      'request_conflict',
      'station_files_changed',
      'station_scope',
      'station_call_limit',
      'station_busy',
      'not_found',
    ],
  ],
  [
    prefix('operator_mcp.'),
    [
      'invalid_field',
      'invalid_mcp_server',
      'invalid_mcp_tool',
      'invalid_mcp_arguments',
      'mcp_server_failed',
    ],
  ],
  [
    (method) => method.startsWith('mcp.') || method.startsWith('toolkit.'),
    [
      'invalid_field',
      'invalid_mcp_call',
      'invalid_mcp_arguments',
      'invalid_mcp_server',
      'invalid_mcp_tool',
      'mcp_tool_unadmitted',
      'mcp_input_limit',
      'mcp_call_limit',
      'invalid_toolkit_request',
      'toolkit_busy',
      'request_conflict',
    ],
  ],
  [
    prefix('specialist.'),
    [
      'not_found',
      'binary_file',
      'line_limit',
      'invalid_field',
      'local_busy',
      'workspace_read_failed',
      'unsafe_path',
      'request_conflict',
    ],
  ],
  // A hook that blocked a tool call is the person's policy speaking, not a broken control: the
  // model reads the reason as the tool's result (Phase 4b).
  [() => true, ['hook_blocked']],
  [(method) => method.startsWith('coding.') || method.startsWith('local.'), LOCAL_TOOL_ERRORS],
  [exact('history'), ['not_found', 'invalid_field']],
  [
    prefix('child.'),
    [
      'budget_exhausted',
      'child_limit',
      'depth_exceeded',
      'authority_denied',
      'spawn_conflict',
      'invalid_budget',
      'invalid_child',
      'result_unavailable',
      'not_found',
      'request_conflict',
    ],
  ],
];

/** Whether this failure of a `method` request is feedback for the model rather than a broken
 * required control. */
export function isFeedback(method: string, error: unknown): error is ServiceError {
  return (
    error instanceof ServiceError &&
    FEEDBACK.some(([matches, codes]) => matches(method) && codes.includes(error.code))
  );
}
