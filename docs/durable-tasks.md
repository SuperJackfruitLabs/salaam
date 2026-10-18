# Durable tasks and explicit steps (M11.1)

A task belongs to one persistent session and owns stable step IDs, an objective, constraints and a revisioned plan. Session, task, step, attempt and worker epoch remain separate identities. One task per parent session is supported in this slice; ordinary conversation sessions remain available without a task.

Every step run is an explicit operator request. Creating or revising a plan does not dispatch work. A settled model attempt leaves its step `awaiting_review`; it never completes a task. An operator can record a reviewed step as `completed`. When all steps are reviewed, the task stays `verifying`: fresh verification receipts and verified task success belong to M11.2.

## Start and inspect a task

Use a new session on an offline test daemon initially. The service must run this checkout's built code; rebuilding does not replace an already running daemon. Keep existing provider configurations and keys outside the disposable test state.

```json
{
  "objective": "Repair addition and inspect the result",
  "constraints": ["Preserve the public API"],
  "steps": [
    {
      "key": "repair",
      "title": "Repair addition",
      "instruction": "Inspect the implementation and repair addition.",
      "depends_on": []
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

`run` admits one durable submission and attempt with its task/step/plan binding in the same SQLite transaction. A stopped worker needs a separate `sal session resume SESSION_ID`. An accepted step may dispatch after readiness; the dispatcher only executes the instruction already admitted by the operator. It does not choose or start another step.

Task-bound sessions reject unbound `session submit` and `session continue` requests, including ordinary TUI/ACP prompt submissions. Use the explicit `tasks run` path for this slice. The TUI's conversation banner identifies the task; its Context view shows the objective, constraints, plan revision, step states, dependencies and attempt IDs. CLI and host-local inspection read the same ledger. Interactive task editing and step actions in the TUI are deferred.

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

History returns up to 32 plans and 32 attempt bindings per page with `next_offset`; use `sal tasks history TASK_ID --offset N` for later pages. Database schema 8 migrates schema 7 without changing session IDs or transcripts. Older service binaries reject this newer schema: use a state backup for a downgrade rather than opening it with an old daemon.

## Scope and proofs

M11.1 does not enable automatic progression, task success, task-wide budgets, checkpoints, automatic compaction or remote schedules. Health exposes these limits explicitly. Existing S1–S6, approval, execution and coding rules continue to govern each attempt and operation.

`test/proofs/task-recovery.test.ts` exercises real pinned offline Pi workers and disposable daemons: worker SIGKILL, daemon SIGKILL during a later step, queued acceptance recovery, the completion-commit gap, CLI actions and TUI inspection. `test/unit/task-work.test.ts` covers request conflicts, dependency admission, operator review, immutable history, schema migration, cancellation, context capacity and injected transaction failures. The acceptance bundle repeats the task recovery proof group three times separately from operator and S1–S6 repetitions. These are process-recovery proofs; they do not establish power-loss durability, cross-platform acceptance or live-provider behavior without their own observed runs.
