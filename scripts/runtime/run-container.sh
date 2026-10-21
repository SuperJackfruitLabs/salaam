#!/bin/sh
# Explicit shell entrypoint; the digest-pinned Debian fixture supplies glibc.
set -eu
[ "$#" = 5 ]
root=$1
archive=$2
archive_sha=$3
version=$4
image=$5
exec docker run --rm --pull=never --network none --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --pids-limit 128 \
  --mount "type=bind,src=$archive,dst=/input/private-runtime.tar.gz,readonly" \
  --mount "type=bind,src=$root/install.sh,dst=/input/install.sh,readonly" \
  --mount "type=bind,src=$root/scripts/runtime/clean-host.sh,dst=/input/clean-host.sh,readonly" \
  --mount "type=bind,src=$root/scripts/runtime/clean-host-probe.mjs,dst=/input/probe.mjs,readonly" \
  --entrypoint /bin/sh "$image" /input/clean-host.sh "$archive_sha" "$version"
