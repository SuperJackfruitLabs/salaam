#!/bin/sh
# The release's npm publish (the .github/release/publish.sh hook, after the release): the
# exact tarball the GitHub release carries (RELEASE_DIST, checked against its SHA256SUMS by the
# workflow), through npm trusted publishing (OIDC, environment `npm`, with provenance). An
# identical version already on npm is success; different bytes under that version fail.
set -eu
: "${RELEASE_DIST:?the workflow downloads the release files into RELEASE_DIST}"
npm install --global npm@11.19.0 --ignore-scripts
node scripts/npm-release.mjs
