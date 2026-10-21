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
archive_sha=$(sha256sum "$work/private-runtime.tar.gz")
archive_sha=${archive_sha%% *}
# This image is already provisioned by execution-boundary. Refuse implicit pulls.
image=docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
docker run --rm --pull=never --network none --cap-drop ALL \
  --security-opt no-new-privileges --memory 2g --pids-limit 128 \
  --mount "type=bind,src=$work/private-runtime.tar.gz,dst=/input/private-runtime.tar.gz,readonly" \
  --mount "type=bind,src=$root/install.sh,dst=/input/install.sh,readonly" \
  --mount "type=bind,src=$root/scripts/runtime/clean-host.sh,dst=/input/clean-host.sh,readonly" \
  --mount "type=bind,src=$root/scripts/runtime/clean-host-probe.mjs,dst=/input/probe.mjs,readonly" \
  "$image" /bin/bash /input/clean-host.sh "$archive_sha" "${pins[1]}" > "$output/container.json"
node --input-type=module - "$output" "$image" <<'NODE'
import fs from 'node:fs';
const [out,image]=process.argv.slice(2);
const probe=JSON.parse(fs.readFileSync(`${out}/container.json`));
const build=JSON.parse(fs.readFileSync(`${out}/build.json`));
const release=JSON.parse(fs.readFileSync('.state/release/release.json'));
if(probe.success!==true || probe.manifest_sha256!==build.manifest_sha256) throw Error('Private runtime proof identity mismatch');
fs.writeFileSync(`${out}/private-runtime.json`,JSON.stringify({
  schema:1,kind:'salaam-private-runtime-container-proof',
  workflow_run_id:process.env.GITHUB_RUN_ID ?? null,
  workflow_run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
  commit:release.commit, package_sha256:release.package_sha256,
  archive_sha256:build.sha256, image, ...probe
},null,2)+'\n');
NODE
