# Salaam

Salaam is a local session service supervising persistent Pi workers. Terminal and editor clients will share the same sessions, while Salaam owns task and operation state around Pi's conversation history.

The current implementation covers **M0–M2**: a reproducible Pi bundle, transactional service core, supervised workers, and the required-controls readiness proof. The available model route is an offline scripted provider. Its diagnostic turn exercises the real Pi executable, context injection, direct and nested tool calls, session persistence, and the service gates without model credentials.

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
node dist/src/cli.js session probe SESSION_ID --state /tmp/salaam-dev
node dist/src/cli.js service stop --state /tmp/salaam-dev
```

Wait until inspection reports `ready` before running a probe. `service start` detaches the daemon from the calling terminal. Add `--foreground` to run it under a process supervisor. Without `--state`, the default is `~/.local/state/salaam`. Both `sal` and `salaam` executable names are declared for a later packaged installation; direct Node commands work in this checkout.

Use a short state path for macOS Unix socket limits. The directory and sockets are private to the local OS account. The first prototype treats that account as one trusted operator; it does not isolate hostile programs running as the same user.

## What is implemented

- SQLite WAL journal with full synchronization, schema versioning, foreign keys, transactional state/events, durable request deduplication, and revision checks.
- An OS-managed exclusive state lock, independent of the application journal, that releases on process death.
- Session creation, inspection, health, durable event replay/SSE, accepted input storage, and content-checked artifacts.
- Pi subprocess ownership, explicit session paths and IDs, worker epochs, process-group cleanup, heartbeat expiry, and conservative restart fencing.
- An authenticated worker bridge and a required manifest covering the bundle, session, policy, reachable tools, provider route, and task-context digest.
- Service-side admission before each diagnostic provider request and managed tool operation, including nested calls.
- A real-Pi diagnostic provider and independent fake-Pi, protocol, and durable mock-effect fixtures.

Pi is pinned to npm artifact **`@earendil-works/pi-coding-agent@1.3.0`** by exact dependency, lockfile integrity and installed package-content digests. [pi-pin.json](pi-pin.json) records the artifact and source-reference distinction. The shipped RPC command reference was byte-compared with the research commit. The registry does not supply `gitHead`, so the repository does not claim a reproducible upstream source build.

The readiness manifest currently advertises only `persistent-session`, `managed-policy`, `task-context`, and `provider-admission`. The task-context frame is version zero for admission testing; durable user facts and compaction behavior arrive in M7.

## Readiness proof

The [S6 tests](test/proofs/required-capabilities.test.ts) reject missing controls, incompatible versions, wrong bundle/policy/session identities, unexpected reachable tools, forged credentials and stale epochs. They also check queued work remains undispatched, persistence failures deny grants, and lost heartbeats invalidate readiness.

[Real Pi tests](test/pi/readiness.test.ts) exercise successful turns, a missing extension, a throwing context hook and a failing nested policy hook. [Restart tests](test/pi/restart.test.ts) cover explicit transcript resumption and abrupt supervisor death. The journal tests include an actual SQLite page-limit failure, rather than only a mocked write error.

M3–M8 remain to be built. The API stores accepted submissions for M3 but **does not dispatch them**. The diagnostic endpoint executes only a fixed offline probe. Interactive attach, controller leases, ACP, human approvals, external-effect recovery, child tasks, durable task memory, and real model-provider routing are not available yet. S1–S5 are not claimed as passing.

## Local API

All endpoints use the operator Unix socket at `STATE_DIR/operator.sock`.

| Endpoint                              | Behavior                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/health`                      | Service health and per-session worker readiness                              |
| `GET /v1/sessions`                    | List session snapshots                                                       |
| `POST /v1/sessions`                   | `{request_id, cwd}`; create and provision a session                          |
| `GET /v1/sessions/:id`                | Inspect a session and its durable event sequence                             |
| `GET /v1/sessions/:id/events?after=N` | Replay and stream committed events after the snapshot cursor                 |
| `POST /v1/sessions/:id/submissions`   | `{request_id, expected_revision, text}`; durably accept, without dispatching |
| `POST /v1/sessions/:id/probe`         | `{nested?: boolean}`; run the fixed diagnostic after readiness               |
| `POST /v1/shutdown`                   | Stop the service and its owned workers                                       |

Identical create/submission requests return the original saved result. Reusing a request ID with different input conflicts. Request lookup happens before checking an old revision. Diagnostics are repeatable tests, not idempotent user-work submissions.

A snapshot includes `seq=N`; subscribe with `after=N` to avoid a snapshot/stream gap. Slow clients are disconnected and can replay from their last durable cursor. The separate worker socket accepts session-scoped credentials and current epochs; it is not an operator endpoint.

On graceful shutdown, workers stop. After a service crash, the next service proves old workers have stopped before permitting a new writer. It never resends a model prompt. Uncertain process identity or missing recorded history makes the session unavailable for reconciliation. Existing sessions can be resumed through the supervisor API; a user-facing resume command is part of M3.

## Development

```sh
npm run format:check
npm run check
npm run test:unit
npm run test:proofs
npm run test:pi
```

The [milestone record](docs/milestones.md) describes scope and evidence. CI is configured for macOS and Linux; local results only establish support on the platform where they ran. The [architecture notes](docs/architecture.md) describe state ownership and failure boundaries.
