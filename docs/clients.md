# Terminal, SSH and ACP clients

All clients connect to one host-local Salaam service. They share session IDs, accepted attempts, approvals, child results and event history. Closing a client detaches it; explicit cancellation and service shutdown are separate commands.

## Terminal and SSH

Bare `sal`, `sal tui`, and `sal attach SESSION_ID` in a TTY open the Salaam TUI. See [controls, themes and recovery](tui.md). `--plain` keeps the line interface; redirected/piped attachment remains scriptable. No UI owns a Pi worker.

```sh
sal service start
sal session create --cwd /absolute/path/to/project
sal attach SESSION_ID
# Another terminal may observe or explicitly take control:
sal attach SESSION_ID --observe
sal attach SESSION_ID --takeover
```

Ctrl-C or Ctrl-D detaches the interactive attachment. A hard-killed controller's lease lasts up to 15 seconds; wait for expiry or use explicit takeover. Approvals can be answered by an observer from the same trusted OS account. CLI text is sanitized for terminal control characters; model text is not executable authorization.

For another computer, install the pinned checkout and CLI on the execution host, configure its provider there and start its service. SSH reaches that same host/account and state directory:

```sh
sal remote USER@HOST --remote-bin /absolute/path/to/sal \
  --session SESSION_ID --state /absolute/path/to/salaam-state
ssh USER@HOST 'sal session inspect SESSION_ID --state /absolute/path/to/salaam-state'
```

Use an absolute installed `sal` path if the remote noninteractive shell does not include its npm bin directory in `PATH`. Workspace and state paths are on the execution host. Copying a state directory to another computer does not connect to its existing worker. This path uses SSH authentication and no public Salaam listener.

## ACP v1 stdio

Configure an ACP client's agent subprocess command as:

```json
{
  "command": "/absolute/path/to/sal",
  "args": ["acp", "--state", "/absolute/path/to/salaam-state"]
}
```

Add `--local` to the adapter arguments to open your desk session in the editor's project folder, the same session `salaam` opens in a terminal there (see [Your desk session in an editor](#your-desk-session-in-an-editor)). Add `--coding` instead to create guarded coding sessions in an owned copy. The service must already be running with `--coding-root`; commands additionally require its proven execution backend. A `session/new` caller may explicitly select `_meta["salaam.dev/coding"]`; load/resume retain the saved session’s original authority.

The service must already be running. The adapter uses newline-delimited UTF-8 JSON-RPC on stdin/stdout; diagnostics use stderr. It negotiates protocol version **1**. Its tested subset follows the official [initialization](https://agentclientprotocol.com/protocol/v1/initialization), [session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn), [permission](https://agentclientprotocol.com/protocol/v1/tool-calls) and [stdio transport](https://agentclientprotocol.com/protocol/v1/transports) contracts, checked on 2026-10-17. ACP v2 draft behavior is not advertised.

| Method                       | Behavior                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `initialize`                 | Returns version 1, supported capabilities and no separate authentication methods for this local OS-account client |
| `session/new`                | Creates/provisions a Salaam session and returns the same session ID the CLI uses                                  |
| `session/load`               | Loads a session and replays its entire imported active-branch conversation in pages before responding             |
| `session/resume`             | Connects to that session without replaying existing conversation messages                                         |
| `session/prompt`             | Accepts text and resource references through durable logical submission IDs; returns after the attempt settles    |
| `session/update`             | Sends committed message/tool updates; permission presentation can occur while a tool is waiting                   |
| `session/request_permission` | Presents the exact operation, target/value/version, digest and approval revision; offers allow-once/reject-once   |
| `session/cancel`             | Explicitly journals cancellation before requesting abort; unknown external outcomes stay unknown                  |
| `session/set_mode`           | Desk sessions only: review, accept edits, auto or full access (full access confirms first)                        |
| `session/set_config_option`  | Desk sessions only: the same choice as the `mode` option; returns every option                                    |

The adapter sends committed transcript chunks and normalized live tool start/finish updates, deduplicating tool identities when the transcript catches up. Volatile token previews remain TUI-only. It advertises no image/audio/embedded-resource prompt capability, additional directories, client terminal/filesystem execution, model selection or dynamic MCP connections. Modes and the `/rewind` command are offered only for desk sessions. Use `mcpServers: []`; nonempty server lists are rejected. Resource links become prompt references and do not cause the adapter to fetch arbitrary resources. New/load/resume use an absolute `cwd`, matching the saved session directory when reconnecting. The checked-in independent client fixture proves this subset; a named editor's UI is a separate integration observation.

Loading a running session can observe and answer approvals without taking control. Prompting acquires the normal controller lease and fails if another controller owns it. `_meta: {"salaam.dev/takeover": true}` requests an explicit takeover. Leases renew every five seconds. Losing the ACP process leaves the daemon and current work alive; reconnect to the same session rather than creating another session.

For a retryable logical prompt, provide a fresh UUID once and retain it across retries:

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session/prompt",
  "params": {
    "sessionId": "SESSION_ID",
    "prompt": [{ "type": "text", "text": "Review the staging report" }],
    "_meta": { "salaam.dev/requestId": "LOGICAL_UUID" }
  }
}
```

The transport request ID `42` is not the logical submission identity. Salaam fsyncs the exact logical input before sending it and retains its acceptance receipt in `STATE/acp-requests`. Reusing the logical UUID with different text or another session conflicts. Without this metadata, each new prompt request is new logical work. A new load/resume retries unresolved journal records before accepting more work. After an interrupted service attempt, use a new logical UUID and `_meta: {"salaam.dev/continuesAttemptId": "INTERRUPTED_ATTEMPT_ID"}` with an explicit new instruction; resuming alone never replays the old attempt.

Permission replies are correlated to the exact persisted binding. Malformed, expired or mismatched replies cannot grant execution. Concurrent replies serialize their durable outbox writes. A disconnected approver leaves decisions pending. A cancelled permission response from a controlling client requests explicit session cancellation; it never counts as permission to execute.

## Configure Zed

Zed’s [custom agent configuration](https://zed.dev/docs/ai/external-agents#custom-agents) accepts an `agent_servers` entry. This template pins the executable runtime explicitly; replace the absolute paths for your installed CLI and service state:

```json
{
  "agent_servers": {
    "Salaam": {
      "type": "custom",
      "command": "/absolute/path/to/node-26.7.0",
      "args": [
        "/absolute/path/to/salaam/bin/salaam.mjs",
        "acp",
        "--local",
        "--state",
        "/absolute/path/to/salaam-state"
      ],
      "env": {}
    }
  }
}
```

This opens your desk session in the project Zed has open; the service must already be running. For a guarded owned copy instead, replace `--local` with `--coding` and start the service with its coding root and selected executor; that copy holds edits and the original checkout remains the baseline. Do not forward MCP servers or additional directories; Salaam rejects those unsupported additions.

Zed may forward existing MCP configuration when starting an external agent. If Salaam reports `Use an absolute cwd and no extra MCP servers/directories`, disable each configured server for the project in `.zed/settings.json`:

```json
{
  "context_servers": {
    "YOUR_EXISTING_MCP_SERVER": { "enabled": false }
  }
}
```

## Your desk session in an editor

With `--local`, a new editor thread is a local coding session in the project folder itself, with the same approvals, rules, sandbox and checkpoints as `salaam` in a terminal there. Open the same session in the terminal with `salaam -c` from that folder.

- **Modes.** The editor's mode picker offers Review, Accept edits, Auto and Full access, sent both as `modes` and as the `mode` config option. Picking Full access shows a confirmation with the warning first; cancelling keeps the current mode. Picking any other mode turns full access off. YOLO is not offered: it is turned on only in the terminal (`/yolo`, then type `yolo`). While it is on, the picker shows it, and picking another mode turns it off. A mode changed in the terminal (Shift+Tab) reaches the editor as `current_mode_update` and `config_option_update`.
- **Approvals.** Each prompt says why it asks (the mode, a dangerous command, a push, a command that may listen) and shows an edit as a `diff` per file, or a command's exact text. Besides Allow once and Reject, it offers **Allow for this session** (`allow_always`), which saves the exact request as a session rule, as the terminal does. A command with shell features can only be approved once. Rules for always in this repo are made in the terminal.
- **Finished edits** carry their `diff`, whichever mode applied them.
- **`/rewind`** lists the turns. `/rewind N` shows what restoring changes, and on **Restore files** puts the files back as they were before turn N. The conversation is kept. Going back in the conversation continues in a new session, which an editor thread cannot follow, so do that with `/rewind` in the terminal. The command is handled by Salaam and never sent to the model.

## Operator attention

ACP carries the service's durable inbox entries in `session/update` metadata `salaam.dev/inbox` with a textual attention summary. `_salaam/inbox/list` accepts an optional pagination offset. `_salaam/inbox/ack` accepts the exact item ID, expected revision and stable request ID; the source session must already be connected and its controller acquired. Acknowledgement never decides a permission or retries work. Normal operation-bound `session/request_permission` remains the approval path.

These are Salaam ACP extensions. Inbox acknowledgement does not approve an operation or retry work. See [jobs and inbox](jobs.md).

### Durable outcomes and cancellation receipts

ACP errors carry a bounded typed failure in `data["salaam.dev/failure"]` with its
logical prompt, session and attempt IDs where available. Token-limit and refusal
outcomes preserve `max_tokens` and `refusal`; partial text does not turn them into
success. Attempts saved before durable outcome verification remain unverified
rather than being replayed automatically.

Clients can advertise `_meta["salaam.dev/executionFeatures"]` with
`{"failures":1,"cancellationReceipts":1,"toolSemantics":1}` during initialization.
This namespace is separate from the existing prompt-receipt capability. For an
idempotent cancellation, send `session/cancel` with
`_meta["salaam.dev/cancellationId"]` (a UUID) and
`_meta["salaam.dev/targetRequestId"]` (the original logical prompt ID). The daemon
records the stop before aborting work, including when cancellation arrives before
the prompt itself. Retrying the same cancellation preserves its original target.

Opted-in clients receive durable `salaam.dev/cancellationReceipt` update metadata.
`requested` is an accepted stop intent; `confirmed` requires observed settlement
and reconciled effects; `unknown` preserves uncertainty about owned resources or
external effects. Loading the same session replays these receipts. Closing an ACP
client detaches; it does not cancel work. Session revocation is a separate boundary.
Tool calls preserve their read/search/edit/delete/execute kind on live and replayed
updates. Locations identify actual guarded workspace files; repository snapshots
do not invent editable source paths.
