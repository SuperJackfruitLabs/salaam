# Internal work admission boundary

This is an unfinished, disabled integration foundation. No feature is advertised,
no HTTP/ACP route instantiates `AgentPodWork`, and no task progression is enabled.
The actual protected station verifier remains required before this capability can
be exposed. Admission is not task completion.

The canonical owner is AgentPod `packages/contract/src/salaam-work.ts` at
`0dfda813` (private v1 contract). Salaam mirrors its closed shape and compares the
same 63 JSON cases from `salaam-work-v1.json`, copied byte-for-byte to
`test/fixtures/agentpod-work-v1.json`. Shape acceptance does not verify credentials
or grant authority. Runtime identity remains the existing AgentPod admission.

`AgentPodWork.admit` is an internal controller method. Its future authenticated
adapter must independently supply the selected session, board, card and stage.
It compares the request to that identity and the original admission. It computes
`input_digest` with Salaam's canonical JSON digest of the exact input and
`plan_digest` from `TaskWork.parse`'s normalized plan, including effective limits,
checks and steps. A producer must use the same normalization before enabling this
wire. The owner payload fixture is mirrored byte-for-byte and its fully expanded
plans preserve their digest through `TaskWork.parse`; this is offline conformance,
not a live producer acceptance. Never derive
trusted expected identity by copying the untrusted request into it.

Saved receipt reads first check the immutable principal/root/session binding.
The original exact request may recover its admitted receipt after restart or
revocation; that read grants no new work. New admissions still require fresh
wall/monotonic authority and execution checks, no unknown operations or outstanding
station resources, an idle task boundary and an available actual verification
binding. The node's authenticated control transport remains responsible for
caller read access; the internal method is not a public endpoint.

One SQLite transaction owns task creation, plan/steps, the work mapping, cached
request result, event and schema fence. Its run key includes organization, source
and run ID; a second request cannot replace the task even with a new epoch. The
mapping also uniquely binds session, task and original request. An existing task
or missing/corrupt mapping is never silently adopted. Default task progression
stays off. First successful admission sets schema29; earlier binaries must reject
it. Permission configuration never lowers that fence. Schema29 without its work
mapping table fails to open.

The current `TaskVerification.binding` requires a coding workspace and executor.
The protected station's actual root/check implementation is different. Until the
backend is wired into task admission and asynchronous completion, that admission fails and rolls the entire task creation
back. Tests using `TaskFixtureBackend` prove local journal/ownership behavior only;
that backend is explicitly simulated and executes no host command. Separate tests
prove unavailable verifier/workspace rejection. These tests are not protected
station, live Superpipeline or fleet acceptance.

Remaining work includes verified protected-root/check integration, immutable
request/receipt transport, exact human-decision bindings, current-run completion
reconciliation, lease/reclaim/effect recovery through the full product path, and
named scoped live acceptance. Neither ACP idle nor a returned model answer can
substitute for fresh required task checks. See AgentPod's
`docs/implementation/salaam-durable-work.md` for the cross-product assessment and
source/decision status.

## Protected verification backend (not enabled)

`StationTaskVerification` consumes existing task-check IDs. Before native command
execution, it persists a binding artifact joining the exact task plan/check,
prepared station call, input digest, root, reviewed configuration and expected
tree. It refuses to retrospectively attach a returned check to a newer task plan.
The current runner supports root-relative checks (`cwd: "."`); other check working
directories fail closed until the bounded runner supports them explicitly.

`withFresh` verifies the command result against the owned stopped systemd unit and
its cleanup receipt, then awaits a new protected filesystem inspection. The read
helper records its process identity before receiving input and requires observed
process-group exit. Its journaled inspection has a narrowly scoped exception from
the task-idle guard; a check or mutation cannot use that exception. Recovery treats
interrupted reads as failed and reconciles their owned process as before.

After the await, the adapter rechecks authority, configuration, plan, task revision,
call result, unknown effects and resources, and current tree. It invokes the task
controller's synchronous consuming callback within the same SQLite transaction.
There is no reusable `fresh: true` flag, automatic task success, or alternate
completion ledger. Every consumption re-observes the tree. TaskVerification's
ordinary idle check now also fences unsettled station calls and resources.

The backend is not installed in the service. Remaining integration must select it
when creating task checks, await it at completion/report boundaries, inspect actual
deliverables, preserve task budget/step semantics, and keep completion freshness
honest after later workspace changes. Current tests prove journal/receipt joins,
late revocation, drift and transactional rollback with a synthetic station double.
One component test runs an actual child helper and observes durable process-group
cleanup, while its filesystem receipt is explicitly synthetic. This does not prove
systemd isolation, the production file primitive, or a live station task completion.
