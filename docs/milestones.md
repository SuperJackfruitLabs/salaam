# Implementation scope

M0–M3 implement the Pi session service foundation and reconnectable terminal workflow. They do not complete the broader six-proof service milestone.

| Package | Current scope                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0      | Local Git repository, exact runtime/tooling/Pi pins, package-content verification, real offline Pi turn, fake transport/provider and durable effect fixtures           |
| M1      | Transactional journal, migrations, exclusive state lock, request deduplication, revisions, durable event replay, artifacts, socket API and CLI inspection              |
| M2      | Pi adapter, managed session identity, authenticated bridge, required manifest, provider/tool admission, worker epochs, heartbeat failure, shutdown and restart fencing |
| M3      | Interactive attach/observe/takeover, controller leases, flushed client outbox, durable serial dispatch, bounded transcript snapshots, replay and explicit continuation |
| M4      | Pending: durable human approvals and concurrent decision routing                                                                                                       |
| M5      | Pending: managed external effects and uncertain-outcome reconciliation                                                                                                 |
| M6      | Pending: child work, result inbox and usage aggregation                                                                                                                |
| M7      | Pending: durable task facts and compaction proofs                                                                                                                      |
| M8      | Pending: ACP adapter, combined demonstration and six-proof acceptance bundle                                                                                           |

## Proof boundaries

S6 is exercised by manifest rejection, storage failure, forged or stale worker requests, heartbeat loss, real extension-load failure, context-hook failure and nested policy failure. Real Pi also runs successful diagnostic turns and resumes a persisted conversation. The independent effect fixture demonstrates durable acceptance across its own process death; it does not establish Salaam's future S3 operation ledger.

S1 now has an independent real-Pi offline proof: kill a terminal during a granted tool call, reconnect to the same worker and verify one user message, one attempt and one tool grant. Lost acceptance replies, durable event reconnects, service death during a prompt and death before completion commit have separate tests. Active attempts become interrupted after service death and are not replayed; unclaimed queued work remains accepted. Explicit continuation supplies a new instruction and preserves the interruption record.

S2–S5 remain pending. Cancellation controls and real model routing are outside the current implementation. No deployment, live fleet integration, broad credential compatibility, exactly-once external-effect or production-isolation claim follows from these local tests.

Reproduce validation with `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:pi`, and `npm run demo:session`. See `verification.md` for the last local evidence record. CI defines the same build and tests on macOS and Linux; a configured job is not an observed passing run.
