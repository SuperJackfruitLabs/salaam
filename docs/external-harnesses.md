# External harness workers

Salaam can assign a task step to a pinned external coding harness. The daemon owns
its dispatch, private draft, approvals and result. Terminal disconnects do not
create another invocation. Integration into the parent workspace remains explicit.

| Harness            | Pinned version                                        | Interface                           |
| ------------------ | ----------------------------------------------------- | ----------------------------------- |
| Gemini CLI         | 0.64.0                                                | ACP v1                              |
| Claude ACP adapter | `@zed-industries/claude-agent-acp` 0.23.1, SDK 0.2.83 | ACP v1                              |
| Codex              | 0.163.0                                               | App-server thread and turn protocol |

These external routes use the host's configured Claude API key and Sonnet 4.6.
Gemini and Codex use explicit Google/Responses wire translation to that backend.
`harness list` records the backend model separately from the wire model alias.
[Native provider selection](providers.md) is configured separately.

## Prepare and configure

Start with a [proven Docker coding environment](coding.md). Prepare the runtime
bundle outside worker turns; choose the architecture of the Docker execution host:

```sh
sal harness prepare --runtime-root /PRIVATE_SHARED_PATH/harness-runtime --arch linux-arm64
```

Use `linux-x64` for an x64 Linux host. Preparation uses a fixed dependency lock,
disables install scripts and verifies the Codex archive's integrity. The destination
must be new. It must be accessible to the selected Docker engine.

Create an owner-only registry and select a target:

```sh
mkdir -p ~/.config/salaam
umask 077
sal harness config --target gemini-acp --runtime-root /PRIVATE_SHARED_PATH/harness-runtime > ~/.config/salaam/harness.json
```

The registry freezes the complete artifact digest, exact version, backend model
and gateway bounds. To configure multiple targets, add their generated entries to
the same `runtimes` array with distinct IDs. Keep credentials in Salaam's local
credential store with `sal auth set anthropic`.

Provision the additional Bash-capable image before starting the service:

```sh
docker pull docker.io/library/node@sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32
sal service start --coding-root /PRIVATE_SHARED_PATH/owned --coding-socket /PATH/TO/docker.sock --harness-config ~/.config/salaam/harness.json
sal harness list
```

Startup runs actual filesystem, network, privilege, Bash and descendant-stop
probes. A registry file or successful protocol negotiation alone grants no work.
The source checkout, sibling drafts, host credential home and daemon sockets are
excluded from the harness. Only a private draft, private home and read-only runtime
are mounted. Model traffic uses the host's bounded gateway; real API keys stay on
the host.

## Assign a step

Opaque worker work requires an explicit invocation allowance in the task plan:

```json
{
  "limits": {
    "invocations": 4,
    "token_units": null,
    "runtime_ms": 300000,
    "concurrency": 2
  }
}
```

An invocation is one admitted external turn. Failed and uncertain turns retain
their charge. Native `requests` remain model-request counts; they are not renamed
to cover opaque work. Internal model usage is shown as unknown. The configured
host gateway also enforces its own durable per-invocation request and output bounds.

Admit an appropriate profile, then assign the pending step:

```sh
sal agents inspect salaam/builder --session SESSION_ID
sal agents admit salaam/builder --session SESSION_ID --digest REVIEWED_DIGEST
sal team assign TASK_ID --step STEP_ID --profile salaam/builder --runtime gemini-acp --invocations 1 --revision N
sal team run TASK_ID --assignment ASSIGNMENT_ID --generation 0 --revision N --request-id repair-1
```

The harness receives its admitted profile, instruction and explicitly selected
facts. Its model-visible tool inventory is narrowed to the profile's file and
command authority. The pinned Codex route requires a command-enabled profile.
Permission requests appear in the shared inbox and TUI. A once-only approval
authorizes that concrete operation; it is separate from delivery, tool return and
task verification.

Use [coding proposals and integration](agents.md#build-and-integrate-a-coding-proposal)
to inspect the stopped draft, apply its exact patch and run fresh parent checks.
An external worker's final message does not complete the task.

## Inspect and recover

```sh
sal team show TASK_ID
sal harness inspect CHILD_ID
sal inbox list
```

These views use the daemon's saved task and upstream session identities. After a
lost run response, repeat its request ID and arguments. A saved response never
restarts the harness or resends the prompt. Generic session prompts and Pi restart
commands cannot take over an externally owned child.

Daemon death interrupts in-flight work. An unknown acceptance or tool outcome is
kept unknown. Confirm an uncertain run's owned resources have stopped with:

```sh
sal harness reconcile CHILD_ID --run-id EXACT_RUN_ID
```

Reconciliation performs owned-resource cleanup and does not send a model prompt.
An unconfirmed stop retains its worker slot and blocks another generation. After
reconciliation, an explicit continuation uses a new instruction and the exact
interrupted attempt ID, as described in [specialists and teams](agents.md).
Changed runtime, adapter, profile or executor identities fence fresh work until
the operator renews the relevant admission.
