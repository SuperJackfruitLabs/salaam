import type { ExternalRuntime, WorkerBinding, WorkspaceTree } from '../core/index.js';

/** What external work reads from a backend's checkpoint. Each backend's own checkpoint (the
 * harness's, the A2A peer's) carries these fields; only an A2A peer's has a run. */
export interface ExternalCheckpoint {
  dialect: string;
  worker_id: string;
  attempt_id: string;
  run_id?: string;
  state: string;
}

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
