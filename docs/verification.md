# Local M0 through M6 verification

Verified on **2026-10-17**, on macOS arm64 with Node **26.7.0** and npm **11.19.0**.

| Check                     | Observed result                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime/dependencies      | Exact Node, npm and Pi pins retained; dependency lockfile unchanged from M0–M2                                                                                                                                           |
| Formatting/type check     | `npm run format:check` and `npm run check` passed                                                                                                                                                                        |
| Final combined suite      | **101 tests passed**, no failures: all five S4 recovery/authority scenarios repeated three times, plus 86 other checks including 18 S6 readiness cases                                                                   |
| Default suite             | 91 cases with repetition disabled; the earlier 87-case intermediate M6 run also passed                                                                                                                                   |
| Managed proofs            | All 20 S2/S3 scenarios passed in the final suite. The M4–M5 baseline separately passed these scenarios three times (118 total tests)                                                                                     |
| Child recovery            | Parent death preserved both independent children; replacement workers reused original spawn keys and result IDs. Service death retained completed artifacts and explicitly interrupted unfinished children               |
| Inbox delivery            | Kill after result read and before acknowledgment preserved the same artifact. Repeated acknowledgments emitted no duplicate acknowledgment event                                                                         |
| Authority and budgets     | Child depth/concurrency and read-only intersection enforced; direct effect-bridge bypass denied before connector preflight. Parent reservations and child admission rejected over-budget dispatch                        |
| Usage                     | Stable request/Pi-entry imports deduplicated; nested tool totals ignored. Known/estimated/unknown amounts stayed distinct. Death before usage commit left null amounts and an explicit unknown count across two restarts |
| Atomic child publication  | Injected result-event storage failure rolled back the attempt outcome, artifact reference, child state and inbox event together. Worker loss before initial handoff published an interruption                            |
| Terminal death            | A killed CLI and reconnected observer shared one real Pi worker; one submission, attempt, user message and tool grant                                                                                                    |
| Lost responses            | Socket proxies dropped submission and decision responses; fresh outboxes recovered the original committed results without duplicating work                                                                               |
| Concurrent approvals      | Reverse decisions, two sessions, expiry, changed arguments/targets, worker replacement and unsolicited real Pi UI replies passed                                                                                         |
| Effect failure boundaries | Pre-intent rollback, prepared intent, dispatch before external acceptance, acceptance before receipt commit, receipt before tool return, worker/service death and cancellation passed                                    |
| Uncertainty               | Negative/unavailable lookup, mismatched receipts and opaque connectors remained unknown; no recovery path resent an effect. Explicit operator resolution retained its provenance                                         |
| Version race              | An intentionally stale preflight still met an external conditional-write rejection; no effect was accepted                                                                                                               |
| Persistence/protocol      | Schema-v1/v2/v3 upgrades retained cached replies and outcomes. Journal failure denied dispatch. Atomic transcript/completion, Unicode input, command FIFO ordering and large-event replay passed                         |
| Offline demos             | All three CLI demos passed against the final compiled bundle: session persistence, reverse approval/one effect, and two children with stable results, repeated acknowledgment and six unique provider requests           |
| Pi bundle verification    | Exact npm artifact, lockfile integrity and installed Pi package-content digests matched                                                                                                                                  |

The tested worker bundle digest is:

```text
d0c5afe72f313d5d7acf157491cf1879a665b30e46227bb58eacaf9e3b7b574d
```

The package pin is `@earendil-works/pi-coding-agent@1.3.0`. Its published RPC command reference matched the researched source commit byte for byte. No `gitHead` was supplied by the registry, so this evidence identifies the tested npm artifact without asserting full source-build equivalence.

Local reports are retained under `.state/evidence/` and excluded from Git: `m6-full-suite.json` (final 101-case run), `m6-pi-bundle.json`, `m6-session-demo.log`, `m6-managed-demo.log` and `m6-children-demo.log`. `m6-child-repeat.json` records an earlier successful 16-case child repeat/unit run. M0–M5 reports, including the 118-case M4–M5 result, remain historical evidence.

During M6 development, one new cancellation test initially checked the parent's final state immediately after its children aborted. The cancellation intent was already durable; parent completion is asynchronous. The test now waits for both final outcomes. The final repeated proof passed.

One earlier full run exceeded the S1 service-crash test deadline. Its report is retained as `m4-m5-timeout.json`; the exact cause was not established. The same S1 suite subsequently passed 35 cases across five runs, and the final combined suite passed. OS process-identity inspection now has a two-second subprocess deadline, and late bridge failures during intentional shutdown preserve stopped-worker state. These observations do not establish immunity to host scheduling or storage stalls.

## Reproduce

```sh
npm ci --ignore-scripts
npm run format:check
npm run check
mkdir -p .state/evidence
SALAAM_CHILD_REPETITIONS=3 npm test -- --reporter=json \
  --outputFile=.state/evidence/m6-full-suite.json
npm run verify:pi
npm run demo:session
npm run demo:managed
npm run demo:children
```

Local socket/process tests ran with host permissions because the execution sandbox denied socket creation. They used real pinned Pi with an offline provider and an independent durable local effect fixture. No live model account, fleet deployment or third-party production service was exercised. M3 was committed as `3ef8447` and pushed to `origin/m3-session-attach`. M4–M5 was committed as `dd95b6cd3c0a7e83d66ed6ad351577fd966f1430` and pushed to `origin/m4-m5-approvals-effects`; the remote head was verified. GitHub metadata previously confirmed that the Salaam repository was private. M6 is local work on `m6-child-work-usage`, based on that M4–M5 commit.

S1–S4 and S6 have local offline/fixture evidence; S5 remains pending. Interrupted prompts and unknown effects are never automatically replayed. Cancellation does not undo already accepted external work. Operator resolutions are attestations, distinct from verified receipts. Exactly-once behavior for arbitrary services/shell commands, real provider routing, durable task facts, production process isolation and host-loss recovery remain outside this evidence. Linux CI is configured but has not been observed running in this local verification.

Claude is the selected first live provider. These checks used no API key and make no claim of successful Anthropic authentication or live forwarding. Request budgets are counts, not token or currency limits. The accounting unit fixture includes compaction entry imports; real compaction recovery remains M7.
