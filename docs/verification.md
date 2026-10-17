# Local M0 through M2 verification

Verified on **2026-10-17**, on macOS arm64 with Node **26.7.0** and npm **11.19.0**.

| Check                    | Observed result                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean install            | `npm ci --offline --ignore-scripts` succeeded using the populated development cache                                                                 |
| Type check               | `npm run check` passed                                                                                                                              |
| Full suite               | **36 tests passed**, with no failures                                                                                                               |
| Repeated readiness proof | **280 cases passed across 20 runs**, with no failures                                                                                               |
| Real Pi integration      | Successful gated direct/nested turns, persistent transcript resumption, extension/context/policy failures, and abrupt service-death recovery passed |
| Detached CLI             | Start, create, readiness inspection, probe and stop succeeded; the owned worker was `exited` after shutdown                                         |
| Pi bundle verification   | Exact npm artifact, lockfile integrity and installed Pi package-content digests matched                                                             |

The tested worker bundle digest is:

```text
0369e6eafb20a26957f0dac2bb3f2639ff35163de7bd776fe1cfee12e96f6e7e
```

The package pin is `@earendil-works/pi-coding-agent@1.3.0`. Its published RPC command reference matched the researched source commit byte for byte. No `gitHead` was supplied by the registry, so this evidence identifies the tested npm artifact without asserting full source-build equivalence.

Local machine-readable reports are retained under `.state/evidence/` and excluded from Git. The full suite report is `full-suite.json`; the repeated readiness report is `readiness-repeated.json`; the detached CLI report is `cli-demo.json`; package verification is `pi-bundle.json`.

## Reproduce

```sh
npm ci --ignore-scripts
npm run format:check
npm run check
mkdir -p .state/evidence
npm test -- --reporter=json --outputFile=.state/evidence/full-suite.json
SALAAM_PROOF_REPETITIONS=20 npm run test:proofs -- --reporter=json --outputFile=.state/evidence/readiness-repeated.json
npm run verify:pi
npm run demo:session
```

Local socket/process tests ran with host permissions because the execution sandbox denied socket creation. They used an offline provider and disposable workspaces. No live model account, fleet deployment or external service was exercised.

S1–S5 remain pending. Linux CI is configured but has not been observed running in this local verification. The results establish the local prototype's tested behavior; production process isolation and host-loss recovery require further evidence.
