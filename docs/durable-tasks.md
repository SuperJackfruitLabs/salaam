# Durable tasks, verification and bounded progression (M11)

A task belongs to one persistent session and owns stable step IDs, an objective, constraints and a revisioned plan. Session, task, step, attempt and worker epoch remain separate identities. One task per parent session is supported in this slice; ordinary conversation sessions remain available without a task.

Creating or revising a plan does not dispatch work. By default, an operator starts each step and reviews the settled attempt. Explicit bounded progression can admit future steps, but only within the reviewed plan, workspace, execution environment and task budget. A model answer alone never completes a step or task.

## Start and inspect a task

Use a new session on an offline test daemon initially. The service must run this checkout's built code; rebuilding does not replace an already running daemon. Keep existing provider configurations and keys outside the disposable test state.

```json
{
  "objective": "Repair addition and inspect the result",
  "constraints": ["Preserve the public API"],
  "acceptance": [{ "key": "suite", "command": "node --test", "cwd": "." }],
  "deliverables": ["math.js"],
  "limits": { "requests": 12, "runtime_ms": 900000, "verification_runs": 8 },
  "steps": [
    {
      "key": "repair",
      "title": "Repair addition",
      "instruction": "Inspect the implementation and repair addition.",
      "depends_on": [],
      "checks": ["suite"]
    },
    {
      "key": "check",
      "title": "Check the repair",
      "instruction": "Run the relevant tests and report their actual outcomes.",
      "depends_on": ["repair"]
    }
  ]
}
```

Save that JSON as `plan.json`. Use `--state DIR` on every command for a dedicated daemon.

```sh
sal session create --cwd /path/to/disposable/repository
sal tasks create SESSION_ID --plan plan.json --revision 0 --request-id create-task-1
sal tasks current SESSION_ID
sal tasks inspect TASK_ID
sal tasks history TASK_ID

# Supply the task revision and stable step ID returned by inspect.
sal tasks run TASK_ID --step STEP_ID --revision N --request-id run-step-1
sal tasks inspect TASK_ID

# After inspecting the actual attempt, files and command outcomes:
sal tasks complete TASK_ID --step STEP_ID --revision N \
  --review 'Operator inspected the result; task verification remains pending' \
  --request-id review-step-1
```

Revision zero is the create precondition, meaning this session has no task. Later mutations use the task's current revision, independently of session revisions and controller epochs. Each transition can advance it; inspect before issuing a new mutation. Reuse the **same request ID and input** after a lost response. Saved responses are checked before lease and revision preconditions, including after daemon recovery revokes the old controller.

`run` admits one durable submission and attempt with its task/step/plan binding in the same SQLite transaction. A stopped worker needs a separate `sal session resume SESSION_ID`. An accepted step may dispatch after readiness; the dispatcher only executes the instruction already admitted by the operator. Without an explicit progression grant it does not choose or start another step.

Task-bound sessions reject unbound `session submit` and `session continue` requests, including ordinary TUI/ACP prompt submissions. Use `tasks run` or the TUI Task actions. The TUI's conversation banner identifies the task; its Context view shows the objective, constraints, plan revision, step states, dependencies and attempt IDs. CLI and host-local inspection read the same ledger. Ctrl+K → Task actions opens create/revise, step actions, checks, completion, bounded progression and checkpoint controls. Task actions use the flushed client outbox; a stale rejected action stays visible instead of being retargeted to a newer plan. Detaching leaves admitted work running; pausing prevents future step admissions; cancellation also revokes active work.

## Corrections, review and recovery

```sh
sal tasks revise TASK_ID --plan corrected-plan.json --revision N --request-id revise-plan-1

# Continue only after inspecting an interrupted attempt and any uncertain effects.
sal tasks run TASK_ID --step STEP_ID --revision N \
  --continue-attempt INTERRUPTED_ATTEMPT_ID \
  --text 'Inspect the interrupted result, then continue with this new instruction.' \
  --request-id continue-step-1
```

Plans accept up to 32 uniquely keyed steps with dependencies on earlier steps and up to 16 constraints, within the existing mandatory-context byte limit. Active plans are supplied through the managed task-context frame and checked by existing provider admission. A plan does not expand tool authority. Existing steps cannot be removed or reordered. Unattempted instructions can be corrected; an attempted step's definition is immutable, so append a correction step instead. Objective/constraint corrections and previous plan documents retain their request provenance. Plan edits require an idle session without unresolved interrupted work.

The task's current projection preserves reviewed steps, corrections and attempt links across worker and daemon replacement. Task/step changes and their events commit with the attempt state mutation. A process crash cannot expose a completed attempt with a still-running step or publish an uncommitted task event.

- Before dispatch: an accepted step remains queued with the same attempt ID. A retry of its acceptance returns the original response.
- After dispatch or during a tool: an uncertain attempt becomes interrupted, blocking the task. Recovery does not replay it.
- After Pi settles but before completion commits: the step remains interrupted even if an assistant answer exists in the transcript.
- After completion commits: the step remains awaiting operator review. Reviewed earlier steps remain completed and later steps remain pending.

An explicit continuation creates a new attempt on the same step, preserves the old attempt and resolves that exact interruption. Review is a recorded operator disposition, not a verification receipt. Failed or cancelled attempts cannot be marked complete; an operator may explicitly request another run. Normal attempt cancellation also updates the task projection.

History returns up to 32 plans and 32 attempt bindings per page with `next_offset`; use `sal tasks history TASK_ID --offset N` for later pages. Database schema 11 includes the task tables introduced in schemas 8–9 and adds M12 job, schedule and inbox records without changing session IDs or transcripts. Existing task admissions are charged conservatively on upgrade, and legacy cached requests retain their original hashes. Older service binaries reject this newer schema: use a state backup for a downgrade rather than opening it with an old daemon.

## Fresh verification and completion

Checks run as durable isolated commands against a captured owned workspace revision. Receipts include the command/cwd, workspace identity/revision/tree and diff digests, executor engine/profile, actual exit outcome and output/snapshot artifacts. A receipt passes only after the actual command succeeds with exit zero. An edit, plan correction, changed execution environment or later failed check invalidates previous completion evidence.

```sh
sal tasks verify TASK_ID --check suite --step STEP_ID --revision N --request-id check-step-1
sal tasks finish TASK_ID --revision N --request-id finish-task-1
```

Per-step `checks` permit machine-verified step completion. Steps without checks require explicit operator review. Final success requires every step completed, configured global checks freshly passed, configured deliverable files present with recorded hashes, and no unresolved work or uncertain effects. The service rechecks the workspace before committing the final evidence. Tool/model text saying “done” cannot replace these receipts.

Where machine verification is unavailable, `finish --exception-reason TEXT --evidence-artifact ID` records an explicit operator attestation using an artifact belonging to the same session. Its outcome is `succeeded_with_exception`, with `verified: false` and missing requirements recorded. It is distinct from verified success.

## Shared task budgets and opt-in progression

```sh
sal tasks auto TASK_ID --revision N --max-steps 3 --compact --request-id bounded-run-1
sal tasks pause TASK_ID --revision N --request-id pause-1
sal tasks cancel TASK_ID --revision N --request-id cancel-1
```

A progression grant starts at most the declared number of new steps (maximum 32). It binds the plan, owned workspace and proven executor. Fresh step verification advances that binding. Human edits or executor changes stop future admissions. Persisted grants and request IDs prevent duplicate attempts after lost replies and daemon restart. Interrupted dispatched work requires an operator continuation; it is never blindly resubmitted. Reconfiguring progression creates a new authority epoch and revokes unaccepted old grants without resetting spending.

Default task limits are 64 provider requests, 15 minutes from first admission, concurrency 3, 16,777,216 declared token units, per-request input/output bounds 131,072/8,192 and 32 verification runs. Parent and read-only children share the limits; child work reserves its request/token allowance before admission. Completed children release unused reservations; uncertain work retains them. Verification commands consume the verification count and remaining runtime. Restart and plan edits preserve accumulated charges and the original start time. A limit produces a durable blocked reason and stops progression. The elapsed runtime includes time spent disconnected or waiting for a person.

Token units are conservative application admission units: each request charges its full declared input plus output bound. Serialized input bytes are checked against the input allowance and provider output limits against the output allowance. This is not exact tokenization or a currency/billing cap. Known, estimated and unknown provider billing remain separately reported; missing usage never becomes a free request.

With `--compact`, the service may use the existing deterministic managed compaction only at idle boundaries. The persisted receipt is reconciled across daemon death. Pi's definitive “session too small” outcome records a skip, not successful compaction. Ambiguous/interrupted compaction stops progression. Model-generated compaction remains disabled.

## Checkpoints and conflict-preserving restoration

```sh
sal tasks checkpoint TASK_ID --revision N --request-id checkpoint-1
sal tasks checkpoints TASK_ID
sal tasks restore TASK_ID --checkpoint CHECKPOINT_ID --revision N \
  --workspace-revision W --workspace-digest DIGEST --request-id restore-1
sal tasks restores TASK_ID
```

A checkpoint captures the owned tree, including dirty work that predates the task. Restoration compares the task's recorded before/after mutations with the current reviewed tree. It restores only changes still owned by that mutation chain. Newer human edits, interrupted ownership chains and unrelated files remain intact and appear as conflicts or partial restoration. A durable intent precedes filesystem publication; recovery reconciles the existing mutation receipt rather than replaying a restore over newer bytes. Restoring pauses progression and requires new verification. External effects are never rolled back by a workspace checkpoint.

## Scope and proofs

`task-recovery` covers the original explicit-admission boundaries. `task-completion`, `task-lifecycle` and `task-gates` independently exercise false completion/failing checks, stale workspace/profile evidence, shared budgets, human approvals, lost responses, daemon SIGKILL between steps/during compaction, active interruption, durable restore intents and newer human edits. The acceptance bundle repeats these four named groups three times, separately from operator and S1–S6 repetitions. Budget unit tests additionally prove legacy migration and parent/child reservations.

`npm run test:tasks:real` is opt-in and requires `SALAAM_TASK_REAL_SOCKET` and `SALAAM_TASK_REAL_SCRATCH` pointing to an already provisioned proven Docker backend. It uses pinned offline Pi, real guarded file changes and isolated `node --test`, including an initially failing test, TUI admission, detach/reconnect, daemon SIGKILL, a bound human approval and fresh final receipts. No provider credentials are needed. Fixture backend tests alone do not establish execution isolation. See [observed verification](verification.md) for actual platform/source identities. M12 schedules and jobs, live-provider behavior, new GUI acceptance and power-loss guarantees remain outside these task proofs.

For the separate two-machine rehearsal, provision a source-only checkout and pinned dependencies in the explicitly approved private VPS directory, then compile the test helpers locally:

```sh
npx --no-install tsc -p tsconfig.json
node scripts/task-remote-rehearsal.mjs --host APPROVED_ALIAS \
  --repo /home/USER/.cache/salaam-m10.ID/m11-CHECKOUT \
  --node /home/USER/.cache/salaam-m10.ID/node-v26.7.0-linux-x64/bin/node
```

The script never provisions a server or copies credentials. It requires the existing native Docker socket, creates its own offline service and owned fixtures, drives the real remote TUI through SSH, kills that service between steps, reconnects for human review, verifies fresh completion, and removes its disposable state/workspaces/containers. It retains a source/backend-bound report and captured terminal cells under `.state/evidence/m11`.
