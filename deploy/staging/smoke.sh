#!/usr/bin/env bash
# Staging smoke, as `salaam` on workbench (deploy.sh runs it after each install). Makes no model
# request: the service answers health, and a managed session reaches `ready`. While the service
# route is offline (provider salaam-proof), that session also runs one turn to completion.
set -euo pipefail
state=$HOME/.local/state/salaam
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(eval(process.argv[1])??"")})' "$1"; }
for _ in $(seq 60); do salaam service status --state "$state" >/dev/null 2>&1 && break; sleep 0.5; done
status=$(salaam service status --state "$state")
[ "$(json v.service <<<"$status")" = healthy ] || { echo "smoke: service not healthy"; exit 1; }
systemctl --user is-active --quiet salaam.service
route=$(json v.provider_route.provider <<<"$status")
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
