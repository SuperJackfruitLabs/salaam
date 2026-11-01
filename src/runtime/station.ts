/** The station wire records a worker carries, and the station work members the supervisor's
 * bridge calls. AgentPod's station work implements StationBridge; the service installs it. */
export interface StationBinding {
  version: 1;
  root_digest: string;
  configuration_digest: string;
  runner: 'linux-systemd-station-v1';
  network: 'none';
  command_workspace: 'read-only-reviewed-snapshot';
}
export interface StationCall {
  id: string;
  session_id: string;
  worker_epoch: number;
  attempt_id: string | null;
  task_check_id?: string | null;
  tool_call_id: string;
  kind: 'patch' | 'check' | 'read';
  input_digest: string;
  root_digest: string;
  configuration_digest: string;
  args_json: string;
  operation_id: string | null;
  state: 'prepared' | 'dispatching' | 'returned' | 'failed' | 'outcome_unknown' | 'cancelled';
  revision: number;
  result_json: string | null;
  helper_pid?: number | null;
  helper_identity?: string | null;
  helper_state?: string;
  helper_stop_json?: string | null;
}

export interface StationBridge {
  readonly config: { workspace: string };
  ready(session: string): StationBinding;
  assertBinding(session: string, binding: StationBinding): void;
  cancelInTransaction(attempt: string): void;
  abortAttempt(attempt: string): Promise<void>;
  read(
    session: string,
    epoch: number,
    attempt: string,
    key: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  prepare(
    session: string,
    epoch: number,
    attempt: string,
    key: string,
    args: Record<string, unknown>,
  ): unknown;
  get(id: string): StationCall;
  run(id: string): unknown;
  view(id: string): unknown;
}
