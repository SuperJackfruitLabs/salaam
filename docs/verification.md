# Local M0 through M5 verification

Verified on **2026-10-17**, on macOS arm64 with Node **26.7.0** and npm **11.19.0**.

| Check                        | Observed result                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime/dependencies         | Exact Node, npm and Pi pins retained; dependency lockfile unchanged from M0–M2                                                                                                                |
| Formatting/type check        | `npm run format:check` and `npm run check` passed                                                                                                                                             |
| Final combined suite         | **118 tests passed**, no failures: 60 managed approval/effect cases across three runs, plus 58 other checks including the 16 S6 readiness cases                                               |
| Managed proofs               | All 20 S2/S3 scenarios passed three repetitions. With repetition disabled, the default suite contains 78 cases                                                                                |
| Additional attachment repeat | 35 S1 cases passed across five runs after an earlier timeout; the final combined run also passed all seven S1 scenarios                                                                       |
| Terminal death               | A killed CLI and reconnected observer shared one real Pi worker; one submission, attempt, user message and tool grant                                                                         |
| Lost responses               | Socket proxies dropped submission and decision responses; fresh outboxes recovered the original committed results without duplicating work                                                    |
| Concurrent approvals         | Reverse decisions, two sessions, expiry, changed arguments/targets, worker replacement and unsolicited real Pi UI replies passed                                                              |
| Effect failure boundaries    | Pre-intent rollback, prepared intent, dispatch before external acceptance, acceptance before receipt commit, receipt before tool return, worker/service death and cancellation passed         |
| Uncertainty                  | Negative/unavailable lookup, mismatched receipts and opaque connectors remained unknown; no recovery path resent an effect. Explicit operator resolution retained its provenance              |
| Version race                 | An intentionally stale preflight still met an external conditional-write rejection; no effect was accepted                                                                                    |
| Persistence/protocol         | Schema-v1/v2 upgrades retained cached replies and outcomes. Journal failure denied dispatch. Atomic transcript/completion, Unicode input, command FIFO ordering and large-event replay passed |
| Offline demos                | Session demo and the end-to-end managed CLI demo passed against the final compiled bundle; the latter approved B, denied A and observed one accepted effect                                   |
| Pi bundle verification       | Exact npm artifact, lockfile integrity and installed Pi package-content digests matched                                                                                                       |

The tested worker bundle digest is:

```text
9d4dc9a20dc04fa0d4e66380f8a815e64560dbd4739d19178e82efe3759f032f
```

The package pin is `@earendil-works/pi-coding-agent@1.3.0`. Its published RPC command reference matched the researched source commit byte for byte. No `gitHead` was supplied by the registry, so this evidence identifies the tested npm artifact without asserting full source-build equivalence.

Local reports are retained under `.state/evidence/` and excluded from Git: `m4-m5-full-suite.json` (the final 118-case run), `m4-m5-pi-bundle.json`, `m4-m5-demo.log`, and `m4-m5-session-demo.log`. Earlier M0–M3 reports remain historical evidence, separate from this result.

One earlier full run exceeded the S1 service-crash test deadline. Its report is retained as `m4-m5-timeout.json`; the exact cause was not established. The same S1 suite subsequently passed 35 cases across five runs, and the final combined suite passed. OS process-identity inspection now has a two-second subprocess deadline, and late bridge failures during intentional shutdown preserve stopped-worker state. These observations do not establish immunity to host scheduling or storage stalls.

## Reproduce

```sh
npm ci --ignore-scripts
npm run format:check
npm run check
mkdir -p .state/evidence
SALAAM_MANAGED_REPETITIONS=3 npm test -- --reporter=json \
  --outputFile=.state/evidence/m4-m5-full-suite.json
npm run verify:pi
npm run demo:session
npm run demo:managed
```

Local socket/process tests ran with host permissions because the execution sandbox denied socket creation. They used real pinned Pi with an offline provider and an independent durable local effect fixture. No live model account, fleet deployment or third-party production service was exercised. M3 was committed as `3ef8447` and pushed to `origin/m3-session-attach`; GitHub metadata confirmed that the Salaam repository remained private.

S1, S2, S3 and S6 have local offline/fixture evidence; S4–S5 remain pending. Interrupted prompts and unknown effects are never automatically replayed. Cancellation does not undo already accepted external work. Operator resolutions are attestations, distinct from verified receipts. Exactly-once behavior for arbitrary services/shell commands, real provider routing, child work, durable task facts, production process isolation and host-loss recovery remain outside this evidence. Linux CI is configured but has not been observed running in this local verification.
