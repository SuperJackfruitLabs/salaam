# Operator-declared MCP servers

Status: proposed, 2026-10-22.

## Problem

Standalone Salaam cannot use any MCP server. Pi runs with `--no-mcp`, and the only way an
MCP tool reaches a session is a reviewed AgentPod assignment (`worker.mcp`) or the AgentPod
Toolkit (`worker.toolkit`). That breaks the suite rule that a product must work on a bare
laptop and that suite integration is an optional adapter.

`--no-mcp` is correct and stays. A repository is not an authority: a `.pi/mcp.json` or
`.pi/config.json` in a workspace must never give the agent a tool. What is missing is a
first-class place for the **operator** of a Salaam service to declare servers.

## Decisions

1. **Where declarations live.** One file owned by the operator:
   `$XDG_CONFIG_HOME/salaam/mcp.json`, defaulting to `~/.config/salaam/mcp.json`.
   `salaam service start --mcp-config <path>` names another file. Salaam never reads MCP
   declarations from a session's working directory, a workspace or Pi's agent directory.
   Pi keeps `--no-mcp`, `--no-extensions` and the single house extension.

2. **Format.** A list, so duplicate names are detectable (a JSON object silently keeps the
   last duplicate key):

   ```json
   {
     "version": 1,
     "servers": [
       { "name": "time", "transport": "stdio", "command": "uvx",
         "args": ["mcp-server-time==2026.1.26"], "env": { "TZ": "${TZ}" } },
       { "name": "docs", "transport": "http", "url": "https://mcp.example.com/mcp",
         "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
     ]
   }
   ```

   - `name`: `^[a-z][a-z0-9_-]{0,63}$`, unique across the file.
   - `stdio`: `command` is absolute, or a bare name resolved on the service's `PATH` at
     start (the resolved absolute path is what runs and what provenance records). No shell;
     `args` is an argument vector. Optional `cwd` must be absolute.
   - `http`: streamable HTTP. `url` must be `https:`; `http:` is accepted only for loopback
     hosts (`127.0.0.1`, `localhost`, `[::1]`). No userinfo in the URL.
   - **No inline secrets.** Every `headers` value and every stdio `env` value must contain
     at least one `${VAR}` reference, and the literal text around references may only be a
     short scheme word such as `Bearer ` or `Token `. `Authorization: Bearer abc123` is
     refused. References are resolved from the service's own environment at start; a missing
     variable refuses the start. Resolved values stay in the daemon and are never written to
     the worker configuration, the journal, provenance or `mcp list`.
   - Unknown keys are refused.

3. **CLI.**
   - `salaam mcp add <name> -- <command> [args…]` (stdio), with repeatable
     `--env K='${VAR}'`.
   - `salaam mcp add <name> --url <url> [--header K='Bearer ${VAR}']…` (HTTP).
   - `salaam mcp list` prints the declarations (references, never values) with each
     declaration digest.
   - `salaam mcp rm <name>`.
   All three validate with the same function the service uses and write the file atomically
   with mode `0600`. Changes take effect at the next `service start`; a running service whose
   loaded declaration digest differs makes `service start` say so.

4. **Validation at service start.** The service refuses to start on a malformed file, a
   duplicate name, an unresolvable command, a non-loopback `http:` URL, an inline secret or a
   missing referenced variable. A missing file means no declared servers.

5. **How sessions get the servers.** The daemon owns the MCP clients, as it does for
   `worker.mcp`. The worker configuration and readiness handshake carry `operator_mcp`, a
   public view (names, transports, command or URL, declaration digests). The house extension
   registers one progressive tool, `salaam_operator_mcp` (`catalog` to list servers, a server
   to list its tools, server+tool for a schema; `call` to invoke). Calls go over the bridge
   (`operator_mcp.catalog`, `operator_mcp.call`). The daemon starts a session's stdio server
   or HTTP connection lazily on first use and closes it when the session's worker stops.
   Children get no declared servers, matching managed MCP.

6. **Merging with AgentPod.** Both sources are allowed in one session. If a declared name
   equals an AgentPod-assigned server name the worker is refused at admission
   (`mcp_name_collision`) and the session reports unhealthy with that reason. Nothing is
   silently shadowed.

7. **Provenance.** Each worker records `mcp_servers`: for every server it got,
   `name`, `source` (`operator` or `agentpod`), `transport`, `command` + `args` or `url`
   (AgentPod: its `endpoint_digest`, since its public view omits endpoint URLs), and
   `declaration_digest` (SHA-256 of the canonical declaration, references unresolved; for
   AgentPod the digest of the admitted server view). The list and its digest are part of the
   readiness handshake the worker must echo, are persisted beside the worker, and appear in
   `salaam session inspect`.

8. **Authority.** Declaring a server is the operator's grant. Calls are not approval-gated
   and are not entered in the managed operation ledger; each call is recorded as an
   `operator_mcp.call` event with server, tool, argument digest and outcome. A reply is a
   protocol result, not proof of an external effect. Operators who need approvals or
   unknown-effect accounting use AgentPod managed MCP.

## SuperToolkit is just another server

SuperToolkit needs no special path. Once its CLI exposes an MCP server, an operator declares
it like any other, for example `salaam mcp add fetch -- stk mcp serve fetch`. The exact
`stk` subcommand is owned by the SuperToolkit spec and was not settled when this was written.

## Tests (each revert-proof: remove the guard, watch it go red)

- A workspace `.pi/mcp.json` naming a server is still ignored: no `mcp__*` tool, the
  server never starts.
- A declared stdio server (a tiny fake MCP server fixture) reaches a real pinned Pi session:
  the tool result lands in the session.
- An HTTP declaration validates and reaches a session against a loopback fixture.
- An inline secret in a header or env value is refused.
- A name collision with an AgentPod-assigned server is refused at admission.
- Provenance is recorded and shown by `session inspect`.
- CLI `mcp add`/`list`/`rm` round-trip.

## Out of scope

Hot reload of declarations, OAuth flows, per-tool allowlists, approvals for declared calls,
resources/prompts/sampling, and fetching or installing servers. Salaam runs the command the
operator declared; it does not download it.
