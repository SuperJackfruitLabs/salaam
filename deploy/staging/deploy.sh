#!/usr/bin/env bash
# Deploy a commit of Salaam to the staging plane, as root on workbench: run by
# /usr/local/sbin/staging-deploy (`salaam <sha>`), which CI calls on every push to main.
#
# The host (user `salaam`, its workspace filesystem, Node 26.7.0 + npm 11.19.0 under
# ~salaam/.local/node, the systemd --user unit) is made by estate provision/304-salaam-host.sh.
# This script builds that commit's release package the way CI does (npm ci, release:pack), as
# `salaam` in a throwaway clone, installs the packed tarball into ~salaam/.local offline with
# scripts disabled, restarts salaam.service and runs deploy/staging/smoke.sh from the same commit.
#
# Launcher-profile stations (estate provision/306-salaam-launcher.sh) run a root-owned release
# pinned by their reviewed host manifest, so the user install above never reaches them. When
# any is bound, this also builds the commit as a root-owned release in /opt/salaam/releases,
# records it in /opt/salaam/pending-release and runs salaam-host-rollover, which re-plans each
# station's manifest and restarts its host only while no session is live (otherwise its timer
# retries at the next idle moment). A user salaam.service that 306 disabled stays stopped.
set -euo pipefail
sha=${1:-$(git -C /opt/suite-staging/salaam rev-parse origin/main)}
repo=/opt/suite-staging/salaam
H=/home/salaam
id salaam >/dev/null 2>&1 && [ -x "$H/.local/node/bin/node" ] || { echo "run estate provision/304-salaam-host.sh first"; exit 1; }
uid=$(id -u salaam)
as_salaam() { runuser -u salaam -- env -i HOME="$H" USER=salaam XDG_RUNTIME_DIR="/run/user/$uid" \
  PATH="$H/.local/bin:$H/.local/node/bin:/usr/bin:/bin" bash -c "$1"; }

git -C "$repo" fetch -q origin
git -C "$repo" checkout -q --detach "$sha"
sha=$(git -C "$repo" rev-parse HEAD)

echo "== build $sha"
build=$(as_salaam 'mktemp -d "$HOME/.cache/salaam-build.XXXXXX" 2>/dev/null || { mkdir -p "$HOME/.cache" && mktemp -d "$HOME/.cache/salaam-build.XXXXXX"; }')
trap 'rm -rf "$build"' EXIT
git clone -q --no-hardlinks "$repo" "$build/src"
git -C "$build/src" checkout -q --detach "$sha"
chown -R salaam:salaam "$build"
as_salaam "set -euo pipefail; cd '$build/src'
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm run -s build
npm run -s release:pack -- '$build/out' >/dev/null
ls '$build/out'/salaam-cli-*.tgz"

user_unit=$(as_salaam 'systemctl --user is-enabled salaam.service 2>/dev/null || true')
echo "== install (user salaam.service: ${user_unit:-absent})"
as_salaam "set -euo pipefail
systemctl --user stop salaam.service || true
npm install --global --prefix \$HOME/.local --ignore-scripts --offline --no-audit --no-fund '$build'/out/salaam-cli-*.tgz >/dev/null
echo '$sha' > \$HOME/.local/salaam-commit
if [ '$user_unit' = enabled ]; then systemctl --user start salaam.service; fi
echo \"   \$(salaam --version) at ${sha:0:12}\""

if [ "$user_unit" = enabled ]; then
  echo "== smoke"
  as_salaam "bash '$build/src/deploy/staging/smoke.sh'"
fi

OPT=/opt/salaam
if compgen -G "/etc/salaam/stations/*/bind.json" >/dev/null && [ -x "$OPT/node/bin/node" ]; then
  rel=$OPT/releases/$sha
  echo "== launcher release ${sha:0:12}"
  if [ ! -f "$rel/dist/src/cli.js" ]; then
    rm -rf "$rel.tmp" && mkdir -p "$rel.tmp"
    git -C "$repo" archive "$sha" | tar -x -C "$rel.tmp"
    (cd "$rel.tmp" && PATH="$OPT/node/bin:/usr/bin:/bin" npm ci --ignore-scripts --no-audit --no-fund >/dev/null &&
      PATH="$OPT/node/bin:/usr/bin:/bin" npm run -s build >/dev/null)
    chown -R root:root "$rel.tmp" && chmod -R go-w "$rel.tmp"
    mv "$rel.tmp" "$rel"
  fi
  echo "$rel" > "$OPT/pending-release.tmp" && mv "$OPT/pending-release.tmp" "$OPT/pending-release"
  if [ -x /usr/local/sbin/salaam-host-rollover ]; then /usr/local/sbin/salaam-host-rollover
  else echo "   no salaam-host-rollover yet (estate 306); release pending"; fi
fi
