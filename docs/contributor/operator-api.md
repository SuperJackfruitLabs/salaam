# Operator API contributor reference

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

Durable task endpoints use the same private operator socket:

| Endpoint                                                                        | Purpose                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /v1/tasks?session_id=ID`, `GET /v1/tasks/:id`                              | Current task, runtime bounds, progression and verification projection |
| `GET /v1/tasks/:id/history?offset=N`                                            | Immutable plan/attempt history                                        |
| `POST /v1/tasks`, `POST /v1/tasks/:id/revise`                                   | Create/correct a plan                                                 |
| `POST /v1/tasks/:id/steps/:step/run`, `POST /v1/tasks/:id/steps/:step/complete` | Explicit attempt admission/continuation and operator review           |
| `POST /v1/tasks/:id/verify`, `POST /v1/tasks/:id/finish`                        | Isolated check and evidence-bound completion/exception                |
| `POST /v1/tasks/:id/auto`, `POST /v1/tasks/:id/cancel`                          | Bounded future admissions (zero pauses) and cancellation              |
| `POST /v1/tasks/:id/checkpoint`, `POST /v1/tasks/:id/restore`                   | Capture and reviewed conflict-preserving restoration                  |
| `GET /v1/tasks/:id/checkpoints`, `GET /v1/tasks/:id/restores`                   | Recent checkpoint/restore records                                     |

Task mutations require `request_id`, `expected_revision`, `client_id` and `token`. Task revisions are separate from session revisions; saved requests are checked first. Refreshed task responses project current service truth. See [task controls](durable-tasks.md) for plan shape, bounds, review and recovery.

One-shot job routes are `GET/POST /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/run`, `POST /v1/jobs/:id/cancel` and `GET /v1/job-occurrences/:id`. Mutations use the private operator socket, controller lease, revision and durable request ID; trigger bodies accept only a stable occurrence key. See [job controls](jobs.md).

Recurring controls use `GET/POST /v1/schedules`, `GET /v1/schedules/:id`, `GET /v1/schedules/:id/occurrences` and `POST /v1/schedules/:id/run|update`. The operator inbox uses `GET /v1/inbox`, `GET /v1/inbox/:id` and `POST /v1/inbox/:id/ack`. These are trusted host-local controls with strict trigger fields and source-session controller checks. [Host manifests](host-operation.md) pin startup/runtime/backend configuration before enabling schedules.

Identical command requests return their original saved result. Reusing a request ID with different logical input conflicts. Controller credentials are excluded from the submission/cancellation logical input so a new controller can recover a lost reply. Request lookup precedes mutation preconditions. Approvals use their own revision, independent of session progress. The local operator identity is derived from the private socket's OS-account boundary; caller-supplied actor IDs confer no authority. Diagnostics are repeatable tests, not idempotent user-work submissions, and require a controller lease.

A snapshot includes `seq=N`; subscribe with `after=N` to avoid a snapshot/stream gap. Attempts, submissions, approvals and operations are bounded to 100 each; transcript messages are bounded to 100 with text budgets. Operation values may be truncated and receipts are omitted from snapshots with `value_truncated`/`receipt_available` flags; inspect the full operation before deciding. Pi retains the full history. Final transcript import and attempt completion commit together. SSE respects backpressure and disconnects clients stalled for ten seconds; clients replay from their last durable cursor. Preview events have no durable ID; the CLI displays committed final results. The separate worker socket accepts session-scoped credentials and current epochs; it is not an operator endpoint.

On graceful shutdown, workers stop and active attempts become interrupted unless cancelled. After a service crash, the next service proves old workers have stopped before permitting a new writer. A known-dead unhealthy worker may be explicitly replaced, earning readiness in a fresh epoch. Uncertain process identity or missing recorded history still blocks reuse. Schema version eleven upgrades earlier service state while preserving cached replies, attempts, routes, approvals, operations, child results and usage.
