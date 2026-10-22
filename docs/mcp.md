# MCP servers

Salaam sessions can use MCP servers that **you, the operator,** declare for the
service. A repository cannot add one: Pi runs with `--no-mcp` and
`--no-extensions`, so a workspace `.pi/mcp.json`, `.pi/config.json` or any other
file in the working directory never gives the agent a tool. AgentPod is not
needed; when Salaam is also attached to AgentPod, its assigned servers sit next to
yours.

## Declare a server

```sh
# stdio: install the server first (Salaam never downloads during a turn), then
# declare the command; it runs without a shell when a session first uses it
uv tool install mcp-server-time==2026.8.18
sal mcp add time -- mcp-server-time --local-timezone UTC

# streamable HTTP: https, or http on a loopback address
sal mcp add docs --url https://mcp.example.com/mcp \
  --header 'Authorization=Bearer ${DOCS_TOKEN}'

sal mcp list
sal mcp rm docs
```

Declarations live in `$XDG_CONFIG_HOME/salaam/mcp.json` (by default
`~/.config/salaam/mcp.json`), written with mode `0600`. `--config PATH` on
`sal mcp` and `--mcp-config PATH` on `sal service start` choose another file.
Changes apply at the next `sal service start`; stop the service first. A running
service started from a different declaration says so.

The file is a list, so duplicate names are caught:

```json
{
  "version": 1,
  "servers": [
    {
      "name": "time",
      "transport": "stdio",
      "command": "mcp-server-time",
      "args": ["--local-timezone", "UTC"]
    },
    {
      "name": "docs",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" }
    }
  ]
}
```

## What the service checks at start

`sal service start` refuses to start when the file is malformed, a name repeats or
does not match `^[a-z][a-z0-9_-]{0,63}$`, a stdio command is neither absolute nor
found on the service's `PATH`, an HTTP URL is not `https` (or loopback `http`) or
carries credentials, a key is unknown, or a value holds an inline secret.

**No secrets in the file.** Every header value and every stdio `env` value must
reference an environment variable as `${VAR}`; only a short scheme word such as
`Bearer ` may sit beside it. `Authorization=Bearer abc123` is refused. Variables
are resolved from the service's own environment when it starts, and a missing one
refuses the start. Resolved values stay inside the daemon: they are not passed to
Pi, written to the transcript, shown by `mcp list` or recorded in provenance, and
known values are redacted from tool results and errors. Under systemd, put them in
the unit's environment file.

A stdio server gets a minimal environment (`HOME`, `PATH`, `USER` and similar)
plus the `env` you declared; it does not inherit the service's provider keys.

## How a session uses them

The daemon owns every MCP connection. A session that has declared servers gets one
tool, `salaam_operator_mcp`, and the `operator-mcp-v1` capability. The model lists
servers, a server's tools and a tool's schema with `catalog`, then uses `call`. A
stdio server starts on a session's first use and stops with that session's
worker. Child workers get no MCP servers.

Declaring a server is your grant: calls are not approval-gated and do not enter
the managed operation ledger. Each call is recorded as an `operator_mcp.call`
event with the server, tool, an argument digest and the outcome. A reply is the
server's protocol result, not proof that an external change happened. Use
AgentPod's managed MCP when you need approvals or unknown-effect accounting.

## Alongside AgentPod

Both sources can serve one session. If a declared name equals an AgentPod-assigned
server's name, the worker is refused at admission with `mcp_name_collision` and the
session reports why. Nothing is silently shadowed; rename your declaration.

## Provenance

Each session records every MCP server it got, in its readiness handshake and in
`workers/<session>/mcp-servers.json` under the state directory:

```sh
sal session inspect SESSION_ID   # see "mcp_servers"
```

Each entry carries `name`, `source` (`operator` or `agentpod`), `transport`, the
resolved `command` and `args` or the `url` (AgentPod entries carry an
`endpoint_digest`, since their endpoints are private), and `declaration_digest`,
the SHA-256 of the canonical declaration with references unresolved.
`sal service status` shows the loaded declarations and their digest.

## SuperToolkit is just another server

SuperToolkit needs no special path in Salaam. Declare its MCP server like any other
stdio server, for example:

```sh
sal mcp add fetch -- stk mcp serve fetch
```

The exact `stk` subcommand belongs to SuperToolkit's own documentation; use the
one it names.
