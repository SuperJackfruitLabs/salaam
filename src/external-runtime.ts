import type { HarnessCheckpoint } from './harness-protocol.js';
import type { HarnessTarget } from './harness-probe.js';
import type { WorkerBinding } from './worker-boundary.js';
import type { WorkspaceTree } from './workspaces.js';
import type { A2ACheckpoint } from './a2a-protocol.js';

export type ExternalCheckpoint = HarnessCheckpoint | A2ACheckpoint;

/** Operator configuration only. Project profiles cannot select executables, endpoints or credentials. */
export interface ExternalRuntime {
  id: string;
  kind: 'harness' | 'a2a';
  target: HarnessTarget | 'a2a';
  version: string;
  config_digest: string;
  adapter_digest: string;
  execution_identity: { version: string; kernel: string; arch: string };
  boundary_digest: string;
  engine_id: string;
  evidence: 'proven' | 'fixture';
  model_usage: 'unknown';
  provider_route?: { provider: string; model: string; wire: string; wire_model: string };
  output_cap: number | null;
  max_model_requests: number | null;
  files: boolean;
  commands: boolean;
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
