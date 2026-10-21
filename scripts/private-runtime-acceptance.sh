#!/usr/bin/env bash
# CI-only Linux fixture. No image pulls, credentials, checkout copy, or deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
output="$root/.state/evidence/m22"
work=$(mktemp -d "${TMPDIR:-/tmp}/sal-private-proof.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$output"
mapfile -t pins < <(node --input-type=module -e '
import fs from "node:fs";
const p=JSON.parse(fs.readFileSync("scripts/runtime-pin.json"));
const r=JSON.parse(fs.readFileSync(".state/release/release.json"));
console.log([p.node.url,r.version,r.package_sha256].join("\n"));')
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "${pins[0]}" > "$work/node.tar.xz"
node scripts/private-runtime-pack.mjs "$work/node.tar.xz" \
  ".state/release/salaam-cli-${pins[1]}.tgz" "${pins[2]}" "$work/private-runtime.tar.gz" > "$output/build.json"
node scripts/private-runtime-pack.mjs "$work/node.tar.xz" \
  ".state/release/salaam-cli-${pins[1]}.tgz" "${pins[2]}" "$work/rebuilt-runtime.tar.gz" > "$output/rebuild.json"
# Each builder invocation creates and cleans independent staging/home/cache.
# Compare actual archive bytes and manifest identities before testing either one.
node scripts/runtime/reproducibility.mjs "$output/build.json" "$output/rebuild.json" \
  "$work/private-runtime.tar.gz" "$work/rebuilt-runtime.tar.gz" > "$output/reproducibility.json"
rm -f "$work/rebuilt-runtime.tar.gz" "$work/node.tar.xz"
archive_sha=$(sha256sum "$work/private-runtime.tar.gz")
archive_sha=${archive_sha%% *}
# Reuse the already-pinned Debian/glibc whole-harness image. The Alpine coding
# image has a different libc ABI and is unsuitable for the private Node archive.
image=$(node --input-type=module -e 'import {privateRuntimeImage} from "./scripts/runtime/receipt.mjs"; console.log(privateRuntimeImage)')
sh scripts/runtime/run-container.sh "$root" "$work/private-runtime.tar.gz" \
  "$archive_sha" "${pins[1]}" "$image" > "$output/container.json"
node --input-type=module - "$output" "$image" <<'NODE'
import fs from 'node:fs';
const [out,image]=process.argv.slice(2);
const probe=JSON.parse(fs.readFileSync(`${out}/container.json`));
const build=JSON.parse(fs.readFileSync(`${out}/build.json`));
const reproducibility=JSON.parse(fs.readFileSync(`${out}/reproducibility.json`));
const release=JSON.parse(fs.readFileSync('.state/release/release.json'));
if(probe.success!==true || probe.manifest_sha256!==build.manifest_sha256) throw Error('Private runtime proof identity mismatch');
fs.writeFileSync(`${out}/private-runtime.json`,JSON.stringify({
  schema:1,kind:'salaam-private-runtime-container-proof',
  workflow_run_id:process.env.GITHUB_RUN_ID ?? null,
  workflow_run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  commit:release.commit, package_sha256:release.package_sha256,
  ...reproducibility, archive_sha256:build.sha256, image, ...probe
},null,2)+'\n');
NODE
