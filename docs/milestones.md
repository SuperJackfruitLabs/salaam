# Initial implementation scope

The first batch implements the Pi session service foundation. It does not complete the broader six-proof service milestone.

| Package | Current scope                                                                                                                                                          |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0      | Local Git repository, exact runtime/tooling/Pi pins, package-content verification, real offline Pi turn, fake transport/provider and durable effect fixtures           |
| M1      | Transactional journal, migrations, exclusive state lock, request deduplication, revisions, durable event replay, artifacts, socket API and CLI inspection              |
| M2      | Pi adapter, managed session identity, authenticated bridge, required manifest, provider/tool admission, worker epochs, heartbeat failure, shutdown and restart fencing |
| M3      | Pending: interactive attach, controller leases, durable dispatch and explicit continuation                                                                             |
| M4      | Pending: durable human approvals and concurrent decision routing                                                                                                       |
| M5      | Pending: managed external effects and uncertain-outcome reconciliation                                                                                                 |
| M6      | Pending: child work, result inbox and usage aggregation                                                                                                                |
| M7      | Pending: durable task facts and compaction proofs                                                                                                                      |
| M8      | Pending: ACP adapter, combined demonstration and six-proof acceptance bundle                                                                                           |

## Proof boundaries

S6 is exercised by manifest rejection, storage failure, forged or stale worker requests, heartbeat loss, real extension-load failure, context-hook failure and nested policy failure. Real Pi also runs successful diagnostic turns and resumes a persisted conversation. The independent effect fixture demonstrates durable acceptance across its own process death; it does not establish Salaam's future S3 operation ledger.

S1–S5 remain pending. Accepted submissions are deliberately left queued. No deployment, live fleet integration, broad credential compatibility or production-isolation claim follows from these local tests.

Reproduce validation with `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run verify:pi`, and `npm run demo:session`. See `verification.md` for the last local evidence record. CI defines the same build and tests on macOS and Linux; a configured job is not an observed passing run.
