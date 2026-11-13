#!/bin/sh
# Release hook (publish): publishes the released tarball to npm, after the release.
# The shared release workflow runs this file, at a fixed path, when it exists.
set -eu
sh deploy/release/npm-publish.sh
