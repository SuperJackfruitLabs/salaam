# Release process

Salaam uses Semantic Versioning and version tags `vX.Y.Z` or `vX.Y.Z-prerelease`.
Before 1.0, minor releases may break CLI/service contracts; patches preserve
documented behavior. State upgrades are forward-only; see [safe upgrades](install.md).

## Prepare a version

For the initial release, `package.json`, its lockfile and `CHANGELOG.md` already
record 0.1.0. Do not bump it again just to publish it. For a subsequent version,
start from a clean checkout:

```sh
npm run release:version -- 0.2.0
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
git tag -a v0.1.0 -m 'Salaam 0.1.0'
git push origin v0.1.0
```

`.github/workflows/release.yml` validates the tag and reruns the reusable CI
workflow against that exact revision: service acceptance on macOS/Linux, actual
Linux Docker execution proofs, public site builds and installable package checks.
The pipeline builds **one** CLI tarball and tests those exact bytes on both platforms.

Only after every gate passes, a publisher downloads the checked artifact, verifies
checksums, creates a build attestation, uploads all assets to a draft GitHub Release,
then publishes it. Assets are the CLI tarball, `SHA256SUMS`, `release.json` and
`install.sh`. Release metadata identifies the Git commit, package/runtime versions
and Pi pin. The package installs from an empty npm cache with scripts disabled;
the test runs an offline Pi turn and restarts the daemon to verify the same attempt.

Prerelease tags create prereleases and use npm's `next` dist-tag. Stable releases
use `latest`. Existing published assets are compared by digest and never overwritten.
A rerun may finish a draft. If a published release differs, stop and investigate;
publish a new version rather than clobbering it.

For manual retries, select the **same tag** in GitHub's Run workflow ref selector
and supply it as the `tag` input. Selecting main with a historical tag fails rather
than testing and publishing different revisions.

## npm trusted publishing: one-time account setup

The GitHub Release and its installer do not require an npm token. The npm job is
disabled until repository variable `NPM_PUBLISH_ENABLED` equals `true`.

An owner of the npm `@sjl` scope must bootstrap `@sjl/salaam` if it does not exist.
Use the verified tarball from the initial GitHub Release, a logged-in npm account
and its interactive 2FA flow:

```sh
npm publish ./salaam-cli-0.1.0.tgz --access public --ignore-scripts
```

In the package's npm settings, add a GitHub Actions trusted publisher:

| Setting           | Value                |
| ----------------- | -------------------- |
| Organization      | `SuperJackfruitLabs` |
| Repository        | `salaam`             |
| Workflow filename | `release.yml`        |
| Environment       | `npm`                |

Create/configure the GitHub `npm` environment, preferably with required reviewers,
then enable the repository variable. No long-lived npm secret is needed. The job
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
