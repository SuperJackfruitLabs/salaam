/** What a worker is bound to: profile, grant, runtime and capabilities. Pure; imports only types
 * and data that themselves import nothing from src. */
import type { HarnessTarget } from './harness-targets.js';
import type { ProviderRoute } from './provider-route.js';

export interface AgentProfile {
  schema_version: 1;
  id: string;
  revision: number;
  tools: readonly string[];
  max_depth: number;
  role?: 'explorer' | 'reviewer' | 'builder' | 'tester' | 'integrator';
  description?: string;
  prompt?: string;
  max_requests?: number;
  provider?: string;
  model?: string;
  source_digest?: string;
}
export interface AgentGrant {
  schema_version: 1;
  id: string;
  owner_session: string;
  profile: AgentProfile;
  profile_digest: string;
  route: ProviderRoute;
  output_cap: boolean;
  facts: { id: string; kind: string; text: string }[];
}
/** One agent admission a session holds, as its snapshot reports it. */
export interface AgentGrantSnapshot {
  grant_id: string;
  profile_id: string;
  revision: number;
  profile_digest: string;
  tools: readonly string[];
  role: AgentProfile['role'];
  route: ProviderRoute;
  output_cap: boolean;
  selected_facts: string[];
  state: string;
}
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
/** Local contract v1. These are enforced capabilities, not upstream feature claims. */
export const NATIVE_CAPABILITIES = {
  schema_version: 1,
  runtime: 'native-pi',
  model_requests: true,
  output_cap: 'authentication-dependent',
  usage_receipts: true,
  resume_dispatch: false,
  confirmed_stop: false,
  files: false,
  commands: false,
  isolation: 'managed-process-no-coding-authority',
  retention: 'durable-local',
} as const;
export const DIAGNOSTIC_PROFILE = {
  schema_version: 1,
  id: 'salaam/diagnostic',
  revision: 1,
  tools: ['salaam_probe'],
  max_depth: 1,
} as const;
export function nativeCapabilities(
  profile: AgentProfile,
  coordination = false,
  isolation?: WorkerBinding['isolation'],
) {
  const caps = profile.role
    ? {
        ...NATIVE_CAPABILITIES,
        repository_read: profile.tools.includes('salaam_repository'),
        findings: profile.tools.includes('salaam_findings'),
      }
    : NATIVE_CAPABILITIES;
  return {
    ...caps,
    ...(coordination ? { team_messages: true } : {}),
    ...(isolation
      ? {
          files: profile.tools.includes('salaam_files'),
          commands: profile.tools.includes('salaam_command'),
          isolation:
            isolation.execution.evidence === 'fixture'
              ? 'simulated-owned-copy'
              : 'owned-copy-and-proven-executor',
          execution_profile: isolation.execution.profile_digest,
          execution_engine: isolation.execution.engine_id,
        }
      : {}),
  };
}

export function externalCapabilities(runtime: ExternalRuntime, tools: readonly string[]) {
  return {
    schema_version: 1 as const,
    runtime: runtime.kind,
    model_requests: false as const,
    output_cap: runtime.output_cap,
    files: runtime.files && tools.includes('salaam_files'),
    commands: runtime.commands && tools.includes('salaam_command'),
    model_usage: 'unknown' as const,
    isolation:
      runtime.kind === 'a2a'
        ? 'remote-peer-no-local-tool-authority'
        : runtime.evidence === 'fixture'
          ? 'simulated-whole-runtime'
          : 'proven-whole-runtime',
  };
}
export interface WorkerBinding {
  schema_version: 1;
  worker_id: string;
  runtime: 'native-pi' | 'harness' | 'a2a';
  owner_session: string;
  owner_task: string | null;
  parent_attempt: string;
  step_key: string;
  session_id: string;
  attempt_id: string;
  input_digest: string;
  input_artifact: string | null;
  profile: AgentProfile;
  profile_digest: string;
  capabilities: ReturnType<typeof nativeCapabilities> | ReturnType<typeof externalCapabilities>;
  capability_digest: string;
  tools: string[];
  route: ProviderRoute | null;
  workspace: { id: string; revision: number; digest: string } | null;
  policy_digest: string;
  bounds: { scope: 'model-requests'; requests: number } | { scope: 'invocations'; invocations: 1 };
  external?: ExternalRuntime;
  legacy: boolean;
  agent?: AgentGrant;
  repository?: { artifact_id: string; base_artifact: string; digest: string };
  assignment?: { id: string; generation: number };
  isolation?: {
    workspace_id: string;
    baseline_artifact: string;
    digest: string;
    execution: { profile_digest: string; engine_id: string; evidence: 'proven' | 'fixture' };
  };
}
export interface WorkerBoundaryView {
  binding: WorkerBinding;
  binding_digest: string;
  generation: number;
  worker_epoch: number | null;
  dispatch_state: 'intent' | 'dispatching' | 'accepted' | 'interrupted' | 'terminal';
}
