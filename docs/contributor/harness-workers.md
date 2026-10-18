# External harness boundary and negotiation

This is contributor evidence for the M16 development slices. External worker
assignment, permission delivery and recovery are still being implemented. A
successful probe does not admit a harness to a task or grant tools.

## Bounded protocol negotiation

`sal harness probe --pin FILE` accepts an operator-reviewed exact executable path,
SHA-256 entry digest, version and one of three named targets. It creates a private,
disposable empty home and forwards no inherited credentials, configuration,
repository, SSH agent or service socket. It sends only initialization. ACP v1 and
Codex app-server have separate wire dialects. Advertised capabilities stay separate
from enforced capabilities; every negotiation receipt currently reports file,
command, resume-dispatch and internal model-budget enforcement unavailable.

The independent stdio peer covers fragmented Unicode, both dialects, malformed and
oversized output, unexpected/duplicate IDs, denied client requests, bounded pending
work, unsupported methods and unknown outcomes after timeout. There is no retry on
a poisoned connection. Stderr and queued input have bounds too.

Observed credential-free negotiation on the local macOS arm64 host:

| Target             | Pinned version                            | Launch                    | Observed scope                                       |
| ------------------ | ----------------------------------------- | ------------------------- | ---------------------------------------------------- |
| Gemini CLI         | 0.64.0                                    | `--acp`, no self-relaunch | ACP v1 initialization                                |
| Claude ACP adapter | `@zed-industries/claude-agent-acp` 0.23.1 | stdio entry point         | ACP v1; SDK 0.2.83, ACP SDK 0.17.0                   |
| Codex              | 0.163.0                                   | `app-server`              | Separate app-server initialization and `initialized` |

The installed Gemini 0.18.4 experimental ACP path timed out and is not admitted.
Current exact npm artifacts were provisioned with scripts disabled before any
model turn. Private reports are in `.state/evidence/m16/`. Codex requires its
explicit private `CODEX_HOME` to exist; no account or user Codex home was loaded.
These observations establish negotiation only, not working turns or reconnect.

## Whole-process execution proof

The Docker harness boundary uses the digest-pinned Node 26.7.0 Bookworm Slim image
`sha256:4db36457f406501e6f608802e5da617e5fbd0e80b75901b6a09de1ae5a667d32`
and a proven dedicated Linux engine, with a separate effective profile. Gemini
0.64.0 invokes Bash directly; the smaller native-command image does not include
Bash and failed that execution rehearsal. The corrected image is provisioned
outside model turns and passes the whole-process proof independently. The harness runs
as the non-root daemon owner's UID/GID, preserving mode-700 host directories. It
gets exactly a private writable draft, a private writable home and a read-only
prepared runtime. The source checkout, sibling drafts, credentials and Docker
socket are absent. Root filesystem writes, capabilities and privilege escalation
are denied; memory, CPU, process, file-size, output and wall-time bounds apply.

A fixed PID-1 watchdog exits with the harness or after five minutes; its namespace
termination stops detached descendants. The fixed gateway has no mounts and no
external network. The harness shares only this gateway's loopback network
namespace. API traffic crosses a bounded stdio relay into a trusted host callback;
real provider credentials never enter either container. This relay alone does not
claim model-request or output-budget enforcement: the concrete provider callback
must prove admission, allowed destinations and output controls independently.

Every fresh start compares the exact engine, image ID, owner labels, effective
command/environment, resource/security settings and mount sources against its
receipt. Cleanup verifies owner labels before removing containers and affects only
the selected run. Deterministic container names permit ownership reconciliation.
A control or acceptance failure must leave work interrupted/unknown, without a new
prompt or an implied approval.

[The opt-in real proof](../../test/acceptance/harness-real.test.ts) passed on the
dedicated Colima Linux arm64 backend. It exercised actual draft/home writes,
read-only runtime, denied host/parent/socket access, external/metadata/other-port
network denial, loopback gateway traffic and descendant cleanup. The ignored
`.state/evidence/m16/whole-process-local.json` records its source/build/backend and
container identities. Unit tests reject changed image, user, network, memory, CPU,
mount source, capabilities, command, environment and ownership before dispatch.
An earlier macOS sandbox experiment failed and establishes no supported boundary.

The execution CI job runs the same real proof on Linux. Named harness turns,
independent approve/deny decisions, owned-session reconnect, durable invocation
admission and the final mixed-runtime portfolio remain required gates.

## Live Claude gateway and protocol checkpoints

The pinned Claude ACP adapter completed a live private-draft repair on the tested
Sonnet 4.6 route, using five real model requests capped at 4,096 output tokens each.
Exact edit and command permission scopes were recorded. The SDK's inner command
sandbox failed initially; an explicitly scoped retry used the already proven
outer Docker boundary. The test file, package metadata and human bytes survived,
and a fresh independent Salaam command receipt passed with exit code zero.
Reloading that owned session's history made no additional model requests. This was
history loading on the same connection, not a transport/daemon reconnect proof.
The report is
`.state/evidence/m16/claude-acp-0a7d5ae8-d075-46a3-8cb0-7a48714e8c08.json`.
An earlier Sonnet 5.5 request failed because this pinned SDK used an incompatible
thinking format; it remains charged, and that adapter/model combination is not
claimed. No promotional-credit assumption changes the numerical admission cap.

The host Anthropic gateway authenticates the run's ephemeral local token, accepts
only its fixed API path and declared model, denies remote images/server tools,
replaces client authentication with host-resolved credentials, enforces the output
cap and records admission before forwarding. Budget or payload rejection forwards
nothing. HTTP failure retains its charge and has no gateway retry. It does not
change model-specific thinking semantics to force compatibility.

The protocol core now requires a synchronous durable checkpoint before session
creation, prompt dispatch and cancellation. A new adapter converts recovered
in-flight state to unknown before opening a connection. ACP refuses to load an
uncertain prompt because history cannot prove which invocation completed. Codex binds both thread and turn IDs;
owned readback can reconcile a known terminal turn. Lost acceptance never sends a
second prompt. Early or duplicate terminal events cannot duplicate completion.
Cancellation acknowledgement leaves work running until an actual terminal receipt;
cancel intent revokes pending permission grants immediately. Permission replies
map local approve/deny only to once-only ACP options or Codex accept/decline.
Storage failure closes control and denies all later grants.

Independent SQLite-backed protocol fixtures exercise these barriers and wrong-owner
cases. The core still needs connection to the service's assignment, invocation,
approval and recovery records; standalone conformance and live scripts do not
establish that integration. Gemini/Codex preflight captured their actual provider
payloads inside the boundary without forwarding to a live provider. The subsequent
named live turns and process-reconnect scope are recorded below.

## Gemini and Codex named execution and reconnect

The standalone [named-peer runner](../../scripts/harness-peer-live.mjs) now exercises
Gemini CLI 0.64.0 ACP and Codex 0.163.0 app-server on the pinned Bookworm image.
Both passed deterministic offline tool sequences, followed by live Claude-backed
repair rehearsals: Gemini used six model requests and Codex used seven, each
capped at 4,096 output tokens. These routes explicitly translate the Google or
Responses text/custom-tool wire subset to the declared Sonnet 4.6 backend. They
do not establish compatibility with a native Google/OpenAI account or ChatGPT
subscription. Backend identity and frontend model alias are recorded separately.

The bridge filters the model-visible tools, rejects unowned tool results and
remote media, and records concrete model tool arguments before returning a tool
call to the harness. Pinned Gemini ACP IDs include a tool-name prefix; correlation
requires its exact observed version. Codex approval commands include the concrete
Bash wrapper, so the correlation check parses literal argv and compares the exact
model-call ID, command and working directory. Titles, summaries and proposed
session-wide execution rules cannot substitute for this scope. Once-only decisions
retain the protocol core's cancellation and storage-failure fences.

Each named run separately denies a forbidden write, approves the actual repair
and test, preserves protected files, and passes a fresh independent Salaam command
receipt. It then stops the harness process and containers, starts a new isolated
process with the same private home, and inspects the same saved upstream session.
No prompt is resent. Durable checkpoints, API admission counts, workspace hashes
and an actual command counter prove that reconnect neither requests a model nor
repeats the test. This proves known-terminal process reconnect, not uncertain ACP
prompt recovery or full daemon/task integration.

The ignored reports bind source/build, runner hash, the complete prepared runtime
digest and container receipts:

- Gemini: `.state/evidence/m16/gemini-acp-b7c95431-0478-401c-bd6e-f53803080730.json`
- Codex: `.state/evidence/m16/codex-app-server-ff25ed2d-548b-4650-a333-8c0a6e4c9b19.json`

Failed rehearsals remain recorded and all forwarded live requests remain charged.
`--offline-peer` uses deterministic responses without reading provider credentials
or charging the live allowance; its report explicitly identifies the fixture
backend and is never counted as live-model proof. Default tests exercise the wire
translation using independent pinned Google/OpenAI SDK clients and verify that a
scope-persistence failure prevents tool delivery after model admission.

The service assignment, explicit invocation-budget policy, shared approval inbox,
worker views and daemon recovery integration remain outstanding. External worker
assignment is not enabled by these standalone proofs. Claude ACP still requires
the separate approve/deny and process-reconnect portfolio beyond its earlier live
repair and same-connection history reload.
