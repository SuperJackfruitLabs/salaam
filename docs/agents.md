# Specialists and teams

Specialists run in separate persistent sessions with explicit profiles, tools and
request limits. The session service owns their identities, dispatch and results.
Closing a terminal leaves admitted work running. Reconnecting shows the same child
and result IDs.

## Admit a profile

Profiles are discovered from `.salaam/agents/*.md` in the session's source repository.
Discovery grants no tools. Inspect the profile, then explicitly admit its digest:

```sh
sal agents list --session SESSION_ID
sal agents inspect salaam/explorer --session SESSION_ID
sal agents admit salaam/explorer --session SESSION_ID --digest REVIEWED_DIGEST
sal agents admit salaam/reviewer --session SESSION_ID --digest REVIEWED_DIGEST
```

The built-in explorer reads an immutable repository snapshot. The reviewer also
inspects its diff and records findings with checked file, line and source evidence.
Neither profile edits files or runs commands. Repository snapshots exclude
credential and service-control paths. Findings are analysis; they do not verify a
task or replace its checks.

A project profile uses JSON front matter and a plain prompt body:

```text
---
{"revision":1,"role":"explorer","max_requests":4}
---

Investigate the public API and return exact file and line evidence.
```

The example file `api.md` becomes `project/api`. Profiles may narrow their role's
tools, select a provider/model pair, and declare a bounded request allowance. They
cannot configure commands, environment variables, credentials or plugins. Keep
provider credentials in Salaam's local credential store. Editing a profile fences
existing admissions; increase its revision, inspect it and admit the new digest.
Use `sal agents revoke GRANT_ID --session SESSION_ID` to revoke a grant.

Specialists receive their admitted prompt, specific instruction and facts explicitly
selected with `agents admit --facts FACT_ID,FACT_ID`. Parent conversation history is
not copied automatically. Separately selected provider routes retain their own
authentication and output-cap checks.

## Assign durable task steps

Create a task and admit the profiles before assigning its pending steps. Assignments
bind stable step IDs, the reviewed plan and a specific profile admission:

```sh
sal team assign TASK_ID --step STEP_ID --profile salaam/explorer --requests 4 --revision N
sal team show TASK_ID
sal team run TASK_ID --assignment ASSIGNMENT_ID --generation 0 --revision N --request-id investigate-1
```

Inspect the current task revision before each new mutation. Reuse the same request
ID and arguments after a lost response. A saved run returns its original claim and
does not start another worker. Independent steps can run together within the root
budget and worker limits; dependent steps wait for predecessor review or fresh
configured checks. Automatic team progression uses the task's existing bounded
progression grant.

After interruption, inspect the child outcome and confirm its process has stopped.
An explicit follow-up uses the assignment's current generation, a new instruction,
and `--continues ATTEMPT_ID` for the exact interrupted attempt. Recovery does not
redispatch uncertain work. Plan revisions invalidate assignments to older plans.
Assign an unattempted pending step again to admit a replacement for the new plan;
its earlier assignment and messages remain in the history. Append correction steps
when attempted work needs to change.

## Exchange messages

```sh
sal team send TASK_ID --to ASSIGNMENT_ID --text 'Compare the two saved reports.'
sal team receive TASK_ID --assignment ASSIGNMENT_ID
sal team ack TASK_ID --assignment ASSIGNMENT_ID --message MESSAGE_ID
```

Messages stay within their owning task. Sending or receiving does not start or
continue work. Stored, delivered and acknowledged are separate states. Use an
explicit run or follow-up to authorize another worker turn. The TUI Context view
shows the team board and inbox status from the same durable records.

Native team workers share the task's model-request and token limits. All workers
share its runtime and concurrency limits. [External harness workers](external-harnesses.md)
require a separate explicit invocation allowance and report unknown internal model usage.
Cancelling the task revokes active worker authority before attempting process stop.
A worker's final answer cannot declare a failed check successful or complete an
unrelated task.

## Build and integrate a coding proposal

The builder works in a private copy of the admitted repository snapshot. The
tester can run commands and record findings, with no persistent file-edit tool.
Both roles require a configured, proven execution backend. Their commands run in
bounded, network-disabled disposable copies; command edits do not become a patch.
The original checkout, parent workspace and sibling drafts stay outside worker
file authority.

```sh
sal agents inspect salaam/builder --session SESSION_ID
sal agents admit salaam/builder --session SESSION_ID --digest REVIEWED_DIGEST
sal team assign TASK_ID --step STEP_ID --profile salaam/builder --requests 4 --revision N
sal team run TASK_ID --assignment ASSIGNMENT_ID --generation 0 --revision N
sal workers proposal CHILD_ID
```

Each proposal page contains one changed file and its complete diff, plus the digest
of the entire proposal. Follow `next_offset` with `--offset N` to review every
changed file. `--json` includes exact file bytes and metadata. Inspect the root
workspace again before applying the reviewed proposal:

```sh
sal workers integrate CHILD_ID --revision WORKSPACE_REVISION \
  --root-digest ROOT_DIGEST --patch-digest PROPOSAL_DIGEST --request-id integrate-1
sal workers integration RECEIPT_ID
```

Integration checks each changed file against the worker's original baseline.
Disjoint edits can merge; overlapping root or human edits cause a conflict and
preserve existing bytes. The receipt records application separately from task
verification. A writing step cannot be reviewed or verified before its proposal
is integrated, and task success still requires fresh configured acceptance checks.
The integrator profile provides analysis; it cannot grant itself permission to
apply a patch.

An interrupted apply stays visible. Repeating its request inspects the saved
intent without applying it again. After reconciliation confirms no apply occurred,
explicit resolution can admit another attempt against the exact unchanged original
root:

```sh
sal workers resolve RECEIPT_ID --revision WORKSPACE_REVISION \
  --root-digest ROOT_DIGEST --request-id resolve-1
```

To request a different proposal after inspecting a settled worker, reject its
current claim with a reason, then admit a new explicit generation and instruction:

```sh
sal team reject TASK_ID --assignment ASSIGNMENT_ID --generation N --revision N \
  --reason 'Revise the implementation before integration.'
sal team run TASK_ID --assignment ASSIGNMENT_ID --generation N --revision N \
  --instruction 'Prepare the revised proposal while preserving human edits.'
```

Rejection survives restart and does not rewrite the earlier attempt's outcome.
Interrupted attempts still require their exact `--continues ATTEMPT_ID`. Workers,
commands and checks all consume root task concurrency; allow enough capacity when
running multiple writing workers. Cancelling a task revokes child authority and
cancels its owned commands before any further integration.
