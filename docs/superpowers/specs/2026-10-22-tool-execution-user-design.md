# Tool execution user

Status: proposed (2026-10-22)

## Problem

Salaam runs the agent's local tools as the same OS user as the daemon. That
user holds the model provider credential. On the staging host the daemon runs
as `salaam` and reads `KIMI_API_KEY` from `~salaam/.config/salaam/kimi.env`. One
approved `salaam_local` command such as `cat ~/.config/salaam/kimi.env`, or a
read of the daemon's `/proc/<pid>/environ`, returns the key to the model and
puts it in the transcript.

The operator has decided that the model key stays with Salaam. SuperToolkit is
not an AI gateway. The fix is to run tool execution as a separate
unprivileged OS user.

## Scope

These run on the agent's behalf and touch the host:

| Path                                     | Code                                          | Today                                                        |
| ---------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `salaam_local` command                   | `LocalCoding.command` (`src/local/coding.ts`) | `/bin/sh -c` as the service user                             |
| `salaam_local` edit (create, replace)    | `applyLocalEdits` (`src/local/edits.ts`)      | in-process fs writes as the service user                     |
| Operator undo of a local edit            | `applyUndo` (`src/local/undo.ts`)             | in-process fs writes and unlinks                             |
| `salaam_command` (coding sessions)       | Docker executor                               | already a non-root container user with no network; unchanged |
| `salaam_files` patches (coding sessions) | owned workspace copies under Salaam state     | Salaam-owned copies; unchanged                               |
| `salaam_workspace` read, list, search    | `LocalWorkspace`                              | path-confined reads as the service user; see Non-goals       |

The Pi worker has no built-in tools (`--no-builtin-tools`). Every effect goes
through the house extension, then over the bridge to the daemon. The daemon is
therefore the single place to switch identity. Git, moves and deletes inside
the workspace are shell commands, so they are covered by the command path.

## Design

### Configuration

- `salaam service start --tools-user <name>`, or `SALAAM_TOOLS_USER=<name>` in
  the service environment (systemd `Environment=`/`EnvironmentFile=`). The flag
  takes precedence.
- Unset: behaviour is unchanged. Startup prints one warning to stderr and
  `/v1/health` reports `tool_execution.mode = "service-user"` with the same
  warning:
  `Tool execution runs as <user>, the same OS user that holds the provider credential. Set --tools-user to separate them.`

### Mechanism: `sudo -n -u <tools-user>` with a runas-restricted rule

The daemon starts every agent-initiated process as
`sudo -n -u <tools-user> -- <fixed argv>`. The host grants exactly this with
one sudoers line:

```
salaam ALL=(salaam-tools) NOPASSWD: ALL
```

Why this mechanism:

- The service gets no capability. `CAP_SETUID` on the daemon (for `setpriv`
  or `runuser`) would let it take any uid, root included. That is root in all
  but name, and the brief says the service must not need full root. A
  runas-restricted sudo rule lets `salaam` become only `salaam-tools`, a user
  with fewer rights than itself. The rule grants nothing an attacker who owns
  `salaam` did not already have.
- `systemd-run --uid` needs the system manager and a polkit rule. On staging,
  Salaam is a systemd _user_ unit, so that would add a polkit policy and a
  privileged manager round-trip to every command. It also does not exist for
  standalone installs on hosts without systemd.
- sudo is present on every Linux host we run (staging has sudo-rs 0.2.13).
  `-n` fails closed instead of prompting. sudo resets the environment, so the
  daemon's provider variables cannot leak through it. We also pass an explicit
  empty environment.
- No setuid binary of our own and no root-owned helper to maintain.

The cost is that sudo itself is setuid root. The unit must not set
`NoNewPrivileges=yes`. We accept this; the alternative is a capability that is
strictly larger.

Commands: `sudo -n -u T -- /usr/bin/setsid /bin/sh -c <gated script>`. `setsid`
makes the tool shell a session and process-group leader. The script prints its
own pid as the first line of stdout. Salaam strips that line and keeps it as
the tool process group. Cancel, timeout and output-limit kills run
`sudo -n -u T -- /bin/kill -KILL -- -<pgid>`. The tool processes belong to
another uid, so the daemon cannot signal them directly. It still kills the
sudo process group as before. The script starts with `umask 0002`, so files
it creates are readable by the shared group.

File edits: `sudo -n -u T -- <node> <dist>/src/local/edit-helper.js`. The
helper receives the reviewed edit list as JSON on stdin and applies it with
the existing `applyLocalEdits` (O_EXCL temp file, O_NOFOLLOW, per-file atomic
rename, fsync). It prints one line per applied path. The daemon still verifies
before the call (as itself, through group read) and after it, so the
recorded intent, verification and outcome-unknown rules do not change. Undo
uses the same helper with `{remove: true}` entries for created files.

### Startup probe (fail closed)

When a tools user is set, the service does not start unless:

1. `sudo -n -u T -- /usr/bin/id -u` succeeds and returns a uid that is neither
   0 nor the service uid.
2. `sudo -n -u T -- /usr/bin/test -r <state dir>` fails. The tools user must
   not be able to read Salaam state.
3. On Linux only: the platform is Linux. macOS standalone installs keep the
   single-user mode. The flag is rejected there with a clear error.

The probe result (name, uid) is the service's tool identity.

### Provenance

`session.created` records `tool_execution: { mode, user, uid }` for every new
local workspace session. Each `local.*` result records `tool_uid`. A command
result's `isolation` changes from `local-user-no-os-sandbox` to
`tools-user-no-os-sandbox` when the tools user is active. `/v1/health`
exposes `tool_execution`. The approval text names the user the command will
run as.

### Host setup (one time, root)

```
useradd --system --create-home --home-dir /var/lib/salaam-tools --shell /usr/sbin/nologin salaam-tools
groupadd salaam-work
usermod -aG salaam-work salaam
usermod -aG salaam-work salaam-tools
chgrp -R salaam-work /home/salaam/work
chmod 2770 /home/salaam/work            # setgid keeps the group on new files
setfacl -m u:salaam-tools:x /home/salaam # traverse only; no listing
echo 'salaam ALL=(salaam-tools) NOPASSWD: ALL' > /etc/sudoers.d/salaam-tools
chmod 440 /etc/sudoers.d/salaam-tools
```

The tools user is not in `sudo`, `docker`, `stk` or the service user's
primary group. Restart the service with `--tools-user salaam-tools`.
Workspaces created afterwards must have the `salaam-work` group and mode
`2770`.

### What the tools user cannot do

- Read `~salaam/.config/**` (mode 700 and 600; the tools user is "other").
- Read Salaam state (mode 700; the startup probe checks this).
- Read `/proc/<daemon pid>/environ`. The kernel requires same uid or
  `CAP_SYS_PTRACE`.
- Connect to the operator or bridge sockets. They sit in the 700 state
  directory.
- Reach the stk broker socket (not in group `stk`) or Docker (not in group
  `docker`).

It can still read world-readable files: in the service home after the
traverse ACL (`.bashrc`, `.profile`, `.gitconfig`), and the Salaam package
under `~/.local/lib`. It can also use the network. Keep secrets at mode 600.
This change is about credential separation. It is not a sandbox.

## Tests (red then green)

Unit (all platforms, with an injected launcher):

- With a tool identity, a command is started through the launcher argv, and
  the result records `tool_uid` and the tools isolation label. Without the
  launcher code, the fake launcher marker is missing and the test fails.
- Edits go through the helper launcher.
- Unset: health and the startup path return the shared-user warning.
- `session.created` records `tool_execution`.

Integration (Linux only, `SALAAM_TEST_TOOLS_USER` set, real sudo; skipped
otherwise with an explicit reason). A CI job creates the user and the sudoers
rule on the runner:

- `id -un` prints the tools user.
- `cat` of a 600 file owned by the service user fails with permission denied.
- A command writes a file in a shared-group workspace, and the service user
  reads it.
- A reviewed edit creates a file owned by the tools uid, and the service can
  diff it.
- A timed-out command's process group is killed.

## Non-goals

- Reads through `salaam_workspace` stay with the service user. They are
  path-confined: no hidden paths, symlinks or private names, and the path is
  resolved against the workspace root. They run no code. Moving them to the
  tools user is a follow-up if a read-path escape is found.
- Network egress control for the tools user.
- Docker-backed coding commands, which are already isolated.
- Operator-declared MCP servers, which are tracked separately.
