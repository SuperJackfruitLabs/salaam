# Intro

Salaam is a coding agent that does not confuse a closed terminal with a finished
job. You work from your terminal or editor; a small local service keeps each
session's conversation, approvals, checkpoints and results. Close the terminal,
come back tomorrow, or pick up the same session in Zed: your work is still there.

## Prerequisites

- macOS or Linux. Windows is untested.
- Node **26.7.0** and npm **11.19.0**. With nvm: `nvm install 26.7.0`.
- An account with a model provider, such as an Anthropic API key or a Claude, ChatGPT
  or Copilot subscription. Salaam works without one, but only replies offline.

## Install

```sh
curl -fsSL https://salaam.sh/install.sh | sh
salaam --version
```

The installer checks the release's checksum before installing. `salaam` and `sal`
are the same command. For npm, tarballs, upgrades and removal, see
[Install and upgrade](install.md).

You now have both command names on your path and a version you can identify before
we connect anything billable.

## Connect a provider

Set an API key at a hidden prompt:

```sh
salaam auth set anthropic
```

Or sign in with a subscription through the provider's own login:

```sh
salaam auth login openai-codex
```

Salaam ships with 41 chat providers. `salaam providers list` shows them, and
[Providers](providers.md) covers keys, OAuth and cloud accounts.

That gives your next session a real model route; until then, Salaam stays safely
offline.

## Start in a project

```sh
cd /path/to/your/project
salaam code
```

`salaam code` starts the service if it is not running and opens this folder's
latest session, or a new one. New sessions use Claude Sonnet when you have an
Anthropic key; `/model` picks any other provider and model.

Salaam reads `AGENTS.md` (or `CLAUDE.md`) from the repository automatically. Run
`/init` to have it draft one for you. See [Rules](rules.md).

You are now in a durable project session: closing this client will not throw the
session away.

## Ask questions

Type a question and press Enter:

```text
How does authentication work in src/server?
```

Type `@` to attach a file by name. Press Ctrl+X to see every tool call and its
output.

The answer arrives with the tool trail still available, so you can inspect how it
got there instead of taking a polished sentence on faith.

## Make changes

Every edit and command asks first. The approval shows the diff or the exact command;
press `y` to approve once, `s` for the rest of the session, or `f` to deny with a
reason the agent reads.

When you trust the direction, press **Shift+Tab** to change the mode:

| Mode         | What runs without asking                          |
| ------------ | ------------------------------------------------- |
| Review       | Nothing. Every edit and command asks.             |
| Accept edits | Edits inside the project.                         |
| Auto         | Edits, and commands that stay inside the sandbox. |

Commands run in an OS sandbox: they write only inside the project and have no
network. See [Permissions](permissions.md) and [Sandbox](sandbox.md).

You choose the pace: keep every action reviewable, or remove repeated prompts
without quietly removing the boundary around the project.

## Undo changes

`/rewind` lists your turns. Pick one to put the files back as they were before it,
go back in the conversation, or both. Salaam checkpoints the folder before every turn
in its own shadow repository, so your `.git` is never touched.

`/undo` reverses just the last edit.

The files are back where you chose, while the original conversation remains
available for comparison.

## Come back later

Close the terminal, or press Ctrl+D. Work that is running keeps running. Later, from
the same folder:

```sh
salaam -c
```

The session picker (`salaam code --resume`, or Ctrl+P) lists every session, this
folder's first. To work in an editor, see [Editors](editors.md).

There it is: the same session after the terminal went away. The service, not the
window, was keeping the chair warm.

## Customize

- [Terminal](tui.md): keys, slash commands and views.
- [Permissions](permissions.md): modes, approval rules and full access.
- [Commands](commands.md) and [Hooks](hooks.md): your own slash commands and scripts.
- [MCP servers](mcp.md): extra tools for the agent.
- [Specialists and teams](agents.md): delegate work to other agents.

Something wrong? See [Troubleshooting](troubleshooting.md).
