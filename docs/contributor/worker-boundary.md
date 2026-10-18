# Native worker admission boundary

This is the local M13.1 contract, version 1. It does not establish a shared SJL
identity protocol or enable specialist tools, external harnesses, or A2A peers.

## Identity and admission

Schema 12 adds `worker_profiles` and `child_workers` beside existing child, attempt,
task, usage, request and result records. The child ID remains the logical spawn
receipt. A separate worker ID identifies its runtime assignment; the session ID
identifies the conversation, the attempt ID identifies the submission, and the
epoch fences a live process. Generation 1 is the only dispatch generation currently
admitted per child. Names and upstream IDs convey no operator authority.

The frozen binding records its version, owner session/task, parent attempt, step,
input digest/artifact, profile revision/digest, capabilities/digest, effective tools,
provider route/public connection configuration, workspace identity/revision/digest
if present, policy digest and model-request limit. Exact Pi pins and existing bundle
readiness checks establish the native runtime artifact. Credentials are resolved
separately through the private authenticated bridge, outside this record.

The only profile is `salaam/diagnostic`, revision 1, with `salaam_probe`. No project
profiles or broader grants exist. A workspace reference is provenance, not file
permission. The native process boundary does not claim OS-user isolation.

## Dispatch and recovery

1. Spawn commits the child, reservation, fsynced input-artifact reference, binding
   and intent events together. A rollback may leave unreferenced artifact bytes.
2. Before process launch, one transaction claims the intent and records generation,
   epoch and `child.worker_dispatching`. It can be claimed only once.
3. The adapter echoes the exact binding in readiness. The service checks it along
   with Pi state, tools, route, bundle and controls. `child.worker_accepted` means
   native readiness; existing attempt events track subsequent prompt acceptance.
4. Model/tool grants and successful completion recheck owner, input, profile,
   capabilities, route, generation and epoch. Periodic supervision also fences an
   active child whose profile is revoked or binding changes.
5. Terminal result publication and worker dispatch state change in one transaction.
   Delivery and acknowledgement remain separate from execution and parent reasoning.

A saved step resolves before fresh invocation/provider checks and returns its
original child without another launch. Changed input conflicts. Bridge identity
authentication still precedes lookup; a saved key never authenticates a caller.

Death before intent commit leaves no child. Death after intent, dispatch or native
acceptance interrupts the existing child on recovery; it is never redispatched.
Uncertain old process ownership continues to block replacement. This conservative
recovery does not claim exactly-once execution or resumable specialist work.

Profile revocation is currently an internal service record, with no public profile
management CLI. Reconfiguration cannot retarget existing work. Later profiles need
new admission and the profile-management surface.

## Budget and adapter scope

`bounds.scope: model-requests` counts admitted model requests using existing
parent/root reservations. Disabling token budgeting does not disable request
counting. Versioned capabilities describe request admission, authentication-dependent
output caps, usage receipts, retention, resumption, confirmed stop and coding tools.

Invocation-only runtimes are rejected. No external adapter or invocation-budget
grant is enabled. A future opaque adapter needs an explicit invocation policy and
counter, with visibly unknown internal usage; it cannot reinterpret `requests`.
The real pinned Pi adapter and forged readiness fixtures prove this native contract,
not ACP/A2A interoperability or external cancellation/durability.

## Migration and inspection

Migration preserves legacy child IDs, authority, results, acknowledgements, cached
response bytes, usage and events. Legacy bindings have `legacy: true`, null input
artifact and generation zero. Finished results remain readable; unfinished children
are interrupted by recovery and cannot acquire new execution grants. Pi JSONL is
never edited.

Child inspection/list responses and session snapshots add an optional `worker`
object. Older clients may ignore it; existing fields and saved responses retain
their meaning. Unknown capability versions and unsupported spawn fields fail
closed. `sal children inspect <id>` shows the full record. The TUI child list shows
profile, runtime, generation, dispatch state and request scope from the same data.

## Proofs

- [Boundary](../../test/proofs/worker-boundary.test.ts): real daemon SIGKILL before
  intent and after intent/dispatch/acceptance; lost reply/expired invocation replay;
  wrong owner, stale generation/epoch, revoked profile, changed capabilities/route,
  forged readiness and opaque-budget rejection.
- [Migration](../../test/unit/worker-migration.test.ts): schema 11 children, results,
  acknowledgements, charges and cached responses survive schema 12 and repeated opens.
- [Child recovery](../../test/proofs/child-result-recovery.test.ts) and
  [required controls](../../test/proofs/required-capabilities.test.ts) retain process,
  inbox, cancellation and readiness regressions.

These are offline host-local proofs. CI supplies separate macOS/Linux evidence;
live model usefulness, peer interoperability and deployment remain separate.
