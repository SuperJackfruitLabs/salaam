# AgentPod execution boundary

## Scope

M19.1 binds an AgentPod execution to its organization, agent principal, station,
occupant generation, workspace and work-run epoch. It builds on durable session
revocation, separate from ACP detach. Source baselines: Salaam
`6447aff95edf43710559579ba8a7afeeecb3fee5` and AgentPod
`0905823322fbfa455dcd57b0d8e5dae9742a2217`; these changes are not released or deployed.

This is a trusted node admission, not a new identity issuer. Accounts remains the
source of principals and grants. Provider credentials do not confer dispatch
authority. The profile deliberately leaves coding tools, effect connectors,
external harnesses, A2A listeners and managed MCP disabled.

## Producer and consumers

AgentPod's `packages/contract/src/salaam-authority.ts` owns the strict v1 wire
schema. Its fixture is mirrored at `test/fixtures/agentpod-authority-v1.json`;
the end-to-end rehearsal compares both, and the Go node reads the canonical copy.
Unknown fields, missing identity, foreign organizations/nodes, stale occupant
versions and mismatched run epochs fail closed.

The Hub reads current station/tenant mappings and fresh Accounts agent/owner
grants before admission and renewal. Its database trigger increments the occupant
generation on principal, node, tenant, station-key or workspace changes, including
A → B → A. Database uniqueness keeps active or unconfirmed executions from
sharing a station or moved principal. A work-run epoch cannot be reused. For board
work, the bridge supplies a fresh owner heartbeat before admission, prompt dispatch
and lease renewal. A new claim for the same card must reconcile this Hub's prior
Salaam execution, including one on another station.

The authenticated node gateway checks its configured node and workspace and uses
the private operator socket. Only the node receives the admission credential; it
passes that credential privately to its ACP subprocess. The Hub receives a
sanitized receipt. ACP metadata alone cannot admit a principal, and an ordinary
ACP client cannot create or load work in this dedicated daemon.

Salaam stores the full binding, digest, admission/session mapping, occupant high
water mark, renewal sequence and expiry. Every execution grant checks the saved
binding, current generation, daemon boot, terminal fence and both wall-clock and
monotonic deadline. A replayed renewal cannot validate a new daemon boot. A new,
higher sequence with fresh Hub authority is required. An expired admission cannot
be revived. The 90-second local lease bounds authority after a partition; the
250-ms sweep requests cleanup, while grant checks reject expiry immediately.

## Stop and recovery

`POST /v1/agentpod/{admit,renew,revoke,status,attach}` is available only on the
owner-local operator socket of a configured daemon, never a worker bridge.
A stop persists `revocation_pending` in the Hub before sending explicit revocation.
Salaam commits its terminal fence, queued cancellation and descendant fences
before requesting native worker, command and external-process cleanup. A stop
that overtakes admission saves a tombstone, so a delayed admission cannot start.
Lost replies use the saved request ID; changed input under that ID fails.

`revoked` confirms authority withdrawal. `owned_execution_stopped` requires
observed terminal state of owned executions. Unknown dispatched operations remain
in `unresolved_operations`; an ACP close or cancellation acknowledgment cannot
clear them. Replacement remains blocked until stop and outcome reconciliation are
confirmed. There is no un-revoke API.

The Hub persists the original Salaam session and logical prompt UUID before
sending work. ACP EOF and node loss detach; they do not revoke. Interactive Hub
recovery loads that same session and inspects its actual attempts without
resubmitting prompts. A daemon restart invalidates readiness until a fresh
renewal. Board work after Hub restart is explicitly stopped and reported
interrupted; automatic board progression/resubmission is outside this boundary.

SQLite schema 18 adds terminal session revocations and schema 19 adds admissions
and occupant generations. Older binaries cannot reopen newer state. Back up state
before upgrading if a downgrade is needed. Pi session files are unchanged.
AgentPod migration `0101_salaam_execution_authority.sql` must precede the new Hub.
Roll out the opted-in daemon and node before opening its station. Old or missing
admission support denies execution rather than falling back to plain ACP.

## Local configuration

Use one dedicated daemon and canonical workspace per opted-in node profile. Keep
its state outside the workspace, accessible only to the trusted node/daemon OS
user. That OS user is the trust boundary; this does not sandbox a malicious node
administrator or prove station credential isolation on every provisioner.

Create an owner-only pins file (mode `0600`) with exactly these fields:

```json
{
  "version": 1,
  "organization_id": "org_00000000000000000001",
  "node_id": "node_example",
  "station_key": "salaam:c52ddf65534b7b46",
  "workspace": "/workspace"
}
```

The station key is `salaam:` followed by the first 16 hex characters of SHA-256 of
the canonical workspace path. It must match the node's discovery result. Start:

```sh
salaam service start --foreground --state /private/salaam-state --agentpod-config /private/pins.json
```

Configure the enrolled AgentPod node with `salaamBinary` (absolute executable path),
`salaamStateDir` and `salaamWorkspace`. Its existing `nodeId` must match the pins.
Discovery requires an actual healthy configured daemon, not socket existence.
Only inventory, health and ACP are advertised; no station file or terminal panel
is enabled. Adopt the discovered station, map its local tenant to the Accounts
organization, assign its agent principal and grant the owner dispatch authority
before opening it. Live provider setup remains a separate operator action.

## Executable evidence

Default proofs use pinned Pi and disposable offline fixtures, without provider
keys or live fleet effects:

- `test/proofs/session-revocation.test.ts`: active/queued work, duplicate stop,
  storage failure and daemon SIGKILL at fence commit before process abort.
- `test/proofs/agentpod-authority.test.ts`: bound ACP, same-session prompt dedup,
  boot-bound renewal, foreign/stale bindings, stop-before-admit, replacement
  fencing, corrupt state, expiry and disabled unbound/coding profiles.
- AgentPod `tests/integration/salaam-authority.test.ts`: fresh identity, occupant
  generation, database exclusion and unconfirmed replacement across stations.
- AgentPod `tests/integration/salaam-node-e2e.ts`: real authenticated local WebSocket
  gateway, Go node, Salaam and Pi, with Hub/node/daemon SIGKILL, occupant ABA,
  principal suspension, stale board epoch and real 90-second lease expiry.

Run the cross-product script from AgentPod's `apps/hub`, with built Salaam and
AgentPod dependencies and the disposable pgvector database on loopback port 5434:

```sh
DATABASE_URL=postgres://agentpod:agentpod-dev-password@127.0.0.1:5434/agentpod \
SALAAM_REPO=/absolute/path/to/salaam \
bun tests/integration/salaam-node-e2e.ts
```

The driver rejects other database destinations. It uses synthetic Accounts
principals and board ownership; a passing run proves this local integration,
not a live Accounts deployment, Superpipeline server or production substrate.
The next packets cover fuller session UX/reconciliation and station filesystem,
credential and managed-MCP isolation before broad first-class harness claims.
