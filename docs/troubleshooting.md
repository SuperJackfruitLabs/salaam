# Troubleshooting

Start with these two commands. Neither makes a model request.

```sh
salaam service status
salaam auth status
```

The service writes its log to `service.log` in its state directory
(`~/.local/state/salaam` unless you set `--state` or `SALAAM_STATE_DIR`).

## `connect ENOENT …/operator.sock`

The service is not running. `salaam code` and `salaam` start it for you; scripted
commands such as `salaam session create` do not. Start it with:

```sh
salaam service start
```

From 0.0.6, the editor adapter started with `acp --local` also starts the service.

## Replies say `Offline reply: …`

The session is on the offline provider, which never calls a model. Connect a
provider with `salaam auth set anthropic` or `salaam auth login PROVIDER`, then open a
new session or pick a model with `/model`. See [Providers](providers.md).

## Switching models opens a new session

Some providers enforce output limits differently, so a session keeps the provider it
started with. Choosing one of those in `/model` starts a new session in the same
folder with the new model; the old session stays as it was.

## A command fails with `Operation not permitted`

The sandbox blocked it. A sandboxed command writes only inside the project, has no
network and cannot read your home folder or ask macOS for other apps and processes.

- For a toolchain outside the project (`~/.cargo`, `~/.nvm`…), start the service with
  `--local-sandbox-read toolchain`.
- For one command that needs more, the agent can ask to run it outside the sandbox;
  you approve that command alone.
- To turn the sandbox off for a session, use `/full-access`.

See [Sandbox](sandbox.md).

## The editor says `ACP MCP declarations must match …`

Your editor forwarded its own MCP servers. Salaam 0.0.5 and later ignore them for desk
sessions (`acp --local`). For other sessions, turn the servers off for that project.
See [Editors](editors.md#mcp-servers-from-the-editor).

## `Another operator may be controlling this session`

One terminal or editor controls a session at a time. If the other one was killed, its
lease runs out within 15 seconds. If it is still open, press Ctrl+K and choose
**Take control**; running work carries on. Observers can still read and answer
approvals.

## New features are missing after an upgrade

A service keeps running the version it started with. Finish or detach running work,
then restart it:

```sh
salaam service stop
salaam code
```

Sessions created before an upgrade keep their original abilities; start a new
session to get new ones.

## The service won't start on macOS

Unix socket paths have a short length limit on macOS. Use a short `--state` path, such
as `~/.local/state/salaam`. Also check `node --version` prints exactly `v26.7.0`.

## Still stuck

- [Recovery and limitations](limitations.md) explains interrupted work and outcomes
  Salaam could not confirm.
- Report a problem on [GitHub](https://github.com/SuperJackfruitLabs/salaam/issues)
  with the output of `salaam --version` and `salaam service status`.
