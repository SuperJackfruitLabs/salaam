# Internal work admission boundary

This is an unfinished integration, with no advertised strict-work capability.
A reviewed protected-station daemon installs `AgentPodWork` on its private owner
socket; worker-bridge calls cannot reach it. No bridge auto-selection or implicit
progression is enabled by admission. Admission is not task completion.

The canonical owner is AgentPod `packages/contract/src/salaam-work.ts` at
`0dfda813` (private v1 contract). Salaam mirrors its closed shape and compares the
same 63 JSON cases from `salaam-work-v1.json`, copied byte-for-byte to
`test/fixtures/agentpod-work-v1.json`. Shape acceptance does not verify credentials
or grant authority. Runtime identity remains the existing AgentPod admission.

`AgentPodWork.admit` is a controller method used by private
`POST /v1/agentpod/work-admit`. The native node authenticates its Hub reservation;
board/card/stage are that trusted producer assertion, not model metadata. The
daemon derives the selected session from its existing pinned authority.
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
stays off. First standalone work admission sets schema29; protected task verification
requires schema30. Earlier binaries must reject newer schemas. Permission configuration never lowers that fence. Schema29 without its work
mapping table fails to open.

Without a reviewed protected station, the existing coding-workspace binding
remains required. A protected station selects its proven native backend; an
unavailable verifier rolls the complete task admission back. Tests using `TaskFixtureBackend` prove local journal/ownership behavior only;
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

## Protected verification backend

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

The service installs the backend only with its reviewed protected station. The
existing task controller accepts checks, charges the verification budget once,
dispatches through the native runner, awaits evidence at step/final completion,
and re-observes it for asynchronous views. Synchronous freshness never asserts a
station check is fresh. Completion uses the existing task completion ledger and
requires every configured deliverable to be read through the protected file
primitive at the same tree digest. Files exceeding that primitive's current
256 KiB read bound fail closed. Strict station completion does not accept an
operator exception in place of verified checks.

Schema30 gives station calls either model-attempt ownership or explicit task-check
ownership. Task checks have no fabricated model attempt; database constraints
forbid dual or missing ownership. Startup migration preserves historical calls,
rebuilds the table in one transaction with foreign-key validation, and leaves
foreign-key enforcement enabled. Interruptions before native dispatch can repeat
only the read observation. A persisted prepared/running command is cancelled or
failed by native recovery, never silently executed again. Task cancellation and
root revocation stop task-owned helpers and units as well as model-owned work.

Tests prove controller budget/replay/completion behavior, actual SQLite reopen,
late revocation, missing deliverables, drift and transactional rollback using a
synthetic station runner. A component test runs an actual helper process and
observes durable process-group cleanup/cancellation, but its filesystem receipt
is synthetic. Real protected Linux/systemd acceptance, live Superpipeline flow,
human-decision binding and scoped product canary remain required before M21 is
complete or the capability is advertised.

The private `work-decisions` and `work-decision` routes join a durable offer to the
existing ManagedWork approval, immutable operation digest, work request, task plan,
and deadline. Only the authenticated producer may deliver the exact correlated
Superpipeline answer. Answer persistence and the existing approval decision commit
atomically; replay returns that receipt without granting another permission or
executing the operation. Actual execution still consumes its original permission.
The canonical decision fixture is mirrored from AgentPod.

`work-completion` never caches a freshness claim: each request awaits protected
check, tree, and deliverable observations, then rechecks task revision, authority,
resource closure and the saved completion artifact. Its stable receipt includes
work/task/plan/binding identity plus the completion artifact and evidence digest.
The AgentPod producer must persist this receipt before reporting, and reconcile
an uncertain report against the original Superpipeline run. These private routes
remain unadvertised pending integrated Linux and product acceptance.

Strict progression is an explicit service acceptance opt-in
(`agentpodWorkProgression`), disabled in default hosts. Private `work-capability`
reports this honestly. `work-progress` binds one original work request and exact
step count to `TaskDriver.configureInTransaction`, the existing domain-owned grant
engine also used by jobs. Its authorizer is the fresh AgentPod run admission;
it does not manufacture terminal control. An active local controller or competing
grant blocks admission. Reconnect recovers the original grant without replenishing
steps. `work-status` exposes the existing task view and `auto_enabled`.

Explicit Linux acceptance fixture: `test/fixtures/agentpod-station-task-linux.mjs`.
Requires built source, Node26.7, root/systemd on an isolated host, the real reviewed
AgentPod stationfs executable, and the prepared immutable runtime root/image pin.
Set `SALAAM_M21_LINUX_ACCEPTANCE=1`, `SALAAM_STATION_FILES`,
`SALAAM_STATION_RUNTIME_ROOT`, and `SALAAM_STATION_RUNTIME_IMAGE`, then run with
Node. It creates only fresh `/tmp/sm21-*` scratch, retains its journal/evidence,
and exercises real native checks, bounded progression, 50,000 source files,
completion freshness, daemon restart dedup, SIGKILL recovery, explicit revocation
and actual90-second lease expiry. It uses synthetic private authority and the
offline model; it does not prove live Hub/Superpipeline or opaque external effects.

Restart handling distinguishes an intact previous-boot lease awaiting renewal
from an expired/revoked or corrupt admission. The former remains unable to grant
execution, but does not discard its original bounded progression grant while the
node reconnects. Actual wall expiry still revokes; current-boot monotonic expiry
still denies. The Linux fixture includes a daemon kill after the progression
grant commits but before its first attempt, a no-execution interval before fresh
renewal, and recovery of that exact grant.

Mixed-version rollout remains closed: current host schema5 has no production
strict-work opt-in. Enabling a default host requires an explicit reviewed manifest
contract, source/runtime and protocol pins, CLI/service propagation, native node
validation, and startup-drift rejection proofs. Older/disabled daemons must be
rejected by strict bridge selection before a run claim, without falling back to
unverified ACP completion. Acceptance fixture opt-in alone is not this rollout.
