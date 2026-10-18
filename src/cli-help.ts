const commands: Record<string, string> = {
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
  auth: `salaam auth set anthropic

Enter a Claude API key at a hidden prompt. It is saved privately under
~/.config/salaam/credentials/anthropic. ANTHROPIC_API_KEY takes precedence.`,
  service: `salaam service start [--foreground] [--provider offline|anthropic]
                     [--model MODEL] [--max-output-tokens N] [--workspace-id ID]
                     [--effect-socket PATH] [--effect-opaque]
                     [--coding-root PRIVATE_DIR] [--coding-socket DOCKER_SOCKET]
salaam service status
salaam service stop

The default provider is offline. Claude defaults to claude-sonnet-5-5.
Start with --foreground for process-supervisor use; otherwise the service detaches.`,
  session: `salaam session create [--cwd DIR] [--request-id ID] [--coding]
salaam session list
salaam session inspect SESSION_ID
salaam session submit SESSION_ID --text TEXT
salaam session continue SESSION_ID --attempt ATTEMPT_ID --text NEW_INSTRUCTION
salaam session resume SESSION_ID
salaam session cancel SESSION_ID --attempt ATTEMPT_ID [--takeover]
salaam session probe SESSION_ID [--takeover]
salaam session children SESSION_ID
salaam session usage SESSION_ID
salaam session compact SESSION_ID --task-version N [--takeover] [--request-id ID]

Submissions are durable. Continuing an interrupted attempt creates a new instruction.
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
  auth          Configure the Claude API key locally
  service       Start, inspect or stop the session service
  session       Create, inspect, submit, resume or cancel work
  attach        Open an interactive terminal on a session
  acp           Connect an editor over ACP v1 stdio
  approvals     Inspect, approve or deny managed operations
  operations    Inspect, reconcile or resolve effect outcomes
  children      Inspect, read or acknowledge durable child results
  task          Inspect and update durable task facts
  history       Retrieve older history and evidence
  artifacts     Save durable text evidence
  compactions   Inspect or cancel a managed checkpoint
  execution     Prove the container boundary with disposable fixtures
  workspace     Inspect coding copies, review diffs or acknowledge human edits
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
