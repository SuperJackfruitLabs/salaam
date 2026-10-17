# Salaam

Salaam is a local session service supervising persistent Pi workers. Terminal and ACP clients share the same sessions, while Salaam owns task and operation state around Pi's conversation history.

The current implementation covers **M0–M8**: a reproducible Pi bundle, transactional service core, supervised workers, reconnectable attachment, durable approvals, an operation/receipt ledger, independent read-only children, durable result inboxes, usage accounting, explicit task facts, managed checkpoint compaction and an ACP v1 stdio adapter. The default route is an **offline scripted provider**: ordinary prompts return `Offline reply: …` after a managed probe tool call. Approved effects use an explicitly configured local fixture connector. A guarded Claude route is available with `service start --provider anthropic`; the default tests use local fixtures without real credentials or paid requests.

## Run locally

The **M9.1 execution-boundary spike** adds an operator-only container proof and explicit unavailable coding-execution health status. See [the boundary contract and proof commands](docs/execution-boundary.md). File and command tools remain gated on M9.2/M9.3.

Use Node **26.7.0** and npm **11.19.0**. The application uses Node's built-in SQLite module and has no database server or native addon build step.

```sh
nvm use
npm ci --ignore-scripts
npm run setup:cli
salaam --help
sal --version
npm run check
npm test
npm run verify:pi
npm run demo:session
npm run demo:managed
npm run demo:children
npm run demo:acceptance
# Full host-local acceptance: all six proof suites, 20 repetitions each
npm run test:acceptance
```

`npm run setup:cli` builds the checkout and links both commands into the current Node installation's global npm bin directory. It uses offline linking with dependency lifecycle scripts disabled. The commands follow this checkout; after source changes, run `npm run build`. Repeat setup after moving the checkout or changing the Node installation. No npm publication is involved, and the package remains private.

To run without a global link, use `npm run cli -- --help` or `./bin/salaam.mjs --help`. Remove the global commands with `npm unlink --global @sjl/salaam --ignore-scripts --offline`; saved credentials and service state are retained.

`npm test` and the demo open Unix sockets and supervise subprocesses. They require a host environment permitting those operations. Tests use disposable directories under `/tmp`; no provider credentials or paid requests are involved.

The session demo runs a gated turn, inspects events and verifies an artifact. The managed demo starts a real Pi worker and an independent durable effect fixture, creates two concurrent approval requests, uses the CLI to approve B and deny A, and checks that only B executes. The children demo runs two independent children, reads one result twice, repeats its acknowledgment and verifies six unique provider requests across the tree. The combined acceptance demo uses terminal attach, ACP and CLI inspection on one session, detaches with pending approvals, checks one approved effect and two child results, then performs three compactions and retrieves older evidence. All demos remove their disposable state and stop their workers.

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

In an attachment, type an instruction and press Enter. Ctrl-D or Ctrl-C detaches; the worker continues. Reattaching restores recent history and follows committed results. One terminal holds a 15-second controller lease, renewed every five seconds. Other terminals can use `--observe`; `--takeover` explicitly revokes the previous controller. After a killed terminal, wait for lease expiry or take over. A lease coordinates clients of the same trusted OS account.

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

[Durable task context](docs/task-context.md) documents explicit objectives, constraints, corrections, completed steps, outstanding work, evidence and manual compaction. [Client setup](docs/clients.md) documents the ACP v1 adapter and SSH attachment.

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

After `npm run setup:cli`, store your key through the hidden terminal prompt:

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

## What is implemented

- SQLite WAL journal with full synchronization, schema versioning, foreign keys, transactional state/events, durable request deduplication, and revision checks.
- An OS-managed exclusive state lock, independent of the application journal, that releases on process death.
- Session creation, inspection, bounded transcript snapshots, durable event replay/SSE, accepted input storage, and content-checked artifacts.
- Controller/observer attachments, lease takeover, a flushed client outbox, one-at-a-time durable dispatch, and explicit interruption continuation.
- Operation-bound durable approvals, expiry, concurrent decisions and Pi dialog correlation; managed intent/receipt states, conditional writes, lookup and explicit uncertain-outcome resolution.
- Durable cancellation that prevents new grants and preserves uncertain dispatched effects.
- Pi subprocess ownership, explicit session paths and IDs, worker epochs, process-group cleanup, heartbeat expiry, and conservative restart fencing.
- An authenticated worker bridge and a required manifest covering the bundle, session, policy, reachable tools, provider route, and task-context digest.
- Service-side admission before each provider request and managed tool operation, including nested calls, with grants correlated to dispatched attempts.
- Explicit append-only task facts and correction links; bounded, current task-state admission at each provider request; paginated evidence/history retrieval.
- Managed deterministic checkpoint compaction, positive-receipt reconciliation and durable cancellation; task versions remain independent of compaction cursors.
- ACP v1 new/load/resume, committed transcript and tool updates, bound permissions and cancellation against the same session service.
- A real-Pi diagnostic provider and independent fake-Pi, protocol, and durable mock-effect fixtures.

Pi is pinned to npm artifact **`@earendil-works/pi-coding-agent@1.3.0`** by exact dependency, lockfile integrity and installed package-content digests. [pi-pin.json](pi-pin.json) records the artifact and source-reference distinction. The shipped RPC command reference was byte-compared with the research commit. The registry does not supply `gitHead`, so the repository does not claim a reproducible upstream source build.

The readiness manifest advertises `persistent-session`, `managed-policy`, `task-context`, `provider-admission`, `durable-approvals`, `operation-ledger`, `child-work`, `usage-ledger`, `durable-task-context` and `managed-compaction`. Parent tools include `salaam_probe`, `salaam_review`, `spawn_child`, `inspect_child`, `consume_child_result` and `salaam_history`; `salaam_effect` is registered only with an explicit connector. Health reports the configured connector and whether a session has unresolved operations. Ledger availability does not imply a live third-party integration. Each request obtains the current task version and facts from the bridge; stale or missing actual payload context denies forwarding.

## Readiness proof

The [S6 tests](test/proofs/required-capabilities.test.ts) reject missing controls, incompatible versions, wrong bundle/policy/session identities, unexpected reachable tools, forged credentials and stale epochs. They also check queued work remains undispatched, persistence failures deny grants, and lost heartbeats invalidate readiness.

[Real Pi tests](test/pi/readiness.test.ts) exercise successful turns, a missing extension, a throwing context hook and a failing nested policy hook. [Restart tests](test/pi/restart.test.ts) cover explicit transcript resumption and abrupt supervisor death. The journal tests include an actual SQLite page-limit failure, rather than only a mocked write error.

The [S1 attachment proof](test/proofs/session-attach.test.ts) kills a CLI during an actual Pi tool turn and reconnects to the same worker. It checks one user message, one attempt and one tool grant. Further cases drop an acceptance response, replay events after disconnect, kill the service during a prompt, and kill it between Pi completion and the SQLite completion commit. [Dispatch tests](test/unit/dispatch.test.ts) cover controller fencing, schema migration and a committed handoff before any pipe write.

The [S2 approval proof](test/proofs/approval-correlation.test.ts) covers concurrent nested calls, reverse decisions, two sessions, expiry, changed targets, lost decision replies and worker replacement. It also injects unsolicited real Pi confirm replies and proves they cannot authorize a durable operation. The [S3 effect proof](test/proofs/effect-recovery.test.ts) kills services/workers around external acceptance and receipt commits, tests negative/unavailable lookup, opaque connectors, mismatched receipts, target-version races and cancellation. Storage failures deny dispatch.

The [S5 context proof](test/proofs/context-compaction.test.ts) forces three real Pi compactions and restarts a worker, inspects the actual outgoing payload, retrieves old evidence, and checks failed/cancelled compaction and both sides of the Pi persistence boundary. It separately preserves an outstanding real child and unknown effect and rejects compaction while an approval blocks a tool. The [ACP proofs](test/proofs/acp-client.test.ts) cover shared sessions, full history replay beyond the terminal snapshot, reverse permissions, cancellation, client loss and a lost acceptance reply. The guarded Claude route is tested against a local Anthropic-compatible fixture; live account authentication is verified by your first configured request. The [S4 child recovery proof](test/proofs/child-result-recovery.test.ts) covers parent/service death, durable redelivery, cancellation and interrupted usage accounting. S1–S6 have host-local offline/fixture evidence; platform observations and repetition counts are recorded in [verification](docs/verification.md). These results do not establish exactly-once effects for arbitrary external services or shell commands.

## Local API

All endpoints use the operator Unix socket at `STATE_DIR/operator.sock`.

| Endpoint                              | Behavior                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sessions/:id/children`       | List a parent session’s child tasks                                                                                                |
| `GET /v1/sessions/:id/usage`          | Aggregate provider usage across the parent and its children                                                                        |
| `GET /v1/children/:id`                | Inspect one child task                                                                                                             |
| `GET /v1/children/:id/result`         | Read a stable result without acknowledging delivery                                                                                |
| `POST /v1/children/:id/ack`           | `{request_id,result_id}`; acknowledge the reviewed result idempotently                                                             |
| `GET /v1/sessions/:id/task`           | Current task version, original facts, provenance, supersession links and compaction cursor                                         |
| `POST /v1/sessions/:id/task`          | `{request_id,expected_version,fact,client_id,token}`; append an explicit fact/correction while idle                                |
| `POST /v1/sessions/:id/artifacts`     | `{request_id,text,client_id,token}`; persist bounded text evidence while idle                                                      |
| `GET /v1/sessions/:id/history`        | Bounded history index or `?entry_id=ID` / `?artifact_id=ID`, with `offset` continuation; `branch=true` lists active-branch entries |
| `POST /v1/sessions/:id/compact`       | `{request_id,expected_version,client_id,token}`; start a manual checkpoint while idle                                              |
| `GET /v1/compactions/:id`             | Inspect running/completed/failed/interrupted/cancelled checkpoint state                                                            |
| `POST /v1/compactions/:id/cancel`     | `{request_id,client_id,token}`; record cancellation before requesting Pi abort                                                     |
| `GET /v1/attempts/:id`                | Inspect a durable execution attempt                                                                                                |
| `GET /v1/health`                      | Service health and per-session worker readiness                                                                                    |
| `GET /v1/sessions`                    | List session snapshots                                                                                                             |
| `POST /v1/sessions`                   | `{request_id, cwd}`; create and provision a session                                                                                |
| `GET /v1/sessions/:id`                | Inspect a session and its durable event sequence                                                                                   |
| `GET /v1/sessions/:id/snapshot`       | Session, controller view, bounded attempts/submissions and active-branch transcript                                                |
| `GET /v1/sessions/:id/events?after=N` | Replay and stream committed events after the snapshot cursor                                                                       |
| `POST /v1/sessions/:id/control`       | `{request_id, client_id, action, expected_epoch, token?}`; acquire, renew, release or take over a lease                            |
| `POST /v1/sessions/:id/submissions`   | `{request_id, expected_revision, text, client_id, token, continues_attempt_id?}`; atomically accept a submission and attempt       |
| `POST /v1/sessions/:id/resume`        | `{client_id, token}`; provision a stopped session and dispatch safe queued work                                                    |
| `POST /v1/sessions/:id/probe`         | `{client_id, token, nested?: boolean}`; run the fixed diagnostic after readiness                                                   |
| `GET /v1/approvals?session=ID`        | List session approvals; omitting the session lists pending approvals                                                               |
| `GET /v1/approvals/:id`               | Inspect a bound approval                                                                                                           |
| `POST /v1/approvals/:id/decision`     | `{request_id, expected_revision, operation_digest, decision: approve\|deny}`                                                       |
| `GET /v1/operations/:id`              | Full operation binding, state, receipt and resolution source                                                                       |
| `POST /v1/operations/:id/reconcile`   | `{request_id}`; collect external status without reissuing an effect                                                                |
| `POST /v1/operations/:id/resolution`  | `{request_id, expected_revision, operation_digest, outcome, evidence}`; explicit operator attestation                              |
| `POST /v1/attempts/:id/cancel`        | `{request_id, expected_revision, client_id, token}`; revoke dispatch and request cancellation                                      |
| `POST /v1/shutdown`                   | Stop the service and its owned workers                                                                                             |

Identical command requests return their original saved result. Reusing a request ID with different logical input conflicts. Controller credentials are excluded from the submission/cancellation logical input so a new controller can recover a lost reply. Request lookup precedes mutation preconditions. Approvals use their own revision, independent of session progress. The local operator identity is derived from the private socket's OS-account boundary; caller-supplied actor IDs confer no authority. Diagnostics are repeatable tests, not idempotent user-work submissions, and require a controller lease.

A snapshot includes `seq=N`; subscribe with `after=N` to avoid a snapshot/stream gap. Attempts, submissions, approvals and operations are bounded to 100 each; transcript messages are bounded to 100 with text budgets. Operation values may be truncated and receipts are omitted from snapshots with `value_truncated`/`receipt_available` flags; inspect the full operation before deciding. Pi retains the full history. Final transcript import and attempt completion commit together. SSE respects backpressure and disconnects clients stalled for ten seconds; clients replay from their last durable cursor. Preview events have no durable ID; the CLI displays committed final results. The separate worker socket accepts session-scoped credentials and current epochs; it is not an operator endpoint.

On graceful shutdown, workers stop and active attempts become interrupted unless cancelled. After a service crash, the next service proves old workers have stopped before permitting a new writer. A known-dead unhealthy worker may be explicitly replaced, earning readiness in a fresh epoch. Uncertain process identity or missing recorded history still blocks reuse. Schema version six upgrades earlier service state while preserving cached replies, attempts, routes, approvals, operations, child results and usage.

## Development

```sh
npm run format:check
npm run check
npm run test:unit
npm run test:proofs
npm run test:pi
```

The [milestone record](docs/milestones.md) describes scope and evidence. The [M7–M8 acceptance run](https://github.com/SuperJackfruitLabs/salaam/actions/runs/39036223669) passed on macOS arm64 and Linux x64: 123 regression tests and 20 repetitions of all six proof suites per platform. See [verification](docs/verification.md) for the tested implementation commit and evidence digests. The [architecture notes](docs/architecture.md) describe state ownership and failure boundaries.

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
