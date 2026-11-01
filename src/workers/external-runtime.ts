import type { HarnessCheckpoint } from '../harness/protocol.js';
import type { ExternalRuntime, WorkerBinding } from '../core/worker-binding.js';
import type { WorkspaceTree } from '../core/records.js';
import type { A2ACheckpoint } from '../a2a/protocol.js';

export type ExternalCheckpoint = HarnessCheckpoint | A2ACheckpoint;

export interface ExternalHooks {
  failed(error: Error): void;
  modelRequest(id: string, bytes: number, output: number): void;
  checkpoint(value: ExternalCheckpoint): undefined;
  receipt(value: unknown): undefined;
  permission(method: string, params: Record<string, unknown>): Promise<'approve' | 'deny'>;
  toolResult(id: string, success: boolean, receipt: unknown): void;
  assertActive(): void;
}
export interface ExternalBackend {
  prepare?(): Promise<void>;
  close?(): Promise<void>;
  runtimes(): ExternalRuntime[];
  validate(runtime: ExternalRuntime): void;
  assertAuthority?(runtime: ExternalRuntime, tools: readonly string[]): void;
  execute(
    binding: WorkerBinding,
    run: string,
    prompt: string,
    tree: WorkspaceTree,
    hooks: ExternalHooks,
  ): Promise<{ result: unknown }>;
  /** Read only after stop has confirmed all owned processes are gone. */
  collect(run: string, runtime: ExternalRuntime): WorkspaceTree;
  /** Must reconcile owned resources by durable run ID even if creation's reply was lost. */
  stop(run: string, runtime: ExternalRuntime, receipt: unknown): Promise<unknown>;
}
