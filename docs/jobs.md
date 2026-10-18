# Durable jobs and schedules

A job binds an existing reviewed task to one deliberate logical occurrence. Creating a definition stays idle. Triggering it atomically records the occurrence and the task's bounded progression grant. Session, job, occurrence, task, step, attempt and worker IDs remain distinct across reconnect and daemon replacement.

One-shot jobs are the admission primitive. Recurring definitions capture immutable plan/workspace templates and create a fresh session, task and job for each occurrence. Schedules, host supervision and the durable shared operator inbox are enabled when an executor is configured. Public trigger gateways remain disabled.

## Define and run

Start with the installed CLI and a separate offline service state directory. Installing an upgrade does not replace an already running daemon. Keep provider keys and existing session state outside coding workspaces.

Create a fresh coding session and a [checked task plan](durable-tasks.md) with configured acceptance checks, deliverable paths, per-step checks and explicit task limits. All steps must still be pending, with no prior runtime admission or unresolved work. One job per task/session is supported. A new intentional one-shot run needs a fresh task/job; use a recurring template to provision these automatically.

```sh
sal jobs create TASK_ID --name 'Repair addition' --revision TASK_REVISION --max-steps 3
sal jobs list
sal jobs inspect JOB_ID

# Keep both identifiers stable after a lost response.
sal jobs run JOB_ID --key repair-2026-10-18 --revision JOB_REVISION --request-id REQUEST_ID
sal jobs occurrence OCCURRENCE_ID
sal jobs inspect JOB_ID
```

`--revision` refers to the task when creating a definition and to the job for later mutations. `inspect` returns the reviewed binding digest, current job/occurrence projection and task state. Listing is bounded to 32 records with `next_offset`; use `--offset N` for the next page. All mutating CLI commands accept `--request-id` and `--takeover`.

The binding fixes the task/plan, original workspace identity/revision/tree digest, executor engine/profile, provider route, policy digest, effect connector, step bound and compaction choice. The task's own request, declared token, runtime, concurrency and verification limits remain authoritative. Creation grants no tool authority; a trigger cannot supply another instruction, plan, cwd or target. Unknown fields are rejected.

The original request ID is checked before lease/revision preconditions. The logical occurrence key independently deduplicates a retry with a new transport request ID. It returns the same accepted occurrence before fresh admission checks; it never submits another instruction. A different key on a consumed one-shot job is rejected, including after cancellation or completion. `GET` inspection reports current truth separately from the saved acceptance response.

Current scope is checked again before model/tool/child/command grants, including after daemon replacement. A connector, policy, provider, plan or executor change cannot silently widen an admitted job. Scope changes block the job; inspect it and prepare a fresh task/job. Human workspace conflicts remain governed by the task's expected revisions and content hashes.

## Terminal and SSH controls

Ctrl+K → **Job actions** creates a definition, inspects its complete binding, triggers one logical occurrence or cancels it. Context shows the job/occurrence IDs and outcome alongside task budgets and verification. Actions are flushed to the durable client outbox before sending; credentials are supplied only at delivery. Lost replies retry the same bytes, and definite stale/rejected actions remain saved for review. They are not retargeted to a newer plan.

The same controls work through the existing `sal remote SSH_HOST --remote-bin /absolute/path/to/sal --state /remote/state --session SESSION_ID` path. Scriptable commands may be invoked through SSH against the execution host's private operator socket. SSH agent forwarding stays disabled. Host bootstrap uses an already provisioned runtime and backend. It does not copy keys, provision a VPS or open a public listener.

## Cancellation and recovery

```sh
sal jobs cancel JOB_ID --revision JOB_REVISION --request-id CANCEL_REQUEST_ID
```

Cancelling a definition before triggering revokes only that job. Cancelling an admitted job commits cancellation of its occurrence and task grant together, then aborts owned work. Recovery drains that committed cancellation if the daemon died before physical abort. Cancellation leaves uncertain external outcomes visible; it does not compensate effects. Cancelling a task through its existing controls is also reflected in the job.

- Crash before occurrence commit: acceptance, runtime start, grant and events roll back together. No work is reconstructed from an uncommitted trigger.
- Crash after commit before replying/dispatching: the same accepted occurrence and grant recover. A repeated trigger returns that occurrence; already queued task admission is not duplicated.
- Crash after dispatch: the existing attempt remains interrupted and blocks the task. A trigger retry is an inspection/recovery of its acceptance, never an automatic continuation. Inspect uncertain outcomes and use the explicit task continuation controls.
- A model answer cannot mark a job successful. It follows the task's actual checks, fresh completion evidence and distinct `succeeded_with_exception` outcome.

Required job recording failure denies new job admissions and invalidates affected worker readiness. After repairing storage, restart the service and inspect interruptions before explicitly continuing. Provider-request charges and uncertain child reservations are not reset.

Schema 10 adds definitions and occurrences while preserving schema-9 task IDs, attempt IDs, usage and cached replies. Schema 11 adds recurring templates, revisions, reservations and the inbox. Older daemons reject schema 11; use a backup for downgrade. See [reliability and support](reliability.md) for recovery guarantees and supported environments.

## Recurring templates and schedule revisions

```sh
sal schedules create TASK_ID --name 'Daily repair' --revision TASK_REVISION --max-steps 2 --schedule schedule.json
sal schedules inspect DEFINITION_ID
sal schedules occurrences DEFINITION_ID
sal schedules run DEFINITION_ID --key intentional-run-1 --revision 1 --request-id REQUEST_ID
sal schedules update DEFINITION_ID --revision 1 --status paused --schedule schedule.json
```

Omit `--schedule` for explicit recurring triggers only. The checked task must be unstarted. Capture stores an fsynced workspace artifact and immutable normalized plan, task limits, provider route, policy, connector, engine/profile and progression bound. Changes to the original source cannot change future occurrences. Revise a schedule to change timing; create a new reviewed template to change its work.

An interval definition uses UTC milliseconds:

```json
{
  "kind": "interval",
  "anchor": 1792281600000,
  "every_ms": 3600000,
  "missed": "skip",
  "max_catch_up": 1
}
```

A daily definition declares the timezone and DST behavior:

```json
{
  "kind": "daily",
  "time": "09:00",
  "timezone": "Asia/Kolkata",
  "gap": "skip",
  "fold": "first",
  "missed": "catch_up",
  "max_catch_up": 2
}
```

Daily gaps skip nonexistent local times. Folds choose exactly the first or second instance; both are never emitted. Timezone evaluation uses the pinned Node runtime's ICU timezone database, so host/runtime upgrades require a newly reviewed manifest. Interval minimum is one second. `max_catch_up` is 1–8. `skip` admits only a due slot observed within one second; older slots produce a durable missed-policy receipt. `catch_up` considers at most the configured number of oldest due slots, records the bounded remainder as skipped, and advances directly past downtime. Each next cursor commits with its reservations/skipped events. Paused/resumed or revised schedules start a new revision and cursor from the update time; they do not backfill the paused revision.

A schedule key is `schedule:REVISION:UTC_MILLISECONDS`. Explicit logical keys independently deduplicate transport retries. At most one unresolved occurrence is allowed. Waiting approvals, failed/interrupted tasks, uncertain effects and blocked provisioning all prevent overlap. Overlapping scheduled slots are explicitly skipped; they do not queue an unbounded backlog. Supersession and concurrent occurrences are unsupported.

Reservation commits its occurrence/session identities before filesystem provisioning. A deterministic private root is published only after its bytes are fsynced. A crash resumes the same reservation and verifies the existing root; it never overwrites a conflicting root. Task creation, the fresh job, occurrence link and progression grant then commit together. No model work is admitted before that transaction. Provisioning errors remain visible in the inbox and retry the same identity; an execution-scope change cannot admit a replacement task. Dispatched work still needs explicit task continuation.

`active` enables future slots, `paused` stops future reservations, and `cancelled` permanently stops the definition and revokes active task grants in the same revision transaction. Cancellation is drained on service recovery; no rollback of external effects is inferred. List and occurrence pages carry `next_offset`. The original one-shot API/cache remains compatible across schema-10→11 migration.

Ctrl+K → **Recurring jobs and schedules** captures templates, inspects definitions/occurrences, runs a stable key and revises timing/state. Mutations use the durable client outbox. Change a definition from its owning template session; inspect individual work in the occurrence session. Context carries the definition, occurrence, task/job and execution identities separately.

## Shared operator inbox

```sh
sal inbox list
sal inbox inspect ITEM_ID
sal inbox ack ITEM_ID --revision REVIEWED_REVISION --request-id REQUEST_ID
```

Attention includes approvals/expiry, unknown effects/commands, infrastructure failures, failed verification, blocked tasks and results. Its source key and acknowledgement revision survive controller, client and daemon replacement. Changed source evidence reopens attention; settled sources resolve it. Acknowledgement never approves an operation, retries a command or marks success. Each acknowledgement requires the current controller for the source session and exact reviewed revision.

Ctrl+K → **Operator inbox** reads all sessions with pagination and inspection/acknowledgement; Context shows current-session attention. ACP emits the same records in `session/update` metadata `salaam.dev/inbox` and supports `_salaam/inbox/list` and `_salaam/inbox/ack`. The latter requires a connected source session/controller. These are Salaam ACP extensions, not a claim that every editor renders a native inbox UI. Approval choices continue through operation-bound permission requests. Inbox persistence failure invalidates readiness and denies new job grants until recovery.

See [host operation](host-operation.md) for pinned bootstrap and supervision, and [verification](verification.md) for the actual offline Mac/Linux pilot and evidence limits.
