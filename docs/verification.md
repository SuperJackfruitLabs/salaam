# Local M0 through M3 verification

Verified on **2026-10-17**, on macOS arm64 with Node **26.7.0** and npm **11.19.0**.

| Check                              | Observed result                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime/dependencies               | Exact Node, npm and Pi pins retained; dependency lockfile unchanged from M0–M2                                                                                               |
| Formatting/type check              | `npm run format:check` and `npm run check` passed                                                                                                                            |
| Full suite                         | **50 tests passed**, with no failures, including the 14 S6 readiness cases                                                                                                   |
| Repeated attachment/recovery proof | **35 cases passed across five runs** of the seven S1/M3 scenarios, with no failures                                                                                          |
| Terminal death                     | A killed CLI and reconnected observer shared one real Pi worker; one submission, attempt, user message and tool grant                                                        |
| Lost acceptance response           | A socket proxy dropped the accepted response; a fresh outbox/controller recovered the original acceptance without another attempt                                            |
| Service failure boundaries         | Mid-prompt death, completion-before-commit death, graceful shutdown and explicit continuation passed; a pre-pipe committed handoff was also interrupted rather than replayed |
| Persistence/protocol               | Schema-v1 accepted-work migration, controller expiry/takeover, atomic transcript/completion publication, Unicode input and large-event SSE replay passed                     |
| Offline demo                       | Real Pi readiness, a gated diagnostic, durable prompt dispatch, artifact verification and cleanup succeeded                                                                  |
| Pi bundle verification             | Exact npm artifact, lockfile integrity and installed Pi package-content digests matched                                                                                      |

The tested worker bundle digest is:

```text
f9f66e35a437dd25d0a98d4f30367a9b25bce113a698e8cbad76ba2e46db027b
```

The package pin is `@earendil-works/pi-coding-agent@1.3.0`. Its published RPC command reference matched the researched source commit byte for byte. No `gitHead` was supplied by the registry, so this evidence identifies the tested npm artifact without asserting full source-build equivalence.

Local reports are retained under `.state/evidence/` and excluded from Git: `m3-full-suite.json`, `m3-attach-repeated.json`, `m3-pi-bundle.json`, and `m3-demo.log`. The earlier M0–M2 verification also recorded a clean offline install and 280 readiness cases across 20 runs; those historical reports remain separate from this M3 result.

## Reproduce

```sh
npm ci --ignore-scripts
npm run format:check
npm run check
mkdir -p .state/evidence
npm test -- --reporter=json --outputFile=.state/evidence/m3-full-suite.json
SALAAM_ATTACH_REPETITIONS=5 npm test -- test/proofs/session-attach.test.ts \
  --reporter=json --outputFile=.state/evidence/m3-attach-repeated.json
npm run verify:pi
npm run demo:session
```

Local socket/process tests ran with host permissions because the execution sandbox denied socket creation. They used an offline provider and disposable workspaces. No live model account, fleet deployment or external service was exercised.

S1 and S6 have local offline evidence; S2–S5 remain pending. An interrupted prompt is not automatically resent, including when Pi's transcript already contains an answer. Explicit continuation requires new instruction text and preserves the old interruption record. This does not establish exactly-once external effects. Real provider routing, cancellation controls, production process isolation and host-loss recovery require further work. Linux CI is configured but has not been observed running in this local verification.
