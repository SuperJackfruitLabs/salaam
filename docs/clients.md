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

Use an absolute installed `sal` path if the remote noninteractive shell does not include its npm bin directory in `PATH`. Workspace and state paths are on the execution host. Copying a state directory to another computer does not connect to its existing worker. This path uses SSH authentication and no public Salaam listener. The opt-in M10 rehearsal exercises actual macOS-to-Linux SSH; named editor GUI acceptance is tracked separately in verification evidence.

## ACP v1 stdio

Configure an ACP client's agent subprocess command as:

```json
{
  "command": "/absolute/path/to/sal",
  "args": ["acp", "--state", "/absolute/path/to/salaam-state"]
}
```

Add `--coding` to the adapter arguments to create guarded coding sessions. The service must already be running with `--coding-root`; commands additionally require its proven execution backend. A `session/new` caller may explicitly select `_meta["salaam.dev/coding"]`; load/resume retain the saved session’s original authority.

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

The adapter sends committed transcript chunks and normalized live tool start/finish updates, deduplicating tool identities when the transcript catches up. Volatile token previews remain TUI-only. It advertises no image/audio/embedded-resource prompt capability, additional directories, client terminal/filesystem execution, modes, model selection or dynamic MCP connections. Use `mcpServers: []`; nonempty server lists are rejected. Resource links become prompt references and do not cause the adapter to fetch arbitrary resources. New/load/resume use an absolute `cwd`, matching the saved session directory when reconnecting. The checked-in independent client fixture proves this subset; a named editor's UI is a separate integration observation.

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

## Demonstrate and verify

```sh
npm run demo:acceptance
npm run test:acceptance
# Faster development run; explicitly recorded as partial acceptance:
npm run test:acceptance -- --repeats 1
```

The combined demo starts disposable offline service/effect fixtures, submits from the installed terminal, kills that client with two pending approvals, loads the same session over ACP, approves one effect, recovers child results, performs three checkpoints and retrieves old evidence. It inspects the same final session through the installed CLI.

The acceptance runner records source-file hashes, worker bundle digest, runtime/platform, command exit codes, log digests, JSON reports and all six proof suites repeated 20 times by default. Reports live under `.state/evidence/acceptance/RUN_ID/`; `latest-acceptance.json` points to the last successful run. A shorter repetition run is marked partial. CI retains separate macOS and Linux artifacts. Platform success means an observed passing run for that revision; it does not imply a deployment, SSH rehearsal, live-model behavior evaluation or production isolation.

## Zed rehearsal template

Zed’s [custom agent configuration](https://zed.dev/docs/ai/external-agents#custom-agents) accepts an `agent_servers` entry. This template pins the executable runtime explicitly; replace the absolute paths for a disposable rehearsal service:

```json
{
  "agent_servers": {
    "Salaam": {
      "type": "custom",
      "command": "/absolute/path/to/node-26.7.0",
      "args": [
        "/absolute/path/to/salaam/bin/salaam.mjs",
        "acp",
        "--coding",
        "--state",
        "/absolute/path/to/rehearsal-state"
      ],
      "env": {}
    }
  }
}
```

Start the rehearsal service first with its coding root and selected executor. Use one disposable project and no forwarded MCP servers or additional directories; Salaam rejects those unsupported additions. Select Salaam as the external agent, send a coding instruction and inspect actual tool outcomes and the workspace diff through the same session ID. The guarded owned copy holds edits; the original project checkout remains the baseline.

Zed may forward existing MCP configuration when starting an external agent. If Salaam reports `Use an absolute cwd and no extra MCP servers/directories`, disable each configured server for the disposable project in `.zed/settings.json`:

```json
{
  "context_servers": {
    "YOUR_EXISTING_MCP_SERVER": { "enabled": false }
  }
}
```

The named Zed 1.24.2 GUI rehearsal passed on 2026-10-18. It observed the Salaam selector/composer, live tools, actual isolated command exit 0, two separately reviewed approval bindings, the real owned file and an exported checked diff opened in the editor. `Reload Agent` restored the same session and committed history without another patch or command. After an abrupt adapter reload, the prior controller lease may remain valid briefly; wait for expiry or use an explicitly authorized controller takeover. A rejected prompt is not an accepted attempt. See [GUI evidence](evidence/m10-zed-gui.json).

Live prompts are displayed by the editor; Salaam does not echo them as extra user chunks. Explicit history loading replays committed user turns once. The checked diff in this rehearsal was exported from the service and opened as a diff document; native ACP edit/diff rendering is not claimed.
