# Session service reference

Detailed host-local session controls, approvals, recovery and wire behavior. For
installation, see [install and upgrade](../install.md); for a first session, see
[quickstart](../quickstart.md).

To keep a service running:

```sh
npm run build
salaam service start --state /tmp/salaam-dev
salaam session create --cwd "$PWD" --state /tmp/salaam-dev
salaam service status --state /tmp/salaam-dev
salaam session inspect SESSION_ID --state /tmp/salaam-dev
salaam attach SESSION_ID --state /tmp/salaam-dev
# In another terminal, observe the same session:
salaam attach SESSION_ID --observe --state /tmp/salaam-dev
salaam session probe SESSION_ID --state /tmp/salaam-dev
salaam service stop --state /tmp/salaam-dev
```

Wait until inspection reports `ready` before running a probe. `service start` detaches the daemon from the calling terminal. Add `--foreground` to run it under a process supervisor. Without `--state`, the default is `~/.local/state/salaam`. Both `salaam` and `sal` are installed executable names for the same CLI. `salaam --help`, `salaam service --help` and `sal --version` work from any directory after setup.

In the TUI, type an instruction and press Enter. Ctrl+K opens actions, Ctrl+P switches sessions, Ctrl+O reviews approvals and Ctrl+G opens changes. Use `attach --plain` for the older line interface. Ctrl-D or Ctrl-C detaches; the worker continues. Reattaching restores recent history and follows committed results. One terminal holds a 15-second controller lease, renewed every five seconds. Other terminals can use `--observe`; `--takeover` explicitly revokes the previous controller. After a killed terminal, wait for lease expiry or take over. A lease coordinates clients of the same trusted OS account.

Input is flushed to a private local outbox before transmission. A new controller retries pending records with the original request ID. An unknown network response preserves the original request; only a definite revision rejection permits refreshing its revision. Pi slash commands are unavailable as submitted prompts. Definitively rejected input remains in an outbox file ending in `.rejected.json` for inspection.

For scripted input or explicit recovery:

```sh
salaam session submit SESSION_ID --text 'A new instruction' --state /tmp/salaam-dev
salaam session resume SESSION_ID --state /tmp/salaam-dev
salaam session continue SESSION_ID --attempt INTERRUPTED_ATTEMPT_ID \
  --text 'Inspect the interrupted result, then follow this new instruction' --state /tmp/salaam-dev
```

Service restart expires controller leases and marks prompts already handed toward Pi as `interrupted`. Those prompts are never automatically replayed, even if Pi's transcript contains a final answer. An unresolved interruption holds later queued work. Explicit continuation creates a **new instruction and attempt**, links it to the interruption, and runs before previously queued work. `resume` provisions the same recorded Pi session and dispatches safe queued work after readiness.

## Task context and clients

[Durable task context](task-context.md) documents explicit objectives, constraints, corrections, completed steps, outstanding work, evidence and manual compaction. [Client setup](clients.md) documents the ACP v1 adapter and SSH attachment.

```sh
sal task inspect SESSION_ID
sal task update SESSION_ID --task-version 0 --kind objective --text 'Review the staging release'
sal artifacts put SESSION_ID --text 'Build evidence'
sal session compact SESSION_ID --task-version 1
sal compactions inspect COMPACTION_ID
# Editor subprocess command, against an already running service:
sal acp --state /tmp/salaam-dev
```

Task versions are independent of session revisions. Fact updates, artifact creation and compaction starts require a controller and an idle ready parent; CLI commands accept `--takeover` explicitly. Compaction is asynchronous and manual. It checkpoints explicit task facts, retains the latest user turn and leaves older entries available through `salaam_history`. Automatic and model-generated compaction are disabled. Apply this service revision by stopping and restarting the daemon at an appropriate work boundary; changing a checkout does not update an already running process.

## Claude setup

After installation, store your key through the hidden terminal prompt:

```sh
salaam auth set anthropic
```

The command writes the key to `~/.config/salaam/credentials/anthropic`, with file mode `600` inside a directory with mode `700`. The key is entered at the prompt, so it does not become a shell command or CLI argument. The file is plaintext, protected by OS permissions. `ANTHROPIC_API_KEY` is also supported and takes precedence over this file; unset that environment variable to use the saved key. Salaam does not load `.env` files.

Start a separate persistent state directory for Claude, then create a new session:

```sh
salaam service start --provider anthropic --state "$HOME/.local/state/salaam-claude"
salaam service status --state "$HOME/.local/state/salaam-claude"
sal session create --cwd "$PWD" --state "$HOME/.local/state/salaam-claude"
sal attach SESSION_ID --state "$HOME/.local/state/salaam-claude"
```

Replace `SESSION_ID` with the ID returned by creation. A short greeting in the attachment exercises authentication and streaming; it is a real, billable request. Creating a session and checking readiness make no model request and do not prove the account's key or billing is valid.

The default model is `claude-sonnet-5-5`, with low reasoning and a maximum of 4,096 output tokens per request. This initial route also accepts `--model claude-sonnet-4-6`. `--max-output-tokens N` permits 128–8,192; output limits and request budgets do not cap total currency spend. Model metadata and estimated prices come from the pinned Pi catalog. The direct endpoint is fixed to `https://api.anthropic.com`; arbitrary proxies, OAuth/subscription tokens, server tools and model fallback are unsupported. See [Anthropic model IDs](https://platform.claude.com/docs/en/models/overview).

If your API key requires an Anthropic workspace header, add `--workspace-id WORKSPACE_ID` to service startup. This is distinct from `--cwd`. See [Anthropic authentication](https://platform.claude.com/docs/en/manage-claude/authentication). The provider, model, output limit and workspace ID are durably bound to each session. Restart with the same options to resume it. Existing offline sessions retain their offline route; create a new session to use Claude. Starting over an already running daemon with a different route reports a configuration conflict.

Only live workers receive `ANTHROPIC_API_KEY`; other inherited provider credentials and global Pi settings remain excluded. Keys are absent from worker configuration JSON, process arguments, journal events and operator responses. Provider error bodies are replaced with safe status messages before they enter transcripts. Rotating the key requires updating the saved key/environment and restarting the service; no credential value or credential digest is persisted in the journal.

Both SDK and Pi turn retries are disabled. Automatic compaction stays disabled; use the managed manual checkpoint command. After a failed request, inspect the attempt and explicitly submit a new instruction; interrupted attempts require `session continue`. Incomplete requests retain unknown usage rather than a zero charge. The service validates the final serialized model, output cap, fixed tool inventory and actual task-context frame before each HTTP dispatch. The private bridge currently bounds request bodies to 1 MiB. Existing approval/effect rules and child authority limits apply to Claude turns too. No live filesystem or shell tool is added by this provider integration.

## Approvals and managed effects

With the default bundle, submit `[review] alpha,beta` to request two concurrent, read-only fixture reviews. `[effect] alpha,beta` requests external fixture effects when the service was started with `--effect-socket PATH`. Without that option the provider explicitly declines the effect; it does not substitute a review. `npm run demo:managed` configures the independent fixture automatically.

Each approval binds the session, attempt, worker epoch, tool invocation, target, target version, normalized arguments, policy and connector. Approvals expire after five minutes. Inspect the complete operation before deciding; the decision must carry the reviewed digest and approval revision:

```sh
salaam approvals list --session SESSION_ID --state /tmp/salaam-dev
salaam approvals inspect APPROVAL_ID --state /tmp/salaam-dev
salaam approvals approve APPROVAL_ID --digest DIGEST --revision 1 --state /tmp/salaam-dev
salaam approvals deny APPROVAL_ID --digest DIGEST --revision 1 --state /tmp/salaam-dev
```

Attachments also accept `:approve ID DIGEST REV`, `:deny ID DIGEST REV`, and `:cancel ATTEMPT_ID`; `:help` lists them. Approval decisions are independent of the prompt controller lease: an observer under the trusted OS account can act as an approver. New prompts and cancellation require a controller. The client flushes decisions and cancellations to its outbox before sending, preserving request IDs after lost replies. Changed decisions cannot overwrite an unresolved command. CLI `--request-id` overrides for outbox commands must be UUIDs.

Pi confirm dialogs carry a unique approval/digest marker and are mapped by worker epoch and Pi request ID. Text labels and bare dialog replies cannot grant dispatch. Decisions commit before dialog replies. Losing the client leaves approvals pending until their deadline; losing the worker invalidates its pending approvals and dialogs. A replacement worker needs a newly bound approval.

The service commits operation intent before dispatch and rechecks authority and target version. The connector sends an external conditional write (`If-Match`), plus a service-generated idempotency key in lookup mode. A positive receipt must match the action key and normalized arguments. A failed or missing response becomes `outcome_unknown`; it is never automatically resent. A negative status lookup also remains unknown because an earlier request may still arrive. Unknown operations block new work in that session.

```sh
salaam operations inspect OPERATION_ID --state /tmp/salaam-dev
salaam operations reconcile OPERATION_ID --state /tmp/salaam-dev
salaam operations resolve OPERATION_ID --digest DIGEST --revision N \
  --outcome succeeded --evidence 'Receipt inspected out of band' --state /tmp/salaam-dev
salaam session cancel SESSION_ID --attempt ATTEMPT_ID --takeover --state /tmp/salaam-dev
```

`reconcile` performs status lookup, with a fresh request ID for each new observation. Recovery automatically attempts lookup for unknown operations using the same connector. Missing/unavailable lookup or a mismatched receipt leaves the operation unknown. `--effect-opaque` models a connector without idempotency or lookup; an uncertain outcome then requires an explicit operator resolution. Resolutions are recorded as **operator attestations**, distinct from verified external receipts; they do not prove a task passed its checks. `failed_definite` is the alternative resolution outcome.

Cancellation revokes new dispatch, cancels prepared operations and aborts the Pi run and owned effect transports. A dispatched effect may already have happened; cancellation reports unresolved operation IDs and preserves their unknown state until reconciliation. It does not undo external work.

Use a short state path for macOS Unix socket limits. The directory and sockets are private to the local OS account. The first prototype treats that account as one trusted operator; it does not isolate hostile programs running as the same user.

## Child work and usage

Submit `[children] first,second` with the offline provider to run two read-only children in independent Pi processes. `[inbox]` lists the parent's durable inbox. The managed tools are `spawn_child`, `inspect_child` and `consume_child_result`. Spawn binds a step key for the lifetime of the parent session: retries and explicit continuations reuse that child; changed inputs conflict. A new intentional task needs a new step key.

Depth is limited to one, with at most two active children per parent session. Child tool authority is the intersection of the requested tools and the parent's read-only `salaam_probe` grant. Children cannot spawn descendants, request approvals or dispatch effects. All children inherit the same pinned provider route as the parent. A parent attempt has 16 model requests; spawning reserves 1–8 of these for each child (default two), and each provider admission consumes a request before execution. Reservations remain held conservatively even after completion or interruption. This is a request-count bound, not a dollar or token-spend cap.

```sh
salaam session children SESSION_ID --state /tmp/salaam-dev
salaam children inspect CHILD_ID --state /tmp/salaam-dev
salaam children result CHILD_ID --state /tmp/salaam-dev
salaam children ack CHILD_ID --result RESULT_ID --request-id ACK_REQUEST_ID --state /tmp/salaam-dev
salaam session usage SESSION_ID --state /tmp/salaam-dev
```

Result artifacts have a fixed envelope: schema version, child and attempt IDs, final state, text and error. Artifact bytes are flushed first; the attempt outcome, artifact reference, child final state and parent inbox event then commit together. Reading a result does not acknowledge it. Acknowledgment is explicit and idempotent by result ID, including after a lost reply. Model reasoning has at-least-once delivery; an acknowledgment cannot prove exactly-once reasoning.

Parent worker death leaves children running under the service. A replacement parent sees the same task/result IDs in its inbox. Whole-service restart retains completed results and marks unfinished children interrupted, including children whose prompts had not yet dispatched. It never starts another run of those tasks. Cancelling the active parent attempt durably revokes all its session's owned active children before requesting Pi abort; unrelated sessions remain independent.

Usage observations have stable provider-request or Pi-entry source keys. Reimporting entries cannot add a second charge; tool results' nested usage totals are ignored. Session usage sums each provider execution in the parent/child tree once. Known offline fixture amounts, estimated Pi pricing amounts and unknown observations are distinguished. Unknown amounts remain null in the ledger and are counted separately from the displayed known subtotal. Compaction, branch-summary and auxiliary usage entries are imported when Pi supplies them; missing receipts remain unknown. Managed checkpoint compaction has known zero provider usage and reconciles its persisted Pi receipt after worker loss; its tests are part of S5.

Claude is the first live provider. The service defaults to offline and passes only the explicitly configured Anthropic key into live workers. Keep the key outside Git and chat; default tests and demos use fixtures.

## License

[Apache License 2.0](../LICENSE).
