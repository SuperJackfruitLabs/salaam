# Mixed-runtime acceptance and release evidence

This contributor record covers M18. The public workflow is documented in
[specialists and teams](../agents.md#combine-worker-runtimes). It distinguishes
installed candidate behavior, deterministic fault proofs and separately budgeted
live usefulness. It does not authorize a release or deployment.

## Combined operator rehearsal

The opt-in [mixed-runtime runner](../../scripts/m18-mixed-live.mjs) uses the actual
installed candidate on a disposable Linux x64 execution host. A native explorer
reads the immutable fixture; an isolated Codex app-server worker proposes a repair;
a native reviewer publishes checked findings; an independent SDK A2A peer on the
Mac reviews only explicitly disclosed files. Fresh parent checks and explicit
hash-bound integration determine the final outcome.

The operator takes over the root controller while a concrete harness approval is
pending, inspects the shared inbox and repeats the saved assignment request with
an expired controller. A selected native review generation is cancelled at an
acceptance transport barrier before provider forwarding. Only an explicit new
generation can replace it. An installed Mac CLI opens real SSH PTYs twice against
the same Linux session. The Linux daemon is then killed with SIGKILL and reopened;
saved task/child identities, workspace digest and model counters must survive.

The trusted acceptance relay is additional test scaffolding. The real Claude API
key stays on the Mac. Only a fresh bounded proxy capability reaches the VPS; all
actual provider requests are charged in the host's shared durable acceptance
ledger before forwarding. Its fixed route is Claude Sonnet 4.6 with at most 4,096
output tokens and 40 model requests per mixed run, within the existing 200-request
portfolio authorization. Failures retain their charges. This is not evidence for
normal VPS account provisioning or an arbitrary network proxy.

The native worker preload initializes the pinned Pi HTTP dispatcher module before
installing the relay, preserving Pi's deliberate fetch-override contract. It does
not change Salaam's native tool/admission policy. The report hashes the service,
preload and provider-fetch adapters separately. Codex uses the declared Responses
to Claude text/custom-tool bridge, not native OpenAI or subscription authentication.

`--prepare-only` proves actual installed service/harness readiness with no live
call. `--codex-probe` uses deterministic model frames to test the installed Linux
Codex approval/repair path without spending API requests. `--run` is the separately
authorized live portfolio. The scripts deliberately require the explicit owned
rehearsal context rather than discovering production configuration.

## Crash and authority portfolio

These executable tests inspect durable counters, identities, actual effects and
workspace bytes. They do not accept model summaries as verification.

| Boundary                                                                                                      | Executable evidence                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Native identity, admission, profile and capability drift                                                      | [Worker boundary](../../test/proofs/worker-boundary.test.ts), [specialists](../../test/proofs/specialists.test.ts)           |
| Duplicate step claims, stale generations, message acknowledgements and selected task cancellation             | [Durable teams](../../test/proofs/team-work.test.ts)                                                                         |
| Daemon/worker death before and after dispatch and result persistence                                          | [Task recovery](../../test/proofs/task-recovery.test.ts), [child results](../../test/proofs/child-result-recovery.test.ts)   |
| Tool side effects and independent reconciliation after ambiguous delivery                                     | [Managed effects](../../test/proofs/effect-recovery.test.ts)                                                                 |
| Conflicting human edits, staged integration and failure before/after application                              | [Private drafts and integration](../../test/proofs/worker-workspaces.test.ts)                                                |
| Harness creation, prompt acceptance, permission decisions, delayed cancellation and failed checkpoint storage | [Protocol barriers](../../test/unit/harness-protocol.test.ts), [daemon integration](../../test/proofs/external-work.test.ts) |
| A2A lost acceptance, unknown task, tenant/context ownership and reordered stream/artifact identities          | [A2A protocol](../../test/unit/a2a-protocol.test.ts), [outbound](../../test/proofs/a2a-outbound.test.ts)                     |
| One-use peer grants, atomic admission failure, cancellation ownership and inbound daemon loss                 | [Inbound service](../../test/proofs/a2a-inbound.test.ts)                                                                     |
| Actual independent peer SIGKILL before model dispatch and after durable result; failed provider reply         | [Independent peer recovery](../../test/proofs/mixed-peer-recovery.test.ts)                                                   |
| Real terminal detach/reattach against the installed Linux service                                             | [Mixed terminal](../../test/acceptance/mixed-terminal.test.ts)                                                               |

Independent peer restart retains the same task/context and does not repeat a model
frame. A persisted result becomes one stable artifact. An uncertain dispatch and
a provider failure remain failed tasks; neither is turned into successful analysis.
Storage and required-control failures deny later grants. These cases supplement
the S1–S6 and coding/task/job regressions in the complete default suite.

## Capability scope

Native Pi workers use the reviewed request/tool boundary. Harnesses use the proven
whole-container Docker boundary with private drafts and a fixed host gateway. A2A
peers have no local file/command authority; their internal execution and model
usage remain unobserved. Confirmed peer terminal state is not a remote OS stop
receipt. See [harness evidence](harness-workers.md) and [federation evidence](a2a-federation.md)
for exact versions and supported directions.

The Linux rehearsal exposed a concrete Codex correlation difference: UID 1000's
passwd shell is displayed as `/bin/bash`; the earlier unmapped-UID rehearsal used
`/usr/bin/bash`. Both paths resolve to the same inode in the pinned Bookworm image.
The adapter accepts only those observed literal wrappers and still binds the
exact captured command, workdir, model-call identity and pinned Codex version.
Foreign shells, appended argv, expansions and command changes remain rejected.

Final source-bound candidate, mixed-run and CI receipts are recorded below after
all acceptance gates complete. Published npm 0.0.1 is a separate artifact; a local
candidate retaining that version is not a new publication.
