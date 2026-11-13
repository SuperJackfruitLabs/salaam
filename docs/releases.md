# Release process

Salaam uses Semantic Versioning and version tags `vX.Y.Z` or `vX.Y.Z-prerelease`.
Before 1.0, minor releases may break CLI/service contracts; patches preserve
documented behavior. State upgrades are forward-only; see [safe upgrades](install.md).

## Prepare a version

Start from a clean checkout and choose the next version. For example, after
0.0.2:

```sh
npm run release:version -- 0.0.3
```

This updates package/lock versions and moves Unreleased notes into a dated
changelog section. Review and finish the notes, commit, open a PR and merge after
CI passes. It does not commit, tag, push or publish automatically.

The checker rejects malformed versions, package/lock mismatch, a missing changelog
entry and unpublished/private package configuration. Tag validation also proves
the checked commit belongs to `origin/main` and matches the exact version tag.

## Tag and publish

From the reviewed main commit:

```sh
git switch main
git pull --ff-only
npm run release:check
git tag -a v0.0.3 -m 'Salaam 0.0.3'
git push origin v0.0.3
```

`.github/workflows/release.yml` is the suite's shared release workflow; Salaam's
settings are in `.github/release-config.json`, and its commands in the hooks
`.github/release/check.sh` and `.github/release/publish.sh`. Its gate requires the tag to be on
`main` and **full main CI for the exact tagged commit** to have succeeded. Then
`scripts/release-check.mjs` validates the version, lockfile and changelog, and
`scripts/release-source.mjs` checks that run's evidence: the current attempt's
certificate (complete macOS/Linux acceptance evidence, all 20 recovery rounds on
each platform, package installation receipts for the same tarball, matching
source/runtime/pin identities), the certified package's bytes, and its GitHub
build attestation, signed by this repository's main CI workflow for that commit.

The release ships those exact verified bytes without rebuilding. PR/quick runs,
another commit, a fork, a failed run, a stale attempt, incomplete or expired
evidence, or changed bytes stop the release before anything is drafted; re-run all
jobs of main CI for the commit, then the release. A tag on a landing- or docs-only
commit has no package, so never tag one.

The workflow drafts the GitHub Release with the CLI tarball, `release.json` and
`install.sh` from that CI run, a fresh `SHA256SUMS` and a build attestation for
each file, writes the notes (a summary, this version's changelog section and the
grouped commits), then publishes it as `Salaam vX.Y.Z`. Release metadata identifies
the Git commit, package/runtime versions and Pi pin. After the release is published,
`deploy/release/npm-publish.sh` publishes the same tarball to npm.

Prerelease tags create prereleases and use npm's `next` dist-tag. Stable releases
use `latest`. A published release is never rebuilt; npm treats an already-published
version as success only if its bytes match. If a published release differs, stop
and investigate; publish a new version rather than clobbering it.

To re-run a failed release, dispatch the workflow with the tag (it runs on that
tag's commit and finishes the draft), or rewrite only the notes' summary:

```sh
gh workflow run release.yml -R SuperJackfruitLabs/salaam -f tag=v0.0.3
gh workflow run release.yml -R SuperJackfruitLabs/salaam -f tag=v0.0.3 -f summary_only=true
```

## npm trusted publishing: one-time account setup

The GitHub Release and its installer do not require an npm token. The npm publish
runs in the `npm` environment through OIDC.

An owner of the npm `@superjackfruitlabs` scope must bootstrap `@superjackfruitlabs/salaam` if it does not exist.
Use the existing `superjackfruitlabs` npm organization; no separate `sjl` organization
is needed. The logged-in account must have publishing access to that organization.
Use the verified tarball from the initial GitHub Release, a logged-in npm account
and its interactive 2FA flow:

```sh
npm login
npm whoami
npm publish ./salaam-cli-0.0.1.tgz --access public --ignore-scripts
```

In the package's npm settings, add a GitHub Actions trusted publisher:

| Setting           | Value                                |
| ----------------- | ------------------------------------ |
| Organization      | `SuperJackfruitLabs`                 |
| Repository        | `salaam`                             |
| Workflow filename | `release.yml`                        |
| Environment       | `npm`                                |
| Allowed actions   | Direct publishing with `npm publish` |

Create/configure the GitHub `npm` environment, preferably with required reviewers.
No long-lived npm secret is needed. The job
uses OIDC and provenance, publishes the exact verified tarball, and treats an
already-published version as success only if its SHA-512 integrity matches.
The initial interactive bootstrap may not have CI provenance; subsequent OIDC
publications do. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Local checks

```sh
npm ci --ignore-scripts
npm run format:check
npm run check
npm test
npm run release:pack
npm run test:package
```

`release:pack` stages a production-only install from the lockfile, copies the exact
lock bytes to `npm-shrinkwrap.json`, bundles dependencies and emits assets under
ignored `.state/release/`. It does not mutate the source lock, publish anything or
touch user services. Direct `npm pack` from the checkout fails with instructions
to use this builder; published packages contain no lifecycle scripts.

## CI profiles

PRs run every test on macOS and Linux plus one additional round of each recovery
portfolio. Main and daily scheduled runs use full acceptance:
the complete suite, three operator/task/job rounds, and 20 S1–S6 rounds per
platform. Four isolated five-round jobs run the S1–S6 stress rounds in parallel.
The evidence gate checks all test files, reports, logs, platforms and round IDs
before declaring full acceptance. A quick run never receives that claim.

See [CI execution and artifact promotion](contributor/ci.md) for commands,
recovery of failed runs, and evidence validation.
