# Sandbox

Commands the agent runs in your project go through the operating system's sandbox:
Seatbelt on macOS, bubblewrap on Linux. Edits are separate and go through
[permissions](permissions.md).

## What a sandboxed command can do

By default (`workspace-write`), a command:

- reads the system, developer tools and your project;
- writes only inside your project and a private temporary folder;
- has no network;
- cannot read your home folder, credentials, or (on macOS) ask the system about other
  apps and processes.

It runs as you, with a minimal environment: your API keys are not passed in. A command
in the foreground may run for two minutes and keeps 64 KiB of output. Servers and
watchers go in the background; `/jobs` lists them.

## Levels

Choose the level when you start the service:

```sh
salaam service start --local-sandbox workspace-write   # the default
salaam service start --local-sandbox read-only         # writes nothing
salaam service start --local-sandbox full-access       # no sandbox
```

The same choice is `SALAAM_LOCAL_SANDBOX`. In a session, `/full-access` and `/yolo`
turn the sandbox off for that session only (see [Permissions](permissions.md)).

## Toolchains outside the project

Compilers and package caches in your home folder are unreadable by default. Add them
read-only:

```sh
salaam service start --local-sandbox-read toolchain
salaam service start --local-sandbox-read "$HOME/.cache/pip,$HOME/.gradle"
```

`toolchain` adds the Node running Salaam and, where they exist, `~/.npm`, `~/.nvm`,
`~/.cargo`, `~/.rustup`, `~/go`, `~/.gitconfig` and `~/.config/git`. Your home folder
itself and credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.npmrc`,
`~/.netrc`, keychains) are always refused. Listed paths are never writable.

On macOS, commands get the real `git` from the active developer folder. Git runs
without your global config unless `~/.gitconfig` is listed.

## Git inside the sandbox

Git runs programs its configuration names: a file-system monitor, hooks, content
filters, diff and textconv drivers. A command that could change your repository's
configuration could leave one of those for git to run later, outside the sandbox,
when Salaam or you run git. So in `workspace-write`:

- the repository's `.git/config`, `.git/config.worktree`, `.git/commondir`,
  `.git/hooks` and `.git/info` are read-only, and so are the same files of each
  submodule under `.git/modules/` and `config.worktree` and `commondir` of each
  linked worktree. When `.git` is a file pointing to a git folder inside the
  project, that folder is protected the same way;
- `.git` itself cannot be renamed, removed or replaced.

Everything else in `.git` stays writable, so commit, branch, checkout, merge, stash
and tag work as usual. What no longer works inside the sandbox is anything that
writes git config: `git config` with a value, `git remote add`, setting an upstream
branch, adding a submodule. Run those yourself, or for that one command outside the
sandbox.

These are found when each command starts. On Linux a `config.worktree` or
`commondir` that does not exist yet stays writable (a read-only mount needs a file
to mount over, and an empty `commondir` breaks git); a missing `hooks` or `info`
folder is created empty and mounted read-only. A repository a command creates, and
repositories in subfolders, are not protected this way.

Git that Salaam runs for itself outside the sandbox (the `@` file list, your commit
identity, `/pr`, turn checkpoints) ignores whatever the repository's configuration
says about programs: it turns off the file-system monitor, hooks, external diff,
pager, credential helpers, transports and automatic maintenance on the command line,
which overrides every config file and include, and drops git variables from its
environment. The diff view reads file contents, so it runs git inside the sandbox,
read-only: a content filter the repository names runs there, confined, not on your
machine.

## One command outside the sandbox

When the sandbox blocks something a task really needs, such as listing running apps,
the agent can ask to run that one command outside the sandbox and say why. The
approval shows the reason. It always asks, except in YOLO; auto mode and repository
rules never approve it, though a rule of your own can. The session stays sandboxed.

## Servers

A sandboxed command cannot listen for connections unless the agent marks it as a
server and you approve that exact command. On macOS the approval warns that a server
bound to `0.0.0.0` is reachable from your network. On Linux the sandbox has its own
network, so servers are refused there; use full access for them.

## Network

A command can reach the network only when the host routes it through a proxy that
allows listed hosts (`command_network: "broker"` in the host config). Each approval
then says so, and the result lists what was reached and what was refused. Background
commands get the same network for as long as they run; a refused host is listed in
their output (`/jobs`). See
[Security](security.md#network-through-the-broker-allowlist).

## Without a sandbox

If the sandbox is not available on a machine, commands are refused. An operator can
allow them anyway with `--unsandboxed-commands allow`; every approval then says
"unsandboxed".

For a sealed container with no access to your checkout at all, see
[Coding in a container](coding.md).
