#!/bin/sh
# Install a checksum-verified GitHub Release tarball. Never touches service state.
set -eu
version=latest
prefix=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version="${2:?Supply a version}"; shift 2 ;;
    --prefix) prefix="${2:?Supply an npm prefix}"; shift 2 ;;
    --help|-h) echo 'Usage: sh install.sh [--version X.Y.Z[-prerelease]] [--prefix DIRECTORY]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
command -v node >/dev/null 2>&1 || { echo 'Install Node 26.7.0 first.' >&2; exit 1; }
node -e 'if(process.versions.node!=="26.7.0") { console.error("Salaam requires Node 26.7.0"); process.exit(1) }'
command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
repo=https://github.com/SuperJackfruitLabs/salaam
scratch=$(mktemp -d "${TMPDIR:-/tmp}/sal-install.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
if [ "$version" = latest ]; then
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://api.github.com/repos/SuperJackfruitLabs/salaam/releases/latest > "$scratch/latest.json"
  version=$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1])).tag_name)' "$scratch/latest.json")
fi
version=${version#v}
node -e 'if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(process.argv[1])) process.exit(1)' "$version" || { echo 'Invalid release version.' >&2; exit 2; }
asset="salaam-cli-$version.tgz"
for file in "$asset" SHA256SUMS; do
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "$repo/releases/download/v$version/$file" > "$scratch/$file"
done
node --input-type=module - "$scratch" "$asset" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [directory, name] = process.argv.slice(2);
const records = readFileSync(join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
const matches = records.filter((line) => line.slice(66) === name);
const actual = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
if (matches.length !== 1 || !/^[a-f0-9]{64}  /.test(matches[0]) || matches[0].slice(0, 64) !== actual)
  throw new Error('Release checksum mismatch; nothing installed.');
NODE
if [ -n "$prefix" ]; then
  npm install --global --prefix "$prefix" --ignore-scripts --offline --no-audit --no-fund "$scratch/$asset"
  "$prefix/bin/salaam" --version
  echo "Add $prefix/bin to PATH to use salaam and sal."
else
  npm install --global --ignore-scripts --offline --no-audit --no-fund "$scratch/$asset"
  echo "Installed Salaam $version. Run salaam --version and sal --help."
fi
