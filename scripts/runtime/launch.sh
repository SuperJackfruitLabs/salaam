#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd -P)
exec /usr/bin/env -i HOME="$HOME" LANG=C.UTF-8 TMPDIR="${TMPDIR:-/tmp}" PATH="$root/node/bin:/usr/bin:/bin" "$root/node/bin/node" "$root/app/node_modules/@superjackfruitlabs/salaam/bin/salaam.mjs" "$@"
