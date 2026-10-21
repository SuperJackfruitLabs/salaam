# Execution evidence

The private AgentPod control transport exposes committed execution records without
renewing a lease, starting a worker, dispatching a model, or running verification.
Each read authenticates the original organization, principal, station occupancy,
session and run epoch. A revoked execution can retain historical data access.

`POST /v1/agentpod/work-evidence` accepts only `binding` and
`schema_version: "salaam-execution-evidence/v1"`. The canonical schema and shared
success/rejection corpus live in AgentPod's contract package; Salaam mirrors the
JSON Schema and corpus in `test/fixtures`. Existing unversioned evidence APIs are
unchanged. Consumers must explicitly negotiate the new version.

The projection reads a single SQLite snapshot. It joins source-owned task,
attempt, child, operation, native tool, check, integration and artifact identities.
Salaam UUIDs remain distinct from Hub attempt identifiers. Argument and receipt
digests are metadata; prompts, operation values, private paths, credentials and
raw protocol results do not appear in the projection. A digest proves consistency
with saved bytes, not authenticity or the success of an external effect.

Each section has a maximum of 256 records. Omitted records are reported through
`coverage.truncated`; unavailable evidence remains explicit. Missing usage stays
unknown or unreported. Recorded zero remains zero. A partial subtotal does not
price the missing observations, and ledger costs are not provider billing proof.
Usage evidence reads never add a charge or replay a request.

## Fingerprints and contributors

After the pinned package bundle, extension handshake and selected provider route
pass readiness, the worker's sanitized fingerprint is committed atomically with
`worker.ready`. The fingerprint binds the session and worker epoch to the package
bundle, policy, provider/model and context digests. Reading a saved fingerprint
does not establish current readiness, model effectiveness or fresh verification.
Older workers without a receipt remain unavailable.

A native child's immutable delegation identifies execution on behalf of the root
principal. Its local role name is not a new Organization-plane principal. Missing,
legacy, external or inconsistent contributor bindings cannot close the contributor
set for an independent nonhuman judge. Contributor projection grants no tools or
permissions. Existing judgment policy remains owned by Witness.

## Selected artifact bytes

`POST /v1/agentpod/work-evidence-artifacts` accepts only `binding`,
`schema_version: "salaam-execution-artifacts/v1"` and one to sixteen distinct
`artifact_ids`. It returns a consistent evidence snapshot and the exact immutable
bytes of the selected proposed, produced or integrated artifacts. The total raw
content limit is four MiB. Baselines, prompts, unrelated artifacts and arbitrary
filesystem paths are rejected. Every returned artifact is rechecked against its
committed content digest and length.

This is an explicit private export selection. It does not assert that all selected
content is public or free of secrets. AgentPod persists the original export intent
and bytes before uploading through Library's ordinary upload/commit API. Source
artifact bytes must be uploaded as raw files alongside the manifest so Library's
existing scanning and exact-byte validation apply. A metadata manifest upload alone
does not prove source artifact export. An upload failure, unconfirmed commit,
verified Library receipt and telemetry status are separate outcomes.

## Trace correlation

`POST /v1/agentpod/work-trace` accepts only `binding`,
`schema_version: "salaam-work-trace/v1"` and a valid nonzero W3C version-00
`traceparent`. The original work/root context is saved once. Reconnecting under a
different tracing parent returns the saved context. Derived invocation contexts
are stable across restart and propagate to admitted managed HTTP tool requests.

Trace metadata supplies no authority, usage observation, successful effect receipt
or independent verdict. Absent tracing stays absent. Malformed or unavailable
telemetry cannot authorize a denied tool call, block a permitted call, manufacture
usage or change artifact truth. The endpoint does not configure an exporter or
grant access to a collector. Vendor `tracestate` and baggage are not propagated by
this interface.

The wire follows [W3C Trace Context](https://www.w3.org/TR/trace-context/) and joins
the stack's ordinary [OTLP telemetry](https://opentelemetry.io/docs/specs/otlp/).
Observing saved trace metadata is distinct from observing delivery at a collector.
