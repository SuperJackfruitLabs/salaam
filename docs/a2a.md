# Peer specialists with A2A

Salaam can delegate bounded analysis to an authenticated A2A peer and expose an
operator-prepared native analysis assignment to a peer. Both directions use the
existing task and specialist records. Remote output is unverified analysis; it
cannot approve operations, integrate a proposal or complete a checked local task.

The supported wire subset is A2A 1.0 JSON-RPC: `SendMessage`, `GetTask`,
`CancelTask` where configured, and negotiated `SubscribeToTask`. There is no
automatic downgrade to older method names. Inline text and structured data are
supported; remote file URLs are never fetched.

## Configure an outbound peer

Use a separate credential for each peer. This command creates a new owner-only
JSON file and prints its path and digest without printing its token:

```sh
sal a2a credential reviewer --file "$HOME/.config/salaam/peers/reviewer.json"
```

Configure the corresponding token on the intended peer through its own secret
settings. Provider API keys stay in Salaam's provider credential store.

Discover a card using its explicit endpoint, card URL and destination IP:

```sh
umask 077
sal a2a discover --peer reviewer \
  --endpoint https://reviewer.example/a2a \
  --card-url https://reviewer.example/.well-known/agent-card.json \
  --credential-file "$HOME/.config/salaam/peers/reviewer.json" \
  --addresses 192.0.2.10 > reviewer-card.json
```

Replace the example addresses and URLs with the peer's actual configuration.
Discovery does not follow card-advertised URLs or grant task authority. Review the
card, then pin its exact content, selected skill, tenant and file disclosure:

```sh
sal a2a pin --peer reviewer \
  --endpoint https://reviewer.example/a2a \
  --card-url https://reviewer.example/.well-known/agent-card.json \
  --card-file reviewer-card.json \
  --credential-file "$HOME/.config/salaam/peers/reviewer.json" \
  --addresses 192.0.2.10 --skill review --files src/app.ts > reviewer-pin.json
```

Add `--tenant TENANT` if the selected interface declares one. Use
`--supports-cancel` and `--supports-streaming` only for controls you have reviewed.
`--retention volatile|durable|unknown` records the operator's retention policy; it
does not establish remote durability. An explicit `--local` permits a loopback
HTTP rehearsal. Other endpoints require HTTPS. Metadata/link-local destinations,
redirects and inherited proxies are excluded. Destination addresses are pinned;
DNS changes require renewed configuration.

Place the pin inside an owner-only registry:

```json
{ "schema": 1, "peers": ["REPLACE_WITH_THE_REVIEWED_PIN_OBJECT"] }
```

Start the [coding-enabled service](coding.md) with `--a2a-config REGISTRY.json`,
alongside its existing coding root and executor options. Inspect available peers
with `sal a2a peers`.

The peer receives the assigned instruction, admitted profile context and only the
repository files listed in its pin. File bytes come from the immutable admitted
snapshot. Parent conversation history, other repository files and local
credentials are not copied automatically. The saved checkpoint records each
disclosed file's path, digest and byte count.

## Assign peer analysis

Use an admitted analysis profile, such as `salaam/reviewer`, and a task with an
explicit `limits.invocations` allowance and `limits.token_units: null`:

```sh
sal team assign TASK_ID --step STEP_ID --profile salaam/reviewer \
  --runtime reviewer --invocations 1 --revision N
sal team run TASK_ID --assignment ASSIGNMENT_ID --generation 0 --revision N
sal a2a inspect CHILD_ID
```

Native `requests` still count native model requests. Peer internal model usage,
token spending and process execution remain unobserved. A peer consumes one
opaque invocation before dispatch, including failures and uncertain outcomes.
It receives no local file, command or controller authority.

## Admit inbound work

Prepare a dedicated [single-step task and native analysis assignment](agents.md).
Review the profile, workspace, plan and request allowance before admitting the
peer. Builder/tester profiles and external-runtime assignments cannot be exposed
through this inbound path.

Create a distinct peer credential, then generate the one-use grant:

```sh
sal a2a credential partner --file "$HOME/.config/salaam/peers/partner.json"
umask 077
sal a2a grant --assignment ASSIGNMENT_ID --peer partner \
  --credential-file "$HOME/.config/salaam/peers/partner.json" \
  --tenant project-one --skill review > partner-grant.json
```

Place that object in an owner-only listener configuration:

```json
{
  "schema": 1,
  "host": "127.0.0.1",
  "port": 4388,
  "grants": ["REPLACE_WITH_THE_REVIEWED_GRANT_OBJECT"]
}
```

Start the service with `--a2a-listen-config LISTENER.json`. The authenticated card
is at `/.well-known/agent-card.json` and the JSON-RPC endpoint at `/a2a`. The
listener binds only to loopback. Use an explicitly configured SSH tunnel or TLS
proxy for remote access. Health output reports the actual listener address.

A grant authorizes one fresh message for its prepared assignment. Duplicate
message IDs with identical input return the same task; changed input conflicts.
Another message, follow-up or interrupted continuation requires operator renewal.
Credentials determine peer identity. A message's `ROLE_USER`, title, slash command
or profile text never becomes human authority. Requests are bounded, with at most
60 authenticated HTTP requests per peer per minute and eight concurrent streams.

## Hermes and OpenClaw

Hermes 0.22.2's A2A plugin supports the tested text/data, polling and terminal
subscription paths. Salaam retains content-bound artifact receipts because that
version regenerates artifact IDs when rendering results. Stream chunks remain
tentative; a saved task snapshot supplies the imported result.

OpenClaw 2026.10.5 supports the tested polling specialist path. Its cancellation
method returns unsupported and its in-memory tasks can disappear on restart.
An uncertain remote stop keeps the worker slot occupied.

That OpenClaw version's outbound client omits the version header. To receive it,
explicitly generate the grant with `--peer-client openclaw-2026.10.5` and configure
its destination as `/a2a/openclaw-2026.10.5`. This named adapter supplies the pinned
wire version and the authenticated grant's tenant when absent, supports only
`SendMessage`/`GetTask`, and records its identity in acceptance receipts. Wrong
versions or supplied tenants are rejected. The standard `/a2a` endpoint always
requires `A2A-Version: 1.0`.

These are named plugin transport observations. They do not establish every tool,
model provider or agent feature of either product.

## Disconnect and recovery

Dispatch intent and a stable message ID are committed before sending work. A lost
acceptance response remains unknown; Salaam never sends another prompt to guess
what happened. Known peer/task/context IDs can be inspected without resubmitting.
An expired task is not a reason to create a replacement automatically.

The CLI and TUI distinguish a remote terminal receipt from local process cleanup.
Cancellation acknowledgement, stream closure and a local deadline do not prove
remote work stopped. Input/auth-required states require explicit operator
resolution; credentials and follow-up messages are not relayed automatically.

Use `sal a2a reconcile CHILD_ID --run-id EXACT_RUN_ID` to reconcile the existing
owned invocation. This can inspect/cancel that known remote task, but cannot
resolve a lost task identity by inventing another send. Review analysis and run
the configured local acceptance checks before completing the parent task.
