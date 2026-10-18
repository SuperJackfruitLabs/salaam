# A2A ownership and interoperability evidence

This contributor record covers the M17 implementation. The public operator guide
is [A2A peers](../a2a.md). M18 mixed-runtime, installed Linux and failure-portfolio
acceptance remain separate gates.

## Contract and authority

The pinned specification is A2A 1.0.0, wire version 1.0, JSON-RPC transport. The
independent JavaScript SDK is `@a2a-js/sdk` 1.0.1, integrity-pinned in the root
lockfile. Production transport code does not depend on the SDK's serializer;
independent conformance tests exercise its actual client and server in both
directions.

Outbound peers extend `ExternalWork`, team assignments, child attempts and the
existing invocation ledger. They do not create another Salaam scheduler. Endpoint,
card digest, selected skill, tenant, pinned IPs, credential digest, disclosure and
capability policy belong to operator configuration. Cards cannot supply endpoints
or credentials that become authority. Redirects, DNS fallback, metadata/link-local
addresses, inherited proxies and remote file retrieval are excluded. TLS verifies
the configured hostname while the socket uses the reviewed destination IP.

An A2A checkpoint has distinct message/task/context fields and a local run identity;
it is not encoded as an ACP session. Dispatch intent and disclosure are durable
before `SendMessage`. Unknown acceptance cannot be repaired by sending again.
Known-task inspection checks the same peer, tenant, task and context. Task loss,
unsupported cancellation and nonterminal cancellation acknowledgement retain
uncertainty. Confirmed stop records the actual remote terminal snapshot atomically
with slot release; it makes no remote OS/process claim. A failed save still attempts
owned cleanup, and obsolete daemon callbacks are detached on backend close.

Remote internal model usage and token spending remain unknown. Admission requires
the explicit invocation allowance and aggregate token-budget opt-out introduced
for opaque runtimes. Native model-request accounting is unchanged. Remote analysis
cannot obtain local files/commands or complete a checked parent task.

Inbound grants refer to operator-prepared, dedicated single-step native analysis
assignments. Their binding includes plan, limits, profile/grant, workspace,
provider and build/policy identities. Peer authorization is a separate internal
admission scope, never a minted human controller lease. The mapping, child, task
claim and dedup response commit together. One accepted message consumes the grant;
follow-ups and continuations require renewed operator admission.

Schema 17 adds `a2a_inbound`, with peer/tenant/message deduplication, unique assignment
ownership and task/context/child mappings. Older cached replies and event bytes
survive migration. Worker grant checks revalidate inbound authority. The private
listener exports only card, bounded submission, owned inspection/subscription and
owned cancellation; it does not expose operator or approval APIs. A remote
`ROLE_USER` is untrusted task data. Cancellation uses the existing dedicated task
ledger and records the peer origin.

## Streams and artifact identity

Polling snapshots are authoritative. Bounded stream progress is tentative: duplicate
or reordered artifact chunks cannot append bytes into a local result or mark the
task complete. A dropped subscription resumes by saved task ID and snapshots, never
another send. Streams check RPC/task/context ownership and have byte/event/time
bounds. Input/auth-required states do not automatically send another message or
relay credentials.

Hermes 0.22.2 regenerates artifact IDs, status timestamps and message IDs when
rendering results. Local content receipts bind task, artifact ordinal and content;
bounded upstream ID aliases are retained for audit. Meaningful terminal-content
changes still conflict. Its observed `[DONE]` marker is accepted only after an
owned terminal status; that marker grants no terminal authority without snapshot
reconciliation.

## Independent named peers

Local host: macOS arm64, Node 26.7.0, npm 11.19.0, Python 3.14.5. Peers ran with
disposable homes, fixture credentials and no provider keys or production agent
configuration. Their agent callback was an explicit deterministic fixture. These
are real pinned plugin transport tests, not full gateway/model/tool claims.

| Peer                   | Immutable source                                                             | Observed directions and limits                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hermes 0.22.2          | `d923a5eb487a17c0a68801bba9ef0f56c81040a8`                                   | Actual inbound adapter, native gateway base classes and outbound tools; text/data, task snapshots and terminal subscription; volatile in-memory tasks.                                                                                      |
| OpenClaw 2026.10.5     | `1b58cb9a1b4f4353e1add63c8506db4d890962e8`                                   | Actual tagged plugin source compiled unchanged against the exact npm runtime; polling, credential ownership, unsupported cancel and observed task loss. Its default sender is rejected for missing version header.                          |
| OpenClaw named ingress | Same release plus Salaam's `openclaw-2026.10.5-header-and-tenant-v1` adapter | Explicit grant and version-named endpoint normalize only the missing version/tenant from operator scope. Wrong supplied versions/tenants and all legacy method fallbacks remain rejected. One real native offline child completes analysis. |

The full local suite passed 2,139 tests. The locked operator preparation command and the five opt-in cases in [the peer portfolio](../../test/acceptance/a2a-interop.test.ts)
passed together on freshly prepared artifacts. The pinned peer CI job repeats that portfolio independently on Linux; its result must be checked before making a Linux claim. Ignored receipts are under `.state/evidence/m17/`: `hermes-plugin-interop`,
`hermes-client-interop`, `openclaw-plugin-interop`, `openclaw-client-interop` and
`openclaw-named-ingress`, each with a `.json` extension. The unsupported default
OpenClaw path is recorded as unsupported, not reported as successful interoperability.

Pins, public artifact integrity, Git blob identities, npm lock and hash-checked
Python dependencies are in [the runtime metadata](../../a2a-runtime/pins.json).
Preparation is an explicit contributor command outside model turns:

```sh
node scripts/prepare-a2a-peers.mjs NEW_PRIVATE_DIR /absolute/path/to/python3.14
```

Use its output paths for `SALAAM_A2A_OPENCLAW_ROOT`, `SALAAM_A2A_HERMES_ROOT` and
`SALAAM_A2A_HERMES_PYTHON`, then run:

```sh
npm run build
npx vitest run --config vitest.real.config.ts test/acceptance/a2a-interop.test.ts
```

The preparer disables npm install scripts, checks the unchanged Git blobs and
Hermes archive hash, and installs exact hash-checked binary Python dependencies in
a private venv. Upstream source emission uses `--noCheck` because the official npm
artifact omits several SDK declarations; it is not presented as an upstream
typecheck. Conformance uses the emitted real code and the official runtime.

## Recovery proofs

Default fixtures cover lost acceptance, wrong tenant/task/context, duplicate and
changed messages, volatile peer loss, unavailable controls, daemon reopen, native
worker interruption, peer cancellation, storage failure during atomic admission,
SSE reconnect, terminal-content conflicts, disclosure paths, changed card and
credential/configuration boundaries. Actual model/command counters and saved
task/child identities establish deduplication. Fixtures do not establish live
model usefulness, external process confinement or Linux deployment support.

No M17 conformance run used live model requests. The shared M13–M18 authorization
remains 200 requests with at most 4,096 output tokens each; the ledger currently
records 115 spent and 85 remaining. Failed requests are never refunded.
