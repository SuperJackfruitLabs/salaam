# CLI

`salaam` (or `sal`) opens the terminal app with no arguments. With a command, it
scripts the same service: everything the terminal and editors do is also a CLI
command. `salaam COMMAND --help` prints a command's usage without starting the service
or calling a model.

## Everyday commands

```sh
salaam code [--continue | --new | --resume] [--cwd DIR]   # work in a folder
salaam -c                                                 # continue this folder's session
salaam attach SESSION_ID [--observe | --takeover]         # open a session by ID
salaam remote HOST --session SESSION_ID                   # the same, over SSH
salaam acp --local                                        # run as an editor agent
```

## Providers and models

```sh
salaam providers list
salaam models list anthropic
salaam auth set anthropic          # API key at a hidden prompt, or on stdin
salaam auth login PROVIDER [--oauth]
salaam auth status [PROVIDER]
salaam auth logout PROVIDER
```

See [Providers](providers.md).

## The service

```sh
salaam service start [--provider ID --model ID] [--local-sandbox LEVEL] [--foreground]
salaam service status
salaam service stop
```

The terminal and `salaam code` start the service when needed. Start it yourself to
choose its default model, [sandbox](sandbox.md) level, [MCP servers](mcp.md) or a
coding container. `--foreground` keeps it attached for a process supervisor.

## Sessions from scripts

```sh
salaam session create --cwd "$PWD" --local-coding
salaam session list
salaam session submit SESSION_ID --text "Run the tests and fix what fails"
salaam session inspect SESSION_ID
salaam session cancel SESSION_ID --attempt ATTEMPT_ID
salaam approvals list
salaam approvals approve APPROVAL_ID --digest DIGEST --revision N
```

`session create` takes `--local` for a read-only session, `--local-coding` to edit and
run commands in the folder, or `--coding` for a [container](coding.md). An approval is
answered with the digest and revision `approvals inspect` shows, so you approve exactly
what you reviewed.

## All commands

| Command                                          | Purpose                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| `code`, `tui`, `attach`, `remote`                | Open a session in the terminal                                         |
| `acp`                                            | Connect an editor over ACP ([Editors](editors.md))                     |
| `providers`, `models`, `auth`                    | [Providers](providers.md) and credentials                              |
| `service`                                        | Start, inspect or stop the service                                     |
| `session`, `history`, `artifacts`, `compactions` | Sessions, their history and saved evidence                             |
| `approvals`, `operations`                        | Answer approvals; reconcile outcomes Salaam could not confirm          |
| `mcp`                                            | [MCP servers](mcp.md) the service offers                               |
| `tasks`, `task`                                  | [Durable tasks](durable-tasks.md): plans, checks, budgets, checkpoints |
| `jobs`, `schedules`, `inbox`                     | [Jobs and schedules](jobs.md), and the shared attention inbox          |
| `agents`, `team`, `workers`, `children`          | [Specialists and teams](agents.md)                                     |
| `harness`                                        | [External harnesses](external-harnesses.md)                            |
| `a2a`                                            | [A2A peers](a2a.md)                                                    |
| `workspace`, `commands`, `execution`             | [Coding in a container](coding.md)                                     |
| `host`                                           | [Host operation](host-operation.md)                                    |

## Global options

- `--state DIR` (or `SALAAM_STATE_DIR`): the service's state directory. Default
  `~/.local/state/salaam`. Every command for one service must use the same path.
- `-h`, `--help`: usage, without starting anything.
- `-V`, `--version`: the installed version.

The full HTTP-over-socket API behind these commands is in the
[service reference](service-reference.md).
