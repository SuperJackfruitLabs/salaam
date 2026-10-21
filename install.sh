#!/bin/sh
# Install a checksum-verified GitHub Release tarball. Never touches service state.
set -eu
version=latest
prefix=""
private_runtime=""
archive_sha=""
database=""
stopped=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) version="${2:?Supply a version}"; shift 2 ;;
    --prefix) prefix="${2:?Supply an npm prefix}"; shift 2 ;;
    --private-runtime) private_runtime="${2:?Supply a private runtime archive}"; shift 2 ;;
    --sha256) archive_sha="${2:?Supply the reviewed archive SHA256}"; shift 2 ;;
    --database) database="${2:?Supply a stopped state database}"; shift 2 ;;
    --stopped) stopped=--stopped; shift ;;
    --help|-h) echo 'Usage: sh install.sh [--version VERSION] [--prefix DIRECTORY] [--private-runtime ARCHIVE --sha256 HASH [--database DB --stopped]]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -n "$private_runtime" ]; then
  [ -n "$prefix" ] || { echo '--private-runtime requires --prefix' >&2; exit 2; }
  case "$archive_sha" in *[!a-f0-9]*|'') echo 'Supply a reviewed lowercase SHA256' >&2; exit 2 ;; esac
  [ "${#archive_sha}" = 64 ] || exit 2
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum -- "$private_runtime")
  else
    actual=$(shasum -a 256 -- "$private_runtime")
  fi
  [ "${actual%% *}" = "$archive_sha" ] || { echo 'Private runtime checksum mismatch' >&2; exit 1; }
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/sal-private-install.XXXXXXXX")
  trap 'rm -rf "$scratch"' EXIT HUP INT TERM
  # Hash verification precedes extraction and executing the bundled runtime.
  unset TAR_OPTIONS
  tar -tzf "$private_runtime" > "$scratch/entries"
  tar -tvzf "$private_runtime" > "$scratch/types"
  # Private packets contain only regular files/directories. Reject links,
  # devices, absolute/traversing paths and escaped/control filenames first.
  LC_ALL=C awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1}' "$scratch/types" || { echo 'Unsafe archive entry type' >&2; exit 1; }
  while IFS= read -r entry; do
    case "$entry" in /*|../*|*/../*|*/..|*\\*) echo 'Unsafe archive path' >&2; exit 1 ;; esac
  done < "$scratch/entries"
  rm -f "$scratch/entries" "$scratch/types"
  mkdir "$scratch/payload"
  tar -xzf "$private_runtime" -C "$scratch/payload" --no-same-owner
  /usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin "$scratch/payload/node/bin/node" "$scratch/payload/tools/activate.mjs" "$scratch/payload" "$prefix" "$database" "$stopped"
  echo "Add $prefix/bin to PATH to use salaam and sal."
  exit 0
fi
[ -z "$archive_sha$database$stopped" ] || { echo 'Private options require --private-runtime' >&2; exit 2; }
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
