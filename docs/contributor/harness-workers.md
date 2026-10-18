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

The new Docker harness boundary uses the existing digest-pinned Node image and
proven dedicated Linux engine, with a separate effective profile. The harness runs
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
