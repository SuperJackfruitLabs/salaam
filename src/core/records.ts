/** Record shapes shared by the protocol, the store and the features that own them. Pure types;
 * imports nothing from src. */

export type FailureKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'bad_request'
  | 'context_exhausted'
  | 'timeout'
  | 'provider_unavailable'
  | 'refusal'
  | 'max_tokens'
  | 'cancelled'
  | 'node_offline'
  | 'harness_exited'
  | 'harness_disconnected'
  | 'unknown';
export interface AcpFailure {
  version: 1;
  kind: FailureKind;
  code: string;
  message: string;
  sessionId?: string;
  requestId?: string;
  attemptId?: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable?: boolean;
  truncated?: boolean;
}
export interface AttemptOutcome {
  version: 1;
  stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'cancelled' | 'error' | 'interrupted';
  failure?: AcpFailure;
}
/** Public provenance for one server a session got. Never carries resolved secrets. */
export interface McpServerProvenance {
  name: string;
  source: 'operator' | 'agentpod';
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  endpoint_digest?: string;
  declaration_digest: string;
}
export interface InstructionFile {
  scope: 'user' | 'project';
  /** Shown to people: relative to the session folder, or ~/… for the user file. */
  path: string;
  sha256: string;
  bytes: number;
  text: string;
}
export interface InstructionSkip {
  path: string;
  reason: string;
}
export interface InstructionsSummary {
  digest: string;
  revision: number;
  files: Omit<InstructionFile, 'text'>[];
  skipped: InstructionSkip[];
}
export interface InboxEntry {
  id: string;
  session_id: string;
  source_key: string;
  kind: string;
  detail: string;
  revision: number;
  state: string;
  ack_revision: number;
  updated_at: number;
}
export interface RecurringOccurrence {
  id: string;
  job_id: string;
  occurrence_key: string;
  session_id: string;
  job_run_id: string | null;
  schedule_revision: number;
  due_at: number | null;
  state: string;
  error: string | null;
  created_at: number;
}
export interface Job {
  id: string;
  task_id: string;
  session_id: string;
  name: string;
  revision: number;
  binding: Record<string, unknown>;
  binding_digest: string;
  max_steps: number;
  compact: boolean;
  state: string;
  reason: string;
  created_at: number;
}
export interface JobOccurrence {
  id: string;
  job_id: string;
  occurrence_key: string;
  binding_digest: string;
  state: string;
  reason: string;
  created_at: number;
  updated_at: number;
}
export interface TaskCheck {
  key: string;
  command: string;
  cwd: string;
}
export interface TaskLimits {
  /** Explicit opt-in for opaque runtimes. Omission never grants an invocation. */
  invocations?: number;
  requests: number;
  runtime_ms: number;
  concurrency: number;
  token_units: number | null;
  input_token_bound: number;
  output_token_bound: number | null;
  verification_runs: number;
}
/** Item 8: checks required at completion, next to the acceptance checks. The critic is not yet
 * admitted, so it is always null. */
export interface CompletionGate {
  /** The built-in reviewer judges the verified deliverables against this rubric. */
  critic: { rubric: string } | null;
  hooks: TaskCheck[];
}
export interface TaskPolicy {
  acceptance: TaskCheck[];
  deliverables: string[];
  limits: TaskLimits;
  /** Present only when the plan declares one, so a plan without it keeps its exact shape. */
  completion_gate?: CompletionGate;
}
export interface StepPlan {
  key: string;
  title: string;
  instruction: string;
  depends_on: string[];
  checks?: string[];
}
export interface WorkStep extends StepPlan {
  id: string;
  state:
    | 'pending'
    | 'queued'
    | 'running'
    | 'awaiting_review'
    | 'interrupted'
    | 'failed'
    | 'cancelled'
    | 'completed';
  attempt_id: string | null;
  review: string | null;
}
export interface WorkTask extends TaskPolicy {
  id: string;
  session_id: string;
  revision: number;
  plan_revision: number;
  state:
    | 'accepted'
    | 'running'
    | 'blocked'
    | 'verifying'
    | 'waiting_for_person'
    | 'waiting_for_child'
    | 'waiting_for_infrastructure'
    | 'succeeded'
    | 'succeeded_with_exception'
    | 'failed'
    | 'partially_completed'
    | 'cancelled';
  objective: string;
  constraints: string[];
  reason: string;
  steps: WorkStep[];
  runtime?: Record<string, unknown>;
  verification?: Record<string, unknown>;
}
export interface WorkspaceFile {
  content: string;
  executable: boolean;
}
export type WorkspaceTree = Record<string, WorkspaceFile>;
export interface CheckReceipt {
  id: string;
  task_id: string;
  step_id: string | null;
  check_key: string;
  plan_revision: number;
  workspace_id: string;
  workspace_revision: number;
  workspace_digest: string;
  profile_digest: string;
  engine_id: string;
  command_run_id: string | null;
  state: string;
  artifact_id: string | null;
}
