# Managed MCP execution contract

The admission and HTTP transport modules are internal foundations. Session MCP
capability remains disabled until the service connects them to durable dispatch,
approvals, revocation and recovery. A passing parser or transport test does not
establish a usable AgentPod station integration.

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

The exact MCP SDK version is locked and bundled with the CLI. The managed HTTP
profile negotiates the reviewed protocol version, uses POST responses containing
JSON or SSE, refreshes the catalog before each call, and exposes no sampling,
roots, elicitation or task handoff capability. It opens no unsolicited GET stream.
Only admitted schemas are compiled for argument and structured-result validation.
Missing external schema references fail without fetching them.
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
