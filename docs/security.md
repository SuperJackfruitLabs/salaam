# Security and isolation

Salaam is designed for one trusted OS account. Private Unix sockets and
permission-protected state directories separate its host-local control surface
from other accounts. They do not isolate hostile programs running as the same
user. There is no public multi-tenant listener.

## Credentials and providers

Live providers are opt-in. Only the selected provider authentication reaches a worker over the private bridge and kept out of
operator replies, journal events and command arguments. Saved credentials are
plaintext files protected by OS permissions; use the service user's private
credential store, never a coding workspace. The provider endpoint and tool
inventory are fixed by the admitted session route. OAuth refresh is serialized across processes. ChatGPT subscription routes without provider-enforced output caps require an explicit token-budget opt-out for durable tasks. Unsupported token caps are rejected before dispatch. Request counts, child reservations, runtime, concurrency, and approval controls remain active without a token budget.

## Tool execution user

By default, approved `salaam_local` commands and edits run as the Salaam
service user. That user also holds the provider credential, so an approved
`cat ~/.config/salaam/kimi.env` would return the key. With a live provider, startup warns about this,
and `/v1/health` reports `tool_execution.mode: "service-user"`.

On a shared or production Linux host, run tools as a separate unprivileged
user:

```sh
salaam service start --tools-user salaam-tools   # or SALAAM_TOOLS_USER=salaam-tools
```

Every local command (`sudo -n -u salaam-tools -- setsid -w /bin/sh -c ...`),
reviewed edit and undo then runs as that user. The daemon, Pi worker, provider
calls, state and config stay with the service user. The service gets no
capability. It may become only the tools user, through one runas-restricted
sudo rule. Startup fails closed unless the switch works and
the tools uid is neither 0 nor the service uid. Startup also fails if the tools
user can read the state directory. `session.created` and every local result
record the `tool_uid`. Command results report `isolation:
"tools-user-no-os-sandbox"`.

One-time host setup (root). Replace `salaam` and the workspace path with your
own:

```sh
useradd --system --create-home --home-dir /var/lib/salaam-tools \
  --shell /usr/sbin/nologin salaam-tools        # not in sudo, docker, stk or salaam
groupadd salaam-work
usermod -aG salaam-work salaam
usermod -aG salaam-work salaam-tools
chgrp -R salaam-work /home/salaam/work
chmod -R g+rwX /home/salaam/work
find /home/salaam/work -type d -exec chmod g+s {} +
chmod 2770 /home/salaam/work
setfacl -m u:salaam-tools:x /home/salaam        # traverse only, no listing
echo 'salaam ALL=(salaam-tools) NOPASSWD: ALL' > /etc/sudoers.d/salaam-tools
chmod 440 /etc/sudoers.d/salaam-tools
```

Restart the service after the group change so it picks up `salaam-work`. The
unit must not set `NoNewPrivileges=yes`, because sudo needs setuid.
Workspaces must be in the shared group with setgid directories. Tool commands
run with `umask 0002`, so Salaam can read their output and review diffs.

The tools user cannot read the service user's mode-700 config or state. It
cannot read the daemon's `/proc/<pid>/environ`, because the kernel denies that
across uids. It cannot reach the operator, bridge, stk or Docker sockets. It can
still read world-readable files, including the installed Salaam package and,
after the traverse ACL, files such as `~/.bashrc` in the service home. It can
use the network. Keep secrets at mode 600. This separates credentials. It is
not a sandbox. `salaam_workspace` reads stay with the service user and are
confined to the workspace path. Docker-backed `salaam_command` is unchanged.

## Workspace and command boundary

Coding sessions use owned workspace copies. Durable patches bind the expected
revision and content hashes. A model cannot choose host mounts, executor flags,
environment overrides or arbitrary engine endpoints.

Commands require an explicitly configured Docker backend that passes startup
probes. The fixed profile uses a non-root user, dropped capabilities, read-only
source/image mounts, private namespaces, disabled network, resource limits and
disposable writable copies. A successful fixture run does not establish isolation
on a different engine; prove the actual backend before enabling commands.

This is not a VM boundary. Treat Docker access and the local executor broker as
privileged host infrastructure. A compromised engine or trusted OS account is
outside the isolation guarantee.

Local commands (the `command` action of local coding) run under the host's OS
sandbox at `read-only` or `workspace-write` (the default):

- Linux uses bubblewrap: an empty root, the system read-only, a private `/tmp`,
  the workspace bound writable or read-only, and unshared namespaces.
- macOS uses Seatbelt (`sandbox-exec`) with a deny-by-default profile. It reads
  the system, developer tools, package prefixes, the workspace and a private tmp.
  It writes only the workspace (in `workspace-write`) and that tmp. It has no
  home directory, no mach services and no network. `/usr/bin/git` is Apple's
  shim, which needs Xcode's licence preferences, so commands get the real git
  from the active developer dir (`xcode-select -p`) first on `PATH`. git runs
  with `GIT_CONFIG_GLOBAL=/dev/null` unless the operator allows `~/.gitconfig`.

Toolchains outside the workspace are unreadable unless the operator lists them.
`local_sandbox_read_paths` in the host config (or `--local-sandbox-read` /
`SALAAM_LOCAL_SANDBOX_READ` for `salaam service start`) adds read-only paths; the
entry `toolchain` expands to the node running Salaam and, where present,
`~/.npm`, `~/.nvm`, `~/.cargo`, `~/.rustup`, `~/go`, `~/.gitconfig` and
`~/.config/git`. The root, home itself and any credential location (`~/.ssh`,
`~/.gnupg`, `~/.aws`, `~/.npmrc`, `~/.netrc`, keychains and others), or a path
above one, are refused. Host plan pins the resolved list in the manifest. A
listed path is never writable.

Neither sandbox gives network unless a check declares it. `full-access` runs the
command as is, and only when the operator chooses it.

A host with no usable sandbox refuses local commands. To run them unsandboxed
anyway, the operator sets `unsandboxed_commands: "allow"` in the host config,
or passes `--unsandboxed-commands allow` to `salaam service start`. Host plan pins that
choice in the manifest, and every approval says "unsandboxed". Edits are not
commands and are unaffected.

### Network through the broker allowlist

A sandboxed command can reach the network only when the host config sets
`command_network: "broker"` (optionally `command_network_socket`, default
`/run/stk/local-commands.sock`). Host plan pins it, and every approval says
"network: through the broker allowlist". The command still has no network of its
own. On Linux, bubblewrap keeps `--unshare-net`, and a relay inside the sandbox on
`127.0.0.1:3128` reaches only a socket Salaam binds in. On macOS, Seatbelt allows
one outbound connection, to Salaam's relay on loopback. `HTTP_PROXY` and
`HTTPS_PROXY` point at that relay.

Salaam's relay runs outside the sandbox. It forwards each connection to stk's
`local-commands` socket, where the host operator's `egress.hosts` list decides,
and it records what was reached and refused in the command result. A refused
host's reason, in stk's words, is added to the output. Tools that ignore proxy
settings (`ssh`, UDP, direct DNS) stay blocked. With the broker socket missing,
the command runs with no network and its result says the broker was unavailable.

## Approvals and recovery

Approvals bind the target, normalized arguments, expected target version, policy,
worker epoch and expiry. A stale displayed diff or previous approval cannot grant
a different operation. Required-control failures deny new grants.

Cancellation stops future dispatch but does not undo external effects. Missing
receipts remain unknown until reconciled. A workspace checkpoint restores only
owned changes; it is not rollback for external systems.

For operational details, see [coding](coding.md), [session operations](service-reference.md),
[host supervision](host-operation.md) and [limitations](limitations.md).
