# Native coding workers and integration

Schema 15 extends native worker admission with private coding copies, integration
receipts and explicit proposal rejection. This is a local Salaam contract; it does
not establish an external-harness sandbox or a federated authority protocol.

## Admission and execution

Builder and tester admissions require the configured executor's identity and
evidence. A real Docker executor must pass its pinned-image isolation probe before
the service opens. Injected offline fixture backends are labelled `fixture` and
produce `simulated-owned-copy` capabilities; they never establish real isolation.

The child intent commits an immutable filtered repository artifact, a separately
owned coding workspace, its baseline digest, executor profile/engine identity,
effective tools and the usual worker/task/assignment binding. Copy publication
fsyncs before its database reference commits. A failed transaction can leave
unreferenced private bytes; it never publishes a grant or reuses a partial draft.

Only builders receive the persistent file tool. Tester commands operate on a
disposable copy and cannot publish command-created files. File/command bridge calls
infer their session from authenticated worker identity; a body field cannot select
the parent, a sibling, a host path or an approval authority. Credential/control
paths are denied. Commands reuse the existing durable run journal, pinned executor,
network denial, limits, logs and conservative recovery.

Every terminal native child is stopped. An occupied or uncertain process retains
its worker slot until exit is known. A new assignment generation cannot replace a
live old process. Task cancellation commits revocation before aborting the child
and cancelling its owned command runs.

## Integration protocol

1. After the worker and command processes settle, inspect the exact baseline and
   draft. Proposal digests bind worker identity, child outcome, baseline, resulting
   tree and all changed files. The API pages one complete file/diff at a time.
   Failed/interrupted drafts are inspectable but cannot pass normal integration.
2. Explicit operator admission binds the proposal digest and the current parent
   revision/digest. Compare each changed file against its worker baseline. Preserve
   unrelated dirty bytes; overlapping edits fail before an apply intent commits.
3. Commit an integration intent and an fsynced resulting-tree artifact. The existing
   workspace mutation journal then records its own intent before writing a new
   revision directory. Published directories are never overwritten in place.
4. Record the applied mutation ID in the integration receipt. The receipt means an
   exact patch was applied, with `verified_success: false`. Writing-step review and
   verification require this receipt; task completion still requires fresh checks
   bound to the resulting root and execution environment.

A lost response returns the same integration identity without another apply.
Recovery reconciles an already staged workspace mutation using the existing byte
and revision checks. An intent with no confirmed apply becomes `needs_resolution`.
A new operator request can admit another apply generation only against the exact
unchanged original root, with no unresolved earlier mutation. Resolution is bounded
to eight generations and each authorization has its own durable event and key.
Changed roots require inspection and correction; they are never overwritten by an
old result artifact.

Rejecting a settled proposal records an operator decision over its exact attempt,
pauses progression and preserves the original attempt outcome. Recovery cannot
project an old model completion over that rejection. A new claim requires a new
instruction and current generation; interrupted attempts still require their exact
continuation identity.

## Evidence and remaining gates

- [Offline ownership/recovery proofs](../../test/proofs/worker-workspaces.test.ts)
  cover disjoint and overlapping patches, dirty bytes, explicit resolution, staged
  apply recovery, denied paths, persistent rejection and owned command cancellation.
- [Real executor rehearsal](../../test/acceptance/worker-real.test.ts) uses actual
  pinned Pi processes with a deterministic offline provider, two private writing
  workers, separate real Node test commands, an independent snapshot reviewer,
  initially failing and fresh combined checks, and restart with stable results.
  It runs in the existing opt-in real-task suite and Linux execution CI job.
- The local rehearsal passed on macOS arm64 against the dedicated Colima Linux
  arm64 Docker backend. The report in `.state/evidence/m15/real-local.json` records
  the observed engine/profile, worker bindings, checks and root digest. This is
  runtime execution evidence, not live-model usefulness, an independent native Linux
  host, external ACP/Codex isolation, or a power-loss durability claim.

Live comparisons against a single-agent baseline and the final mixed-runtime
portfolio remain acceptance gates. Their model requests share the separately
authorized overall live budget.
