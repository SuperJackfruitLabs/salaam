# Implementation scope

M0–M6 implement the Pi session service foundation, reconnectable terminals, durable approvals and managed fixture effects, child work and usage accounting. They do not complete the broader six-proof service milestone.

| Package | Current scope                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0      | Local Git repository, exact runtime/tooling/Pi pins, package-content verification, real offline Pi turn, fake transport/provider and durable effect fixtures           |
| M1      | Transactional journal, migrations, exclusive state lock, request deduplication, revisions, durable event replay, artifacts, socket API and CLI inspection              |
| M2      | Pi adapter, managed session identity, authenticated bridge, required manifest, provider/tool admission, worker epochs, heartbeat failure, shutdown and restart fencing |
| M3      | Interactive attach/observe/takeover, controller leases, flushed client outbox, durable serial dispatch, bounded transcript snapshots, replay and explicit continuation |
| M4      | Operation-bound approvals, own revisions/expiry, concurrent decisions, Pi dialog correlation, durable decision outbox and reconnect projection                         |
| M5      | Intent/receipt ledger, service action keys, conditional fixture connector, status lookup, explicit unknown outcomes/operator resolution and durable cancellation       |
| M6      | Independent read-only child workers, spawn keys, request-budget reservations, durable result inbox/acknowledgment and source-keyed usage aggregation                   |
| M7      | Pending: durable task facts and compaction proofs                                                                                                                      |
| M8      | Pending: ACP adapter, combined demonstration and six-proof acceptance bundle                                                                                           |

## Proof boundaries

S6 is exercised by manifest rejection, including missing approval/ledger capabilities, storage failure, forged or stale worker requests, heartbeat loss, real extension-load failure, context-hook failure and nested policy failure. Real Pi also runs successful diagnostic turns and resumes a persisted conversation.

S1 now has an independent real-Pi offline proof: kill a terminal during a granted tool call, reconnect to the same worker and verify one user message, one attempt and one tool grant. Lost acceptance replies, durable event reconnects, service death during a prompt and death before completion commit have separate tests. Active attempts become interrupted after service death and are not replayed; unclaimed queued work remains accepted. Explicit continuation supplies a new instruction and preserves the interruption record.

S2 has real-Pi evidence for two concurrent nested calls, reverse-order approve/deny, duplicate/conflicting/stale decisions, two sessions, expiry, changed targets and replacement worker epochs. Unsolicited raw Pi dialog replies cannot grant an operation. Client loss preserves pending approvals; worker loss invalidates old dialogs and requires a fresh binding.

S3 uses an independent durable HTTP-over-Unix-socket fixture. Barriers cover pre-intent rollback, prepared intent without dispatch, dispatch before external acceptance, external acceptance before response/receipt commit, and receipt commit before tool return. Service and worker death preserve or reconcile one effect. Negative/unavailable lookup, receipt mismatch and opaque connectors remain unknown; conditional writes reject changed versions. Cancellation denies prepared dispatch and preserves uncertainty after dispatch. Operator resolutions are attestations, not machine verification.

S4 has local real-Pi offline evidence for parent/service death, result redelivery, explicit acknowledgment, scoped cancellation, reserved request budgets and usage source deduplication. S5 remains pending. Durable task facts, ACP and real model routing are outside the current implementation. Claude is selected for the first live-provider integration. No deployment, live fleet integration, broad credential compatibility, exactly-once effect for arbitrary services or production-isolation claim follows from these local tests.

Reproduce validation with `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:pi`, `npm run demo:session` `npm run demo:managed` and `npm run demo:children`. See `verification.md` for the last local evidence record. CI defines the same build and tests on macOS and Linux; a configured job is not an observed passing run.
