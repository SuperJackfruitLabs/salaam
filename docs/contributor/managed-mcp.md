# Managed MCP execution contract

Managed MCP is an explicit, reviewed AgentPod host profile. Schema-2 hosts retain
their existing behavior. Schema-3 hosts bind `mcp_config` and its authority-bound
profile digest; they require a private node assignment and actual protocol/catalog
readiness before starting a worker. Complete node delivery and station acceptance
remain required before claiming a usable fleet integration.

AgentPod owns the canonical profile and private assignment schemas in
`packages/contract/src/salaam-mcp.ts`. Its `salaam-mcp-v1.json` corpus is mirrored
as `test/fixtures/agentpod-mcp-v1.json`. Both implementations consume its accepted
and rejected cases. Keep these bytes synchronized when changing the contract.

The reviewed profile pins a literal loopback proxy origin, named servers, complete
catalog and tool-definition digests, explicit `read` or `approval` policies, and
request, response, deadline and call-count limits. Server annotations supply no
authority. The separate private assignment carries the existing full AgentPod
principal, occupancy and run binding, profile digest, credential generation and
station-specific proxy headers. Send that assignment only over node-to-daemon
control. Public views contain fingerprints and tool policies, without endpoint
URLs or header credentials.

`McpAdmission` verifies private profile integrity and the assignment's data binding.
Its caller must separately enforce a fresh execution lease. The transport requires
a synchronous callback immediately before its single `tools/call` handoff; the
service must recheck authority and commit the durable dispatch marker there.
Historical request lookup precedes any new grant. A generation number in a parsed
assignment alone does not prove freshness.

MCP mutation permissions use the existing durable approval ledger with a distinct
operation kind and immutable call-context digest. Their preparation, one-time
consumption and result recording can share the caller's transaction. Only the
registered execution controller can consume a permission. A generic protocol
reply leaves an opaque external mutation unresolved; a human reconciliation or a
separately conformant owner receipt is required to settle its effect. An unknown
effect blocks consumption of other permissions, including already approved ones.

The exact MCP SDK version is locked and bundled with the CLI. The managed HTTP
profile negotiates the reviewed protocol version, uses POST responses containing
JSON or SSE, refreshes the catalog before each call, and exposes no sampling,
roots, elicitation or task handoff capability. It opens no unsolicited GET stream.
Only admitted schemas are compiled for argument and structured-result validation.
Missing external schema references fail without fetching them.
Schemas default to the MCP-defined 2020-12 dialect; an explicit supported draft-07
schema uses a separate validator. This matters for constraints such as
`unevaluatedProperties`, which a draft-07 validator does not enforce. See the
[MCP schema rules](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and [Ajv schema versions](https://ajv.js.org/json-schema.html#json-schema-versions).
The initial result profile accepts text and structured data. Media, task handoffs
and empty success acknowledgements fail explicitly rather than losing their
meaning during conversion.

Transport limits include the complete streamed response and a fixed total call
deadline. Redirects, OAuth flows, upscoping and automatic call replay are disabled.
A call marked `sent` may have reached the remote server even if it returns an
error, exceeds a limit or loses its response. Preserve that uncertainty for writes.
The returned value says `protocol_result: returned`; it does not establish a
verified product change. Known proxy credential strings and their common encodings
are redacted from returned data and transport errors use fixed public messages.

The offline proofs exercise the actual pinned SDK and real disposable loopback
HTTP sockets. They cover station/authority/header shape rejection, profile drift,
schema drift, argument/result validation, bounded streaming, redirect refusal,
credential redaction, one send and observed local cancellation. They do not call
the deployed Library, exercise real Accounts grants, or confirm that remote work
stops when a local HTTP response closes.

Journal schema 21 stores immutable call identities, context fingerprints and
sanitized result artifact references. Private assignment headers remain in the
controller's memory. Repeating an identical assignment during reconnect leaves
in-flight work alone; a changed generation invalidates its old calls and decisions.
A saved call is looked up before another grant or quota reservation. SQLite commits
the dispatch marker and consumed permission together, immediately before the
transport handoff.

The controller process proofs use real HTTP and SQLite with synthetic authority.
SIGKILL before dispatch leaves an unsent call; after acceptance it leaves a fenced
unknown mutation; after result storage it preserves the original receipt. Durable
cancellation closes the observed local response while retaining an accepted
mutation as unknown. An empty active-call list is not a remote effect or process
stop receipt; host stop confirmation must account for its actual owned resources.

The daemon owns credentials and HTTP transport. Worker configuration and readiness
contain only safe assignment fingerprints and reviewed policies. The progressive
`salaam_mcp` tool discovers servers, lists admitted tools and retrieves one schema
before making a call. Children receive no MCP authority. Each bridge and pre-send
grant checks the current root lease, worker/attempt and assignment. Reinstalling
the same assignment preserves a running call; rotation invalidates the worker's
readiness and old decisions. Ordinary invalid tool arguments send nothing and do
not invalidate the control plane. Profile, protocol or catalog failures do.

Root revocation and turn cancellation commit MCP tombstones with their existing
permission cancellation transaction before aborting transport. AgentPod stop and
turn-cancellation receipts account for active MCP resources and failed cleanup;
an empty active list cannot clear a transport-close failure. HTTP cleanup confirms
only local resources, while unknown external mutations remain separate. The real
pinned Pi/ACP proofs exercise readiness refusal, reconnect, daemon reopen with a
fresh authority renewal, catalog drift, ordinary argument rejection, turn
cancellation and root revocation against disposable HTTP servers. Their station
and product data are synthetic, and their provider is offline.

ACP accepts only declarations matching the private assignment's endpoint fingerprints, with
empty headers. It advertises HTTP and `salaam.dev/managedMcp` only for that bound assignment.
The separate node control response includes a protocol/catalog readiness receipt; merely
parsing or storing an assignment is insufficient. The same receipt rejection corpus is
consumed by the canonical contract, daemon and Go node.

The authenticated cross-product rehearsal runs the actual Hub, Go node, persisted proxy,
daemon and pinned Pi with synthetic signed Accounts and MCP product data. It covers Hub
restart, proxy rotation, node restart, occupant A→B→A, and daemon death after approved
HTTP acceptance. The proxy persists a binding fingerprint and principal/occupancy identity,
rotates its credential on handoff, invalidates the old station-token cache, and checks token
identity and its own generation again after minting. Upstreams retain their existing signature,
issuer, audience and entitlement checks. These proofs do not establish live Library or fleet
acceptance. A separate Anthropic-adapter proof uses a local mock API to verify that the actual
model tool inventory includes `salaam_mcp` and receives its result without the proxy key.

Managed assignments use a separate `/stations/<id>/mcp-managed-v1/<binding-digest>/<server>`
namespace. The daemon and node verify the digest against the fresh root binding; the
proxy verifies its persisted identity before minting or forwarding. A bound credential
cannot use the older transparent route. The actual M19 proxy artifact rejects the new
namespace before token minting, so rolling back the proxy fails closed for an existing
managed assignment. Shape validation alone cannot establish that the digest is current.

The internal stdio transport is preparation for the separate Toolkit integration.
It uses an exact executable checksum, explicit environment, pinned negotiation,
request/response/stderr bounds and a total response deadline. A synchronous owner
guard runs before each tool-call handoff. Closing it signals the owned process
group and confirms that the group disappeared; failed cleanup remains unconfirmed.
Its process proofs use a disposable fixture, not Toolkit. This primitive does not
admit configuration or grant authority, and no public ACP stdio capability or
Toolkit execution tool is enabled by its presence. Pending broker decisions still
require owner binding, revocation and recovery conformance before integration.

Journal schema 22 adds a durable Toolkit process registry alongside the existing
HTTP call records. Each private resource binds its session/root, reviewed profile,
manifest and complete launch fingerprints, canonical private state directory,
controller boot, actual PID and process start identity. Launch intent is committed
before OS spawn. The synchronous PID callback commits ownership before SDK
initialization or tool delivery; asynchronous guards cannot admit a call.
Resource events and state changes share one journal transaction. The migration
preserves existing requests, receipts and events without manufacturing native
process ownership. Older services reject the new schema instead of adopting it.

The daemon recovers these resources before exposing operator sockets. It stops
only an exactly identified predecessor; a missing, changed or unreadable live
identity cannot authorize signalling another process. An interrupted launch with
no recorded PID remains `unconfirmed`, blocking replacement, execution, authority
renewal and an authorized status. A free broker lock or an empty in-memory map
cannot clear that fence. A failed cleanup immediately blocks grants even if its
failure marker cannot be written; a different controller boot cannot adopt an
old running row. Root revocation and daemon shutdown account for these resources.
Unconfirmed shutdown retains the daemon state lock until its process exits.

Stopped resources have immutable receipts scoped to `local_process_group`, bound
to the exact recorded resource and input. These receipts establish local process
cleanup only. They neither verify an external product effect nor resolve an
uncertain native call. The broker's separate `managed-control-v1` contract has a
19-case canonical corpus mirrored here, and requires a private owner check for
the actual stop proof and exact resolution decision. An acknowledgement remains
a terminal non-success outcome. A saved call and an owned process are separate
records; neither one is a substitute for the other.

The registry proofs use real SDK/SQLite/OS processes under synthetic station
authority, including SIGKILL of the actual Salaam daemon with a surviving fixture
peer and before PID persistence. They check stop-before-renewal and uncertainty
surviving a new daemon, including retained ownership after failed shutdown.
Those peers are disposable Node protocol fixtures, not a compiled Toolkit
effect executor. Separate local producer interoperability proofs use the actual
compiled Toolkit and the pinned SDK with synthetic private owner callbacks.
The actual private effect-owner endpoint, protected Toolkit profile/credential
delegation, durable call/permission controller, turn/attempt mapping and model
tool integration are still required. No native Toolkit station capability or
real provider/Library acceptance is claimed by the resource registry.

### Private native launch admission

`ToolkitAdmission` is an internal host admission primitive. Its pinned private
profile delegates one credential store to the exact organization, principal and
full AgentPod binding (including occupant and run epochs). A new binding requires
a new reviewed profile; an existing store is never implicitly inherited.

The profile pins the executable, manifest and passphrase bytes. The manifest pins
the policy and Toolkit-owned protocol/profile fingerprint. All files, directories
and the owner socket must be canonical, owner-only and outside the workspace;
files cannot have additional hardlinks, and writable ancestors are rejected except
root-owned sticky temporary directories. Launch uses only `managed-mcp-v1`, an
explicit manifest/hash and a closed environment.

`ToolkitAdmission.transport` applies the admission through the resource controller
at preparation, before spawn, before PID registration and before SDK tool delivery.
An asynchronous check cannot admit a launch or delivery. Drift after startup closes
the transport before any tool bytes are sent.

This checks configuration integrity and delegation. It does not verify that a
binary implements the required broker protocol, grant a native effect, establish
sandbox isolation, or enable a station capability. The real effect controller must
also check admission and actual resources at fresh native grants, combine them
with durable call/permission ownership, and validate actual broker capabilities.

### Native call ownership and callback role

Schema 23 keeps `toolkit_calls` and per-process `toolkit_owners` in the service
journal. Preparing a call binds the full request, immutable invocation deadline,
actual resource, worker epoch, attempt, tool call and admitted native action pin.
Saved calls are checked before new authority. Historical data access remains
bound to the original principal/root; it does not grant fresh execution.

The private operator socket handles `/managed-toolkit/v1/verify`. Registration
is an internal trusted-controller operation, with no public registration route.
It checks private admission and the resource's exact launch pins before recording
an owner-key hash. Callback authentication requires that registered process key,
the current daemon's in-memory owner, actual persisted PID identity, unchanged
private configuration and fresh root/worker/attempt authority. Old keys cannot be
registered for another process or silently adopted after daemon recovery. Pending
replacement currently requires fresh private owner material; automatic per-process
manifest materialization is still required before exposing this as a station tool.

MCP delivery records intent without consuming an effect permission. `review`
answers the exact durable human decision. `admit` bounds credential acquisition
without spending the effect grant. Only `dispatch`, after the broker prepares
credentials, atomically consumes the permission and records its dispatch marker.
Native reads also have a durable one-time dispatch marker. Automatic native writes
are currently unsupported; a write's native kind is independent of its approval
policy and cannot be treated as a read.
The initial broker admits one unfinished native invocation, including a pending
human decision. Turn cancellation stops only a broker whose active invocation
belongs to that turn; cancelling an older completed instruction cannot stop a
later worker or its broker. Root revocation still stops all root resources.

A pending receipt preserves the original invocation and deadline. A denial before
dispatch is definite. A result after a spent write grant remains uncertain until
independent inspection/resolution; a protocol return never verifies product work.
Uncertain reads also fence root renewal and new work. Turn cancellation reports
their call IDs as unconfirmed resources after local process stop and daemon reopen.
All local cleanup paths still attempt worker cancellation when native cleanup fails.
Receipt/control failures also install an immediate resource fence if the journal
cannot persist uncertainty. Stopped or replaced processes with unfinished delivery
records cannot authorize a replacement merely because cleanup completed.

The callback implements only the work role. Credential-free cleanup controls and
asynchronous native acknowledgement/local operator resolution need a separate
stop-proof-bound role. No generic expired-authority bypass, direct edits to the Go
journal, public native house tool, or station coding capability is enabled here.
