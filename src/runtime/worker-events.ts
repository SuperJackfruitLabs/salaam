// What the supervisor does with the records a running Pi worker emits: a transport fault fails the
// worker; each tool's activity is journalled (and PostToolUse hooks run); approval dialogs bind to
// the durable ledger; text deltas preview; a required extension or probe failure fails the worker.
import { object, toolMetadata } from '../core/index.js';
import type { Store } from '../store/index.js';
import type { ManagedWork } from '../execution/index.js';
import type { CodingWork } from '../coding/index.js';
import type { HookEvent, HookOutcome, Hooks } from '../local/index.js';
import type { StationBridge } from './station.js';
import type { PiProcess, ToolObservation } from './pi.js';
import type { Worker } from './worker.js';

export interface WorkerEventDeps {
  readonly store: Store;
  readonly managed?: ManagedWork;
  readonly station?: StationBridge;
  readonly coding?: CodingWork;
  readonly hooks?: Hooks;
  hook(
    id: string,
    event: HookEvent,
    payload: Record<string, unknown>,
    names?: readonly string[],
  ): Promise<HookOutcome | null>;
  invalidate(worker: Worker, reason: string): void;
  emit(
    event: 'preview',
    preview: { session_id: string; attempt_id: string; text: string },
  ): boolean;
}

/** An approval dialog's title names the approval and the operation digest it decides. */
const APPROVAL_TITLE = /^salaam-approval:([a-f0-9-]{36}):([a-f0-9]{64})$/;

/** Listen to a freshly launched worker's Pi process. */
export function watchWorker(s: WorkerEventDeps, worker: Worker, pi: PiProcess): void {
  pi.on('fault', () => {
    if (!worker.stopping) s.invalidate(worker, 'Pi transport failed');
  });
  watchActivity(s, worker, pi);
  watchRecords(s, worker, pi);
}

/** Each tool's start and finish is journalled once; PostToolUse hooks run after it finishes. */
function watchActivity(s: WorkerEventDeps, worker: Worker, pi: PiProcess): void {
  const { id, epoch } = worker;
  pi.on('activity', (observation: ToolObservation) => {
    if (!worker.attempt || worker.stopping) return;
    // PostToolUse runs after the tool and cannot change it; it is recorded like any hook.
    if (observation.phase === 'finished' && s.hooks) {
      const input = parsedInput(observation.input);
      void s
        .hook(
          id,
          'PostToolUse',
          {
            tool_name: observation.tool,
            tool_input: input,
            tool_use_id: observation.tool_call_id,
            tool_response: { output: observation.output ?? '', failed: !!observation.failed },
          },
          [observation.tool, ...hookAliases(observation.tool, input)],
        )
        .catch(() => {});
    }
    try {
      s.store.request(
        `tool-activity:${id}:${epoch}:${worker.attempt}`,
        `${observation.phase}:${observation.tool_call_id}`,
        observation,
        () => {
          s.store.event(id, `tool.${observation.phase}`, {
            attempt_id: worker.attempt,
            worker_epoch: epoch,
            ...observation,
            ...(observation.phase === 'started'
              ? toolMetadata(
                  observation.tool,
                  observation.input,
                  observation.tool === 'salaam_station'
                    ? s.station?.config.workspace
                    : s.coding?.workspaces.find(id)?.root,
                )
              : {}),
          });
          return { recorded: true };
        },
      );
    } catch {
      s.invalidate(worker, 'Required tool activity recording failed');
    }
  });
}

/** Approval dialogs, text previews, and the records that fail the worker. */
function watchRecords(s: WorkerEventDeps, worker: Worker, pi: PiProcess): void {
  const { id, epoch } = worker;
  pi.on('record', (record) => {
    if (
      record.type === 'extension_ui_request' &&
      record.method === 'confirm' &&
      typeof record.id === 'string'
    ) {
      const marker = typeof record.title === 'string' ? APPROVAL_TITLE.exec(record.title) : null;
      try {
        if (!marker || !s.managed) {
          pi.replyUI(record.id, false);
          return;
        }
        s.managed.bindDialog(id, epoch, marker[1]!, marker[2]!, record.id);
      } catch {
        try {
          pi.replyUI(record.id, false);
        } catch {
          // A worker that cannot take the refusal is failed below.
        }
        if (!worker.stopping) s.invalidate(worker, 'Approval dialog binding failed');
      }
    }
    if (worker.attempt && record.type === 'message_update') {
      const update = object(record.assistantMessageEvent ?? {});
      if (update.type === 'text_delta' && typeof update.delta === 'string')
        s.emit('preview', {
          session_id: id,
          attempt_id: worker.attempt,
          text: update.delta,
        });
    }
    if (record.type === 'extension_error')
      s.invalidate(worker, 'Required extension reported an error');
    if (
      record.type === 'tool_execution_end' &&
      record.toolName === 'salaam_probe' &&
      record.isError === true
    )
      s.invalidate(worker, 'Required managed probe failed');
  });
}

/** Claude Code names for Salaam's tools, so a `Bash` or `Edit|Write` matcher works unchanged. */
export function hookAliases(tool: string, input: Record<string, unknown>): string[] {
  if (tool === 'salaam_local')
    return input.action === 'command' ? ['Bash'] : input.action === 'edit' ? ['Edit', 'Write'] : [];
  if (tool === 'salaam_web_search') return ['WebSearch'];
  if (tool === 'salaam_web_fetch') return ['WebFetch'];
  if (tool === 'salaam_workspace') return ['Read'];
  return [];
}
function parsedInput(input: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(input ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
