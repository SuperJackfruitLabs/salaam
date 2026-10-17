# Salaam

Salaam is a local session service supervising persistent Pi workers. Terminal and editor clients will share the same sessions, while Salaam owns task and operation state around Pi's conversation history.

The current implementation covers **M0–M3**: a reproducible Pi bundle, transactional service core, supervised workers, interactive attachment and durable prompt dispatch. Clients can disconnect and reconnect to the same session without resending accepted work. The available model route is an **offline scripted provider**: ordinary prompts return `Offline reply: …` after a managed probe tool call. It exercises real Pi, persistence and service gates without model credentials.

## Run locally

Use Node **26.7.0** and npm **11.19.0**. The application uses Node's built-in SQLite module and has no database server or native addon build step.

```sh
nvm use
npm ci --ignore-scripts
npm run check
npm test
npm run verify:pi
npm run demo:session
```

`npm test` and the demo open Unix sockets and supervise subprocesses. They require a host environment permitting those operations. Tests use disposable directories under `/tmp`; no provider credentials or paid requests are involved.

The demo creates a session, waits for readiness, runs a gated Pi turn, inspects durable events, verifies an artifact, and shuts down its workers. Its state is removed afterward.

To keep a service running:

```sh
npm run build
node dist/src/cli.js service start --state /tmp/salaam-dev
node dist/src/cli.js session create --cwd "$PWD" --state /tmp/salaam-dev
node dist/src/cli.js service status --state /tmp/salaam-dev
node dist/src/cli.js session inspect SESSION_ID --state /tmp/salaam-dev
node dist/src/cli.js attach SESSION_ID --state /tmp/salaam-dev
# In another terminal, observe the same session:
node dist/src/cli.js attach SESSION_ID --observe --state /tmp/salaam-dev
node dist/src/cli.js session probe SESSION_ID --state /tmp/salaam-dev
node dist/src/cli.js service stop --state /tmp/salaam-dev
```

Wait until inspection reports `ready` before running a probe. `service start` detaches the daemon from the calling terminal. Add `--foreground` to run it under a process supervisor. Without `--state`, the default is `~/.local/state/salaam`. Both `sal` and `salaam` executable names are declared for a later packaged installation; direct Node commands work in this checkout.

In an attachment, type an instruction and press Enter. Ctrl-D or Ctrl-C detaches; the worker continues. Reattaching restores recent history and follows committed results. One terminal holds a 15-second controller lease, renewed every five seconds. Other terminals can use `--observe`; `--takeover` explicitly revokes the previous controller. After a killed terminal, wait for lease expiry or take over. A lease coordinates clients of the same trusted OS account.

Input is flushed to a private local outbox before transmission. A new controller retries pending records with the original request ID. An unknown network response preserves the original request; only a definite revision rejection permits refreshing its revision. Pi slash commands are unavailable as submitted prompts. Definitively rejected input remains in an outbox file ending in `.rejected.json` for inspection.

For scripted input or explicit recovery:

```sh
node dist/src/cli.js session submit SESSION_ID --text 'A new instruction' --state /tmp/salaam-dev
node dist/src/cli.js session resume SESSION_ID --state /tmp/salaam-dev
node dist/src/cli.js session continue SESSION_ID --attempt INTERRUPTED_ATTEMPT_ID \
  --text 'Inspect the interrupted result, then follow this new instruction' --state /tmp/salaam-dev
```

Service restart expires controller leases and marks prompts already handed toward Pi as `interrupted`. Those prompts are never automatically replayed, even if Pi's transcript contains a final answer. An unresolved interruption holds later queued work. Explicit continuation creates a **new instruction and attempt**, links it to the interruption, and runs before previously queued work. `resume` provisions the same recorded Pi session and dispatches safe queued work after readiness.

Use a short state path for macOS Unix socket limits. The directory and sockets are private to the local OS account. The first prototype treats that account as one trusted operator; it does not isolate hostile programs running as the same user.

## What is implemented

- SQLite WAL journal with full synchronization, schema versioning, foreign keys, transactional state/events, durable request deduplication, and revision checks.
- An OS-managed exclusive state lock, independent of the application journal, that releases on process death.
- Session creation, inspection, bounded transcript snapshots, durable event replay/SSE, accepted input storage, and content-checked artifacts.
- Controller/observer attachments, lease takeover, a flushed client outbox, one-at-a-time durable dispatch, and explicit interruption continuation.
- Pi subprocess ownership, explicit session paths and IDs, worker epochs, process-group cleanup, heartbeat expiry, and conservative restart fencing.
- An authenticated worker bridge and a required manifest covering the bundle, session, policy, reachable tools, provider route, and task-context digest.
- Service-side admission before each provider request and managed tool operation, including nested calls, with grants correlated to dispatched attempts.
- A real-Pi diagnostic provider and independent fake-Pi, protocol, and durable mock-effect fixtures.

Pi is pinned to npm artifact **`@earendil-works/pi-coding-agent@1.3.0`** by exact dependency, lockfile integrity and installed package-content digests. [pi-pin.json](pi-pin.json) records the artifact and source-reference distinction. The shipped RPC command reference was byte-compared with the research commit. The registry does not supply `gitHead`, so the repository does not claim a reproducible upstream source build.

The readiness manifest currently advertises only `persistent-session`, `managed-policy`, `task-context`, and `provider-admission`. The task-context frame is version zero for admission testing; durable user facts and compaction behavior arrive in M7.

## Readiness proof

The [S6 tests](test/proofs/required-capabilities.test.ts) reject missing controls, incompatible versions, wrong bundle/policy/session identities, unexpected reachable tools, forged credentials and stale epochs. They also check queued work remains undispatched, persistence failures deny grants, and lost heartbeats invalidate readiness.

[Real Pi tests](test/pi/readiness.test.ts) exercise successful turns, a missing extension, a throwing context hook and a failing nested policy hook. [Restart tests](test/pi/restart.test.ts) cover explicit transcript resumption and abrupt supervisor death. The journal tests include an actual SQLite page-limit failure, rather than only a mocked write error.

The [S1 attachment proof](test/proofs/session-attach.test.ts) kills a CLI during an actual Pi tool turn and reconnects to the same worker. It checks one user message, one attempt and one tool grant. Further cases drop an acceptance response, replay events after disconnect, kill the service during a prompt, and kill it between Pi completion and the SQLite completion commit. [Dispatch tests](test/unit/dispatch.test.ts) cover controller fencing, schema migration and a committed handoff before any pipe write.

M4–M8 remain to be built. ACP, durable human approvals, external-effect reconciliation, child tasks, durable task facts, cancellation controls and real model-provider routing are unavailable. S1 and S6 have local offline evidence; S2–S5 remain pending. Prompt deduplication does not establish exactly-once external effects.

## Local API

All endpoints use the operator Unix socket at `STATE_DIR/operator.sock`.

| Endpoint                              | Behavior                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`                      | Service health and per-session worker readiness                                                                              |
| `GET /v1/sessions`                    | List session snapshots                                                                                                       |
| `POST /v1/sessions`                   | `{request_id, cwd}`; create and provision a session                                                                          |
| `GET /v1/sessions/:id`                | Inspect a session and its durable event sequence                                                                             |
| `GET /v1/sessions/:id/snapshot`       | Session, controller view, bounded attempts/submissions and active-branch transcript                                          |
| `GET /v1/sessions/:id/events?after=N` | Replay and stream committed events after the snapshot cursor                                                                 |
| `POST /v1/sessions/:id/control`       | `{request_id, client_id, action, expected_epoch, token?}`; acquire, renew, release or take over a lease                      |
| `POST /v1/sessions/:id/submissions`   | `{request_id, expected_revision, text, client_id, token, continues_attempt_id?}`; atomically accept a submission and attempt |
| `POST /v1/sessions/:id/resume`        | `{client_id, token}`; provision a stopped session and dispatch safe queued work                                              |
| `POST /v1/sessions/:id/probe`         | `{client_id, token, nested?: boolean}`; run the fixed diagnostic after readiness                                             |
| `POST /v1/shutdown`                   | Stop the service and its owned workers                                                                                       |

Identical create/submission requests return the original saved result. Reusing a request ID with different logical input conflicts. Submission credentials are excluded from that logical input, so a new controller can recover a lost reply. Request lookup happens before checking an old revision or controller lease; a new mutation requires both. Diagnostics are repeatable tests, not idempotent user-work submissions, and require a controller lease.

A snapshot includes `seq=N`; subscribe with `after=N` to avoid a snapshot/stream gap. Snapshots bound recent attempts/submissions to 100 each and transcript messages to 100, with text budgets and truncation flags. Pi retains the full history. Final transcript import and attempt completion commit together. SSE respects backpressure and disconnects clients stalled for ten seconds; clients replay from their last durable cursor. Preview events have no durable ID; the CLI displays committed final results. The separate worker socket accepts session-scoped credentials and current epochs; it is not an operator endpoint.

On graceful shutdown, workers stop and active attempts become interrupted. After a service crash, the next service proves old workers have stopped before permitting a new writer. Uncertain process identity or missing recorded history makes the session unavailable for reconciliation. Schema version two migrates existing M2 accepted submissions into accepted attempts while preserving original cached acceptance replies.

## Development

```sh
npm run format:check
npm run check
npm run test:unit
npm run test:proofs
npm run test:pi
```

The [milestone record](docs/milestones.md) describes scope and evidence. CI is configured for macOS and Linux; local results only establish support on the platform where they ran. The [architecture notes](docs/architecture.md) describe state ownership and failure boundaries.
