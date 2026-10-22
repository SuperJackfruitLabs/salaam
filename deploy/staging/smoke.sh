#!/usr/bin/env bash
# Staging smoke, as `salaam` on workbench (deploy.sh runs it after each install). Makes no model
# request: the service answers health, and a managed session reaches `ready`. While the service
# route is offline (provider salaam-proof), that session also runs one turn to completion.
# A daemon bound to AgentPod pins (the default since the pins file exists) accepts sessions only
# through an AgentPod admission, so for it the smoke checks the bound pins instead and that
# unbound session creation is refused; it does not weaken or bypass admission.
set -euo pipefail
state=$HOME/.local/state/salaam
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1])??"")})' "$1"; }
for _ in $(seq 60); do salaam service status --state "$state" >/dev/null 2>&1 && break; sleep 0.5; done
status=$(salaam service status --state "$state")
[ "$(json v.service <<<"$status")" = healthy ] || { echo "smoke: service not healthy"; exit 1; }
systemctl --user is-active --quiet salaam.service
route=$(json v.provider_route.provider <<<"$status")
pins=$(json v.agentpod_config <<<"$status")
if [ -n "$pins" ]; then
  [ "$pins" = "${XDG_CONFIG_HOME:-$HOME/.config}/salaam/agentpod-pins.json" ] || { echo "smoke: bound to unexpected pins $pins"; exit 1; }
  # Same digest the daemon reports: sha256 of the canonical (sorted-key) JSON of the pins file.
  want=$(node -e 'const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v);console.log(require("crypto").createHash("sha256").update(c(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")))).digest("hex"))' "$pins")
  [ "$(json v.agentpod_pins_digest <<<"$status")" = "$want" ] || { echo "smoke: daemon pins digest differs from $pins"; exit 1; }
  if out=$(salaam session create --cwd "$HOME/work" --state "$state" 2>&1); then
    echo "smoke: bound daemon created an unadmitted session"; exit 1
  fi
  grep -q 'requires a trusted AgentPod admission' <<<"$out" || { echo "smoke: unexpected refusal: $out"; exit 1; }
  echo "   service healthy (route $route); bound to AgentPod pins ${want:0:12}; unadmitted session refused"
  exit 0
fi
cwd=$(mktemp -d "$HOME/work/smoke.XXXXXX")
id=$(salaam session create --cwd "$cwd" --state "$state" | json v.id)
inspect() { salaam session inspect "$id" --state "$state" | json "$1"; }
for _ in $(seq 60); do [ "$(inspect v.state)" = ready ] && break; sleep 0.5; done
[ "$(inspect v.state)" = ready ] || { echo "smoke: session $id never ready"; exit 1; }
if [ "$route" = salaam-proof ]; then
  salaam session submit "$id" --text 'staging smoke' --state "$state" >/dev/null
  for _ in $(seq 60); do r=$(inspect 'v.attempts?.[0]?.state==="completed" ? v.attempts[0].result : ""'); [ -n "$r" ] && break; sleep 0.5; done
  [ "$r" = 'Offline reply: staging smoke' ] || { echo "smoke: no offline reply (got '${r:-}')"; exit 1; }
  echo "   service healthy; session $id answered offline"
else
  echo "   service healthy (route $route); session $id ready, no model request made"
fi
