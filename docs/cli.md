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

<!-- generated:cli-commands -->

| Command       | What it does                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `code`        | Work in this folder: continue its session or start one (also: here, -c) |
| `tui`         | Open the Salaam terminal interface (also bare sal)                      |
| `remote`      | Open the same session over SSH                                          |
| `providers`   | List pinned Pi providers and capabilities                               |
| `models`      | List pinned chat models                                                 |
| `auth`        | Configure provider credentials or OAuth                                 |
| `service`     | Start, inspect or stop the session service                              |
| `session`     | Create, inspect, submit, resume or cancel work                          |
| `mcp`         | Declare operator MCP servers (add, list, rm)                            |
| `attach`      | Open an interactive terminal on a session                               |
| `acp`         | Connect an editor over ACP v1 stdio                                     |
| `approvals`   | Inspect, approve or deny managed operations                             |
| `operations`  | Inspect, reconcile or resolve effect outcomes                           |
| `children`    | Inspect, read or acknowledge durable child results                      |
| `tasks`       | Durable plans, verification, budgets and checkpoints                    |
| `jobs`        | Durable one-shot jobs and recovery                                      |
| `schedules`   | Fresh recurring occurrences and explicit missed-run rules               |
| `inbox`       | Durable shared operator attention                                       |
| `host`        | Pinned host bootstrap, supervision and health                           |
| `task`        | Inspect and update durable task facts                                   |
| `history`     | Retrieve older history and evidence                                     |
| `artifacts`   | Save durable text evidence                                              |
| `compactions` | Inspect or cancel a managed checkpoint                                  |
| `execution`   | Prove the container boundary with disposable fixtures                   |
| `workspace`   | Inspect coding copies, review diffs or acknowledge human edits          |
| `agents`      | Inspect and admit specialist profiles                                   |
| `team`        | Assign task steps and inspect the durable team inbox                    |
| `workers`     | Inspect and explicitly integrate isolated coding proposals              |
| `harness`     | Prepare, inspect and reconcile pinned external workers                  |
| `a2a`         | Configure bounded peer analysis and inspect remote work                 |
| `commands`    | Start, inspect, cancel or reconcile isolated commands                   |

<!-- /generated:cli-commands -->

Each area has its own page: [Providers](providers.md), [MCP servers](mcp.md),
[Durable tasks](durable-tasks.md), [Jobs and schedules](jobs.md),
[Specialists and teams](agents.md), [External harnesses](external-harnesses.md),
[A2A peers](a2a.md), [Coding in a container](coding.md) and
[Host operation](host-operation.md).

## Global options

- `--state DIR` (or `SALAAM_STATE_DIR`): the service's state directory. Default
  `~/.local/state/salaam`. Every command for one service must use the same path.
- `-h`, `--help`: usage, without starting anything.
- `-V`, `--version`: the installed version.

The full HTTP-over-socket API behind these commands is in the
[service reference](service-reference.md).
