const commands: Record<string, string> = {
  a2a: `salaam a2a credential PEER_ID --file NEW_OWNER_ONLY_FILE
salaam a2a discover --peer ID --endpoint URL --card-url URL --credential-file FILE --addresses IP[,IP] [--local]
salaam a2a pin --peer ID --endpoint URL --card-url URL --card-file REVIEWED_JSON --credential-file FILE --addresses IP[,IP] --skill SKILL [--tenant TENANT --files PATH[,PATH] --local]
salaam a2a peers
salaam a2a grant --assignment ID --peer ID --credential-file OWNER_ONLY_JSON [--tenant TENANT --skill SKILL] [--peer-client openclaw-2026.10.5]
salaam a2a inspect CHILD_ID
salaam a2a reconcile CHILD_ID --run-id EXACT_RUN_ID

Use --a2a-config FILE for outbound peers and --a2a-listen-config FILE for private
inbound one-use analysis grants. Peer credentials grant no human/operator powers.
Remote internal model usage and execution remain unobserved.`,
  harness: `salaam harness probe --pin FILE
salaam harness prepare --runtime-root NEW_DIR --arch linux-arm64|linux-x64
salaam harness config --target TARGET --runtime-root PREPARED_DIR [--id ID]
salaam harness list
salaam harness inspect CHILD_ID
salaam harness reconcile CHILD_ID --run-id RUN_ID

Negotiate an operator-pinned external harness in a disposable empty home, with no
repository, credentials or model request. FILE contains target, executable,
executable_digest and version. Targets: gemini-acp, claude-acp, codex-app-server.
Advertised capabilities are separate from enforced authority. A probe grants no
file, command or worker-dispatch permission. A service started with an owner-only
--harness-config FILE runs fresh Docker readiness proofs before admitting configured
targets. Reconcile confirms stopped resources; it never resends a prompt.`,
  workers: `salaam workers proposal CHILD_ID [--offset N]
salaam workers integrate CHILD_ID --revision N --root-digest SHA256 --patch-digest SHA256
salaam workers integration RECEIPT_ID
salaam workers resolve RECEIPT_ID --revision N --root-digest SHA256

Writing specialists use private drafts. Review every proposal page and the root digest before integration.
Integration does not verify a task. Resolution explicitly admits a new apply only against its unchanged original root.
Mutations accept --request-id ID and --takeover.`,
  team: `salaam team show TASK_ID
salaam team assign TASK_ID --step STEP_ID --profile PROFILE_ID --requests N --revision N
salaam team assign TASK_ID --step STEP_ID --profile PROFILE_ID --runtime RUNTIME_ID --invocations 1 --revision N
salaam team run TASK_ID --assignment ID --generation N --revision N [--instruction TEXT --continues ATTEMPT_ID]
salaam team send TASK_ID --to ASSIGNMENT_ID --text TEXT
salaam team receive TASK_ID --assignment ID
salaam team ack TASK_ID --assignment ID --message MESSAGE_ID
salaam team reject TASK_ID --assignment ID --generation N --revision N --reason TEXT

Mutations accept --request-id ID and --takeover. Claims bind the plan, admitted profile and generation.
Messages never wake workers. Use run for an explicit new claim or follow-up.
External assignments require a task with explicit limits.invocations and
token_units:null. Their internal model usage is reported as unknown.`,
  agents: `salaam agents list --session SESSION_ID
salaam agents inspect PROFILE_ID --session SESSION_ID
salaam agents admit PROFILE_ID --session SESSION_ID --digest REVIEWED_DIGEST [--facts ID,ID]
salaam agents revoke GRANT_ID --session SESSION_ID

Profiles are data in .salaam/agents/*.md with JSON front matter and a prompt body.
Inspect the effective tools and digest before admission. Project definitions cannot
grant themselves authority. Mutations accept --request-id and --takeover.`,
  tui: `salaam tui [--session SESSION_ID] [--observe|--takeover] [--theme night|paper]
           [--cwd DIR] [--coding-root PRIVATE_DIR] [--coding-socket DOCKER_SOCKET]

Bare sal opens the same Salaam terminal interface in a TTY.
Ctrl+K actions · Ctrl+P sessions · Ctrl+N new · Ctrl+O approvals
Ctrl+G changes · Ctrl+T commands · Ctrl+E external editor · Ctrl+C detach.
Work continues in the service when the terminal closes.`,
  remote: `salaam remote SSH_HOST [--remote-bin ABSOLUTE_PATH] [--state REMOTE_DIR]
              [--session SESSION_ID] [--observe|--takeover] [--theme night|paper]

Open the Salaam TUI over SSH on an existing execution host. The remote binary
must be installed already. State paths belong to that host. No key is copied;
the host-local service owns the session. SSH agent forwarding is disabled.`,
  workspace: `salaam workspace inspect SESSION_ID
salaam workspace diff SESSION_ID
salaam workspace refresh SESSION_ID --revision N --digest REVIEWED_OBSERVED_DIGEST [--takeover]

Inspect an owned coding copy, print its checked diff, or acknowledge exact human edits.
The source checkout stays outside the writable coding workspace.`,
  commands: `salaam commands list SESSION_ID
salaam commands start SESSION_ID --step-key KEY --command TEXT --revision N [--cwd RELATIVE_DIR]
salaam commands inspect SESSION_ID --run-id UUID
salaam commands logs SESSION_ID --run-id UUID [--offset BYTES]
salaam commands cancel SESSION_ID --run-id UUID [--takeover]
salaam commands reconcile SESSION_ID --run-id UUID [--takeover]

Commands use a proven executor and a disposable working copy. Persist edits with the
guarded file tool. A repeated step key returns the same run without executing again.`,
  execution: `salaam execution prove --docker-socket PATH --scratch-root DIR --report PATH
salaam execution cleanup --docker-socket PATH --run-id UUID

Run the M9.1 boundary proof on a pre-provisioned local Linux Docker engine.
Only disposable fixtures are mounted. The pinned image must already be present.
No coding tools are enabled. A failed/unavailable backend exits nonzero.
Cleanup reconciles the saved proof run without replaying commands.`,
  acp: `salaam acp [--state DIR] [--coding]

Run the ACP v1 stdio client adapter against an already running Salaam service.
--coding creates owned coding sessions; the service must have --coding-root.
Loading an existing session preserves its original tool authority.`,
  artifacts: `salaam artifacts put SESSION_ID --text TEXT [--request-id ID] [--takeover]

Persist text evidence; reference its returned artifact ID in a task evidence fact.
Read it with salaam history read SESSION_ID --artifact-id ID.`,
  host: `salaam host plan --config FILE > host-manifest.json
chmod 600 host-manifest.json
salaam host inspect --manifest host-manifest.json
salaam host unit --manifest host-manifest.json --platform systemd|launchd
salaam host run --manifest host-manifest.json
salaam host start --manifest host-manifest.json

Config requires absolute state, coding_root and coding_socket paths; optional
provider, model, max_output_tokens and workspace_id. Planning probes the existing
executor and pins Node, source/build, Pi, provider, profile and engine identity.
Review generated units before installing with your host's service manager. No key
is stored in the manifest: configure it in the service user's credential home.
Run uses an exclusive supervisor lock, durable health, bounded restart/backoff,
and refuses source/build or executor drift before the daemon admits work.

For a bound AgentPod host, use mode="agentpod", state and agentpod_config instead
of coding_root/coding_socket. This profile enables no station tools. The private
manifest pins Node, CLI, source/build, Pi, provider and authority pins. Invoke the
canonical Node executable explicitly. host start waits for matching live health
and safely coalesces concurrent callers; it never installs or upgrades packages.`,
  schedules: `salaam schedules create TASK_ID --name NAME --revision N --max-steps N [--schedule FILE] [--compact]
salaam schedules list [--offset N]
salaam schedules inspect JOB_ID
salaam schedules occurrences JOB_ID [--offset N]
salaam schedules run JOB_ID --key STABLE_KEY --revision N
salaam schedules update JOB_ID --revision N --status active|paused|cancelled [--schedule FILE]

Capture a reviewed immutable plan and workspace template. Every occurrence receives
fresh session/task/workspace IDs. Omit --schedule for explicit triggers only.
FILE: {"kind":"interval","anchor":1792281600000,"every_ms":3600000,"missed":"skip","max_catch_up":1}
Daily schedules require time HH:mm, timezone IANA, gap skip, fold first|second,
missed skip|catch_up, and max_catch_up 1–8. Updates append a revision and restart
the cursor from now. Pausing stops future admission; cancellation also revokes active work.
Mutations accept --request-id and --takeover. Unknown work prevents overlap.`,
  inbox: `salaam inbox list [--offset N]
salaam inbox inspect ITEM_ID
salaam inbox ack ITEM_ID --revision N [--request-id ID] [--takeover]

Shared durable attention for approvals, unknown effects, infrastructure, checks
and task results. Acknowledgement clears only the inspected revision; it never
approves an operation, retries work or marks a task successful.`,
  jobs: `salaam jobs create TASK_ID --name NAME --revision TASK_REVISION --max-steps N [--compact]
salaam jobs list [--offset N]
salaam jobs inspect JOB_ID
salaam jobs run JOB_ID --key STABLE_OCCURRENCE_KEY --revision JOB_REVISION
salaam jobs occurrence OCCURRENCE_ID
salaam jobs cancel JOB_ID --revision JOB_REVISION

Mutations accept --request-id ID and --takeover. A job binds one reviewed, unstarted
checked task, workspace, provider/executor profile and bounded progression grant.
Its one logical occurrence survives retries and daemon replacement; changing the key
cannot create a second run. Interrupted work requires explicit task continuation.
Use schedules for fresh recurring occurrences. Public trigger gateways remain disabled.`,
  tasks: `salaam tasks create SESSION_ID --plan FILE --revision 0
salaam tasks current SESSION_ID
salaam tasks inspect TASK_ID
salaam tasks history TASK_ID [--offset N]
salaam tasks revise TASK_ID --plan FILE --revision TASK_REVISION
salaam tasks run TASK_ID --step STEP_ID --revision TASK_REVISION [--text INSTRUCTION]
                 [--continue-attempt INTERRUPTED_ATTEMPT_ID]
salaam tasks complete TASK_ID --step STEP_ID --revision TASK_REVISION --review TEXT
salaam tasks verify TASK_ID --check KEY --revision N [--step STEP_ID]
salaam tasks finish TASK_ID --revision N [--exception-reason TEXT --evidence-artifact ID]
salaam tasks checkpoint TASK_ID --revision N
salaam tasks checkpoints TASK_ID
salaam tasks restore TASK_ID --checkpoint ID --revision N --workspace-revision N --workspace-digest DIGEST
salaam tasks restores TASK_ID
salaam tasks auto TASK_ID --revision N --max-steps N [--compact]
salaam tasks pause TASK_ID --revision N
salaam tasks cancel TASK_ID --revision N

Mutations accept --request-id ID and --takeover. Reuse the same request ID and input
when retrying a lost response. One task per session. Automatic progression is opt-in
and bounded by step, request, runtime, concurrency and declared token limits.
Plans may explicitly set limits.token_units to null to disable token budgeting;
request/runtime limits and approvals still apply. Unsupported output caps are rejected.
Success requires fresh command receipts and deliverables at the exact workspace revision.
Operator exceptions are reported separately. Checkpoints preserve conflicting human edits.
Legacy task facts remain under the singular task command.`,
  task: `salaam task inspect SESSION_ID
salaam task update SESSION_ID --task-version N --kind objective|constraint|completed|outstanding|evidence --text TEXT
                          [--supersedes FACT_ID] [--artifact-id ID] [--request-id ID] [--takeover]

Updates are explicit and versioned. Corrections retain the original fact and its provenance.`,
  history: `salaam history read SESSION_ID [--artifact-id ID|--entry-id ID] [--offset N]

Read bounded evidence/history pages, including entries preceding compaction.`,
  compactions: `salaam compactions inspect COMPACTION_ID
salaam compactions cancel COMPACTION_ID [--takeover] [--request-id ID]`,
  providers: `salaam providers list

List every provider in the pinned Pi registry, its chat APIs and auth methods.
Catalog support does not imply live account access or verification.`,
  models: `salaam models list [PROVIDER]

List pinned chat model IDs without network requests or credentials.`,
  auth: `salaam auth set PROVIDER
salaam auth login PROVIDER [--oauth]
salaam auth status [PROVIDER]
salaam auth logout PROVIDER

Set an API key at a hidden prompt (or pipe it on stdin). Login uses Pi's provider-owned
setup, including cloud configuration and browser OAuth. Credentials are private under
~/.config/salaam/credentials; refresh is serialized across processes.
Status prints metadata only. Existing Anthropic keys remain compatible.`,
  service: `salaam service start [--foreground] [--provider PROVIDER]
                     [--model MODEL] [--max-output-tokens N] [--workspace-id ID]
                     [--effect-socket PATH] [--effect-opaque]
                     [--coding-root PRIVATE_DIR] [--coding-socket DOCKER_SOCKET]
                     [--harness-config OWNER_ONLY_FILE] [--a2a-config OWNER_ONLY_FILE]
                     [--a2a-listen-config OWNER_ONLY_FILE]
                     [--agentpod-config OWNER_ONLY_FILE]
salaam service status
salaam service stop

Without --agentpod-config, start binds to ~/.config/salaam/agentpod-pins.json
($XDG_CONFIG_HOME/salaam) when that file exists.

The default provider is offline. Anthropic defaults to claude-sonnet-5-5.
Other providers require --model; use salaam providers list and salaam models list PROVIDER.
Start with --foreground for process-supervisor use; otherwise the service detaches.
An AgentPod daemon requires node-bound admissions and a fresh authority lease.
Keep its private state outside the pinned workspace. Coding, external runtimes,
effect connectors and managed MCP are unavailable in this profile.`,
  session: `salaam session create [--cwd DIR] [--request-id ID] [--coding | --local | --local-coding]
  --local-coding allows reviewed edits and native commands (no OS sandbox)
  --local allows bounded local file inspection; optionally select --provider ID --model ID
salaam session list
salaam session inspect SESSION_ID
salaam session submit SESSION_ID --text TEXT
salaam session continue SESSION_ID --attempt ATTEMPT_ID --text NEW_INSTRUCTION
salaam session resume SESSION_ID
salaam session cancel SESSION_ID --attempt ATTEMPT_ID [--takeover]
salaam session revoke SESSION_ID --reason TEXT [--request-id ID] [--takeover]
salaam session revocation SESSION_ID
salaam session probe SESSION_ID [--takeover]
salaam session children SESSION_ID
salaam session usage SESSION_ID
salaam session compact SESSION_ID --task-version N [--takeover] [--request-id ID]

Submissions are durable. Continuing an interrupted attempt creates a new instruction.
Revocation permanently fences the session and its descendants. Its receipt confirms
authority withdrawal; process stop and external effects require their own evidence.
Retry a lost revocation reply with the same request ID and reason.
Use salaam attach SESSION_ID for an interactive terminal.`,
  attach: `salaam attach SESSION_ID [--observe|--takeover] [--plain]

Reconnect to a persistent session. Ctrl-C or Ctrl-D detaches while work continues.
--observe watches without taking control; --takeover replaces the controller.
A TTY opens the Salaam TUI. --plain retains the line client (:help).
Piped attachments use the line client automatically.`,
  approvals: `salaam approvals list [--session SESSION_ID]
salaam approvals inspect APPROVAL_ID
salaam approvals approve APPROVAL_ID --digest DIGEST --revision N [--request-id UUID]
salaam approvals deny APPROVAL_ID --digest DIGEST --revision N [--request-id UUID]

Inspect the operation, then supply its reviewed digest and approval revision.`,
  operations: `salaam operations inspect OPERATION_ID
salaam operations reconcile OPERATION_ID [--request-id ID]
salaam operations resolve OPERATION_ID --digest DIGEST --revision N
                          --outcome succeeded|failed_definite --evidence TEXT
                          [--request-id ID]

Reconciliation checks status without resending an effect. Resolution records
an explicit operator attestation for an unknown outcome.`,
  children: `salaam children inspect CHILD_ID
salaam children result CHILD_ID
salaam children ack CHILD_ID --result RESULT_ID [--request-id ID]

Reading a result leaves it available. Acknowledgment is explicit and idempotent.
List a parent's children with salaam session children SESSION_ID.`,
};
const globalOptions = `Global options:
  --state DIR    Service state directory (or SALAAM_STATE_DIR).
                 Default: ~/.local/state/salaam
  -h, --help     Show help without starting a service or model request.
  -V, --version  Show the installed version.`;
export function cliHelp(group?: string): string | undefined {
  if (group) return commands[group] ? `${commands[group]}\n\n${globalOptions}` : undefined;
  return `Salaam — persistent coding sessions

Usage: salaam <command> [options]
       sal <command> [options]

Commands:
  tui           Open the Salaam terminal interface (also bare sal)
  remote        Open the same session over SSH
  providers     List pinned Pi providers and capabilities
  models        List pinned chat models
  auth          Configure provider credentials or OAuth
  service       Start, inspect or stop the session service
  session       Create, inspect, submit, resume or cancel work
  attach        Open an interactive terminal on a session
  acp           Connect an editor over ACP v1 stdio
  approvals     Inspect, approve or deny managed operations
  operations    Inspect, reconcile or resolve effect outcomes
  children      Inspect, read or acknowledge durable child results
  tasks         Durable plans, verification, budgets and checkpoints
  jobs          Durable one-shot jobs and recovery
  schedules     Fresh recurring occurrences and explicit missed-run rules
  inbox         Durable shared operator attention
  host          Pinned host bootstrap, supervision and health
  task          Inspect and update durable task facts
  history       Retrieve older history and evidence
  artifacts     Save durable text evidence
  compactions   Inspect or cancel a managed checkpoint
  execution     Prove the container boundary with disposable fixtures
  workspace     Inspect coding copies, review diffs or acknowledge human edits
  agents        Inspect and admit specialist profiles
  team          Assign task steps and inspect the durable team inbox
  workers       Inspect and explicitly integrate isolated coding proposals
  harness       Prepare, inspect and reconcile pinned external workers
  a2a           Configure bounded peer analysis and inspect remote work
  commands      Start, inspect, cancel or reconcile isolated commands

${globalOptions}

Get started:
  salaam auth set anthropic
  salaam service start --provider anthropic
  sal session create --cwd "$PWD"
  sal attach SESSION_ID

Run salaam <command> --help for command usage.
Both salaam and sal are executable names for the same CLI.`;
}
const valueOptions = new Set([
  '--theme',
  '--remote-bin',
  '--state',
  '--cwd',
  '--request-id',
  '--reason',
  '--text',
  '--attempt',
  '--provider',
  '--model',
  '--max-output-tokens',
  '--workspace-id',
  '--effect-socket',
  '--session',
  '--digest',
  '--revision',
  '--outcome',
  '--evidence',
  '--result',
  '--kind',
  '--supersedes',
  '--artifact-id',
  '--entry-id',
  '--offset',
  '--task-version',
  '--docker-socket',
  '--scratch-root',
  '--report',
  '--run-id',
  '--coding-root',
  '--coding-socket',
  '--harness-config',
  '--a2a-config',
  '--agentpod-config',
  '--a2a-listen-config',
  '--assignment',
  '--peer',
  '--peer-client',
  '--file',
  '--endpoint',
  '--card-url',
  '--card-file',
  '--addresses',
  '--files',
  '--retention',
  '--credential-file',
  '--tenant',
  '--skill',
  '--runtime-root',
  '--arch',
  '--target',
  '--id',
  '--runtime',
  '--invocations',
  '--step-key',
  '--command',
  '--plan',
  '--step',
  '--review',
  '--continue-attempt',
  '--check',
  '--exception-reason',
  '--evidence-artifact',
  '--checkpoint',
  '--workspace-revision',
  '--workspace-digest',
  '--max-steps',
  '--name',
  '--key',
  '--schedule',
  '--status',
  '--manifest',
  '--config',
  '--pin',
  '--platform',
]);
/** Skip option values so a prompt containing "--help" stays a prompt. */
export function hasHelpFlag(args: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (valueOptions.has(args[index]!)) {
      index++;
      continue;
    }
    if (args[index] === '--help' || args[index] === '-h') return true;
  }
  return false;
}
