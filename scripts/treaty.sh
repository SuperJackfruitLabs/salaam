#!/usr/bin/env bash
# Runs treaty's CLI at the release treaty.json pins: `./scripts/treaty.sh verify` checks the
# manifest and that every copy under vendor/treaty/ is byte-identical to that release;
# `./scripts/treaty.sh sync` rewrites the copies. To move to a newer release, change the pin in
# treaty.json, run sync, and fix whatever the tests then say.
set -euo pipefail
cd "$(dirname "$0")/.."
pin=$(node -p 'require("./treaty.json").treaty')
exec npx -y "@superjackfruitlabs/treaty-contracts@$pin" "$@"
