#!/bin/sh
# Release hook (check): the gate's own check: version, changelog, CI certificate, package bytes and attestation.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
node scripts/release-check.mjs "$TAG" && node scripts/release-source.mjs
