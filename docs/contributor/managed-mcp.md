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
