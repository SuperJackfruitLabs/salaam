# Editors

Salaam speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1),
so editors such as Zed can run it as an agent. An editor thread is the same session
`salaam` opens in a terminal in that folder: the same approvals, rules, sandbox and
checkpoints, and you can switch between the two at any time.

## Zed

Add Salaam to `agent_servers` in Zed's settings
([Zed's guide](https://zed.dev/docs/ai/external-agents#custom-agents)). Use absolute
paths for Node 26.7.0 and the installed CLI:

```json
{
  "agent_servers": {
    "Salaam": {
      "type": "custom",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/salaam/bin/salaam.mjs", "acp", "--local"],
      "env": {}
    }
  }
}
```

`which node` and `npm root -g` show the paths. Add `"--state", "/absolute/path"` to
`args` if you use a state directory other than `~/.local/state/salaam`.

Open the agent panel and choose **Salaam**. A new thread starts a session in the
project folder Zed has open, using the model a new terminal session would use. From
0.0.6 the adapter starts the service if it is not running.

## What works in the editor

- **Modes.** The mode picker offers Review, Accept edits, Auto and Full access.
  Picking Full access asks you to confirm first. YOLO is turned on only in the terminal;
  while it is on, the picker shows it. A mode you change in the terminal shows up in
  the editor, and the other way round.
- **Approvals** say why they ask and show each edit as a diff, or the exact command.
  Besides Allow once and Reject, **Allow for this session** saves the request as a
  session rule. Rules for the whole repository are made in the terminal.
- **Finished edits** show their diff, whichever mode applied them.
- **`/rewind`** lists your turns, and `/rewind N` restores the files to before turn N
  after you confirm. Going back in the conversation continues in a new session, which
  an editor thread cannot follow, so do that from the terminal.

## Continue in the terminal

From the project folder, `salaam -c` opens the session the editor was using. Closing
the editor leaves running work running.

## MCP servers from the editor

Zed passes its own MCP servers to every agent it starts. Salaam does not connect to an
editor's MCP servers; a desk session (`--local`) ignores them and notes how many on
stderr. Give Salaam tools through its own [MCP configuration](mcp.md) instead.

Without `--local`, the adapter rejects them with
`Use an absolute cwd and no extra MCP servers/directories`. Turn them off for that
project in `.zed/settings.json`:

```json
{
  "context_servers": {
    "YOUR_MCP_SERVER": { "enabled": false }
  }
}
```

## Other editors and sessions

Any ACP v1 client can run `salaam acp`. Without `--local` it opens managed sessions,
and `--coding` opens sessions in a private copy of the project (see
[Coding in a container](coding.md)). The protocol details, extensions and retry rules
are in the [ACP reference](clients.md).
