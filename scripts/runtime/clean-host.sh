#!/bin/bash
# Runs ONLY inside a disposable container. Never mount a host runtime path here.
set -euo pipefail
test -f /.dockerenv
test "$#" = 2
archive_sha=$1
version=$2
export HOME=/proof/home PATH=/usr/local/bin:/usr/bin:/bin
mkdir -p "$HOME"
# Remove only this disposable image's global runtime, never host-mounted files.
rm -f /usr/local/bin/node /usr/local/bin/nodejs /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
rm -rf /usr/local/lib/node_modules
for command in node nodejs npm npx; do
  if command -v "$command" >/dev/null 2>&1; then echo "Unexpected system $command" >&2; exit 1; fi
done
test ! -S /var/run/docker.sock
# Network is disabled by the outer Docker invocation, before install or startup.
sh /input/install.sh --private-runtime /input/private-runtime.tar.gz \
  --sha256 "$archive_sha" --prefix /proof/runtime >&2
/proof/runtime/bin/sal --version | grep -Fx "salaam $version" >&2
exec /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin \
  /proof/runtime/current/node/bin/node /input/probe.mjs /proof/runtime "$version"
