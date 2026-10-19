# CI execution and artifact promotion

PRs run one workflow; feature-branch pushes do not duplicate it. New PR commits
cancel the obsolete run for that PR. Main pushes, the daily schedule and explicit
full runs retain complete acceptance. Release workflows are never cancelled by
new PR activity, and a tag does not trigger a second standalone CI workflow.

## Acceptance profiles

| Profile                | Full source suite   | Operator/task/job portfolios | Additional S1–S6 rounds | Full acceptance                 |
| ---------------------- | ------------------- | ---------------------------- | ----------------------- | ------------------------------- |
| `quick`                | Once per platform   | Once each                    | 1                       | No                              |
| `baseline`             | Once per platform   | Three each                   | 0                       | Only with all four proof shards |
| `proofs --shard I/4`   | In the baseline job | In the baseline job          | Five assigned rounds    | Only after aggregation          |
| `full` (local default) | Once                | Three each                   | 20 sequentially         | Yes                             |

Every PR still exercises the full source test suite, real Linux Docker boundaries,
named peer interoperability, public sites and the actual packaged CLI on both
platforms. Fixture/process isolation stays enabled. Full CI runs baseline and
stress jobs independently, then requires their combined evidence.

```sh
npm run test:acceptance -- --profile quick
npm run test:acceptance -- --profile baseline
npm run test:acceptance -- --profile proofs --shard 1/4
npm run test:acceptance
```

The evidence gate requires both platforms, a complete source suite, the exact
named recovery test files, clean matching commits/source digests, the same Pi and
control bundle, successful reports and unchanged log digests. Each platform must
cover rounds 1–20 exactly once across four shards. Package receipts must identify
the same tarball bytes and successful installation, aliases, readiness, offline
turn and restart deduplication.

Artifacts include their run attempt in their names. A partial rerun may reuse
passed slots from an earlier attempt of the same immutable run/commit; the newest
slot wins, and a newer failure cannot borrow an older success. The final
certificate identifies the current attempt, preventing a previous certificate
from authorizing a later failed run.

## Trusted release promotion

Full main CI attests the checked tarball only after the evidence gate succeeds.
The release resolver accepts only this repository's successful `push` run on
`main`, from `.github/workflows/ci.yml`, for the exact tagged SHA. It validates the
current attempt's certificate and immutable artifact identities, downloads the
certified package, verifies all checksums and source/runtime/pin bindings, and
verifies GitHub provenance with the CI signer, main ref and exact source digest.

Promotion copies the same four release files without rebuilding. The release
retains the original build provenance and records the source run and artifact IDs
in its workflow artifacts. GitHub and npm publishing consume that same promoted
artifact. Existing published assets and npm versions remain immutable.

A missing/expired certificate or package falls back to complete CI. A mismatched
certificate, artifact binding, checksum, source identity or signature fails the
release rather than weakening validation. API failures are errors, not evidence
of a passing run. Manual release retries must select the requested tag as their
workflow ref.

## Timing evidence

Before this split, successful acceptance manifests for release PR #19 recorded
22.6 minutes on Linux and 29.4 minutes on macOS. The 20 sequential S1–S6 rounds
consumed 13.0 and 15.9 minutes respectively; the full suites consumed 5.0 and 7.6.
These are observed old-pipeline timings. New wall-clock timings must be measured
from actual quick/full workflows; estimates are not a verification result.
