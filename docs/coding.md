# Coding in a container

File tools are available in explicitly created coding sessions. Commands require the configured executor to pass its startup proof. Ordinary sessions and read-only children do not receive these coding tools.

Most work happens in your own checkout with `salaam code`, under
[permissions](permissions.md) and the [sandbox](sandbox.md). This page covers the
separate `--coding` mode: the agent edits a private copy of the project and runs
commands in a pinned Docker container that sees only that copy. You review the
result as a diff and apply it yourself.

## Setup

[Install Salaam](install.md) with the pinned Node/npm runtime. Create a private, persistent coding root outside the source checkout. File tools need `--coding-root`; commands also need an explicit local Docker Unix socket and the pre-provisioned pinned Node image.

```sh
mkdir -p "$HOME/.local/share/salaam-coding"
chmod 700 "$HOME/.local/share/salaam-coding"
docker image pull docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
sal service start --state "$HOME/.local/state/salaam-coding" \
  --provider anthropic --coding-root "$HOME/.local/share/salaam-coding" \
  --coding-socket /var/run/docker.sock
sal session create --state "$HOME/.local/state/salaam-coding" --cwd /path/to/project --coding
sal attach SESSION_ID --state "$HOME/.local/state/salaam-coding"
```

The existing local Claude credential is used by the provider worker and stays outside command containers. The separate state path above preserves another running daemon/session.

On macOS, use a dedicated Colima Linux VM and share only the coding root at the same absolute path. See [security and isolation](security.md) for the backend trust model.

```sh
colima start salaam-coding --activate=false --template=false --cpus 2 --memory 2 \
  --mount "$HOME/.local/share/salaam-coding:w" --ssh-agent=false --ssh-config=false
docker --host "unix://$HOME/.colima/salaam-coding/docker.sock" image pull \
  docker.io/library/node@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
# Pass --coding-socket "$HOME/.colima/salaam-coding/docker.sock" to service start.
```

Startup proves the Node image's non-root identity, capability/seccomp controls, environment exclusion, network namespace, read-only source and writable private copy. It fsyncs `executor-proof.json` in service state before accepting clients. Engine/image/control failures deny startup. Creation rechecks engine/kernel identity and the effective container configuration before starting code. Image pulls and VM provisioning are operator setup.

## Workspaces and file tools

`--coding` imports an owned copy. Git/Salaam metadata, dependency/build folders, `.env` files and credential directories are excluded. Symlinks, hardlinks, special files, traversal and case-colliding paths are rejected. Initial limits are 512 files, 2,048 entries, 4 MiB total, 256 KiB per file, 16 path components and 32 workspace revisions. Directory enumeration and file reads are bounded.

The parent receives `salaam_files`: `inspect`, paginated `list`, literal `search`, line-referenced UTF-8 `read` and `patch`. A patch requires the current workspace revision and exact file hash. `expected_hash=null` creates a file; `content=null` deletes one. Repeating a tool-call ID returns its saved receipt before a new revision check.

Each patch journals intent and a fsynced target snapshot, writes a fresh private directory, then commits the new root/revision/digest and completion event together. Published roots are never rewritten by patches. Crash recovery compares actual staged bytes and the original root; it does not replay writes. Incomplete staging is a failed application; conflicting original content blocks publication and preserves both directories. Recording failure prevents new mutations or command dispatch.

The workspace ID stays stable while its materialized root path changes. Earlier directories are retained within the revision/storage bound. An editor writing an older directory retains those bytes. Inspect the current root before opening files directly. Current-root edits need an explicit reviewed refresh:

```sh
sal workspace inspect SESSION_ID --state STATE_DIR
sal workspace diff SESSION_ID --state STATE_DIR
sal workspace refresh SESSION_ID --state STATE_DIR \
  --revision CURRENT_REVISION --digest REVIEWED_OBSERVED_DIGEST
```

The diff compares the initial import with the current revision and emits whole-file unified text hunks, including missing-final-newline markers. Binary/control-character changes are identified without printing terminal controls. Review this result before applying it to the original checkout using your normal Git workflow. Salaam leaves that checkout unchanged.

## Durable commands

The `salaam_command` tool and operator CLI share the same service ledger:

```sh
sal commands start SESSION_ID --state STATE_DIR --step-key test-v1 \
  --command 'node --test' --revision CURRENT_REVISION
sal commands inspect SESSION_ID --state STATE_DIR --run-id RUN_ID
sal commands logs SESSION_ID --state STATE_DIR --run-id RUN_ID --offset 0
sal commands cancel SESSION_ID --state STATE_DIR --run-id RUN_ID
sal commands reconcile SESSION_ID --state STATE_DIR --run-id RUN_ID
```

A session-scoped step key binds command, relative cwd and workspace revision. A duplicate returns the original run ID/outcome across reconnect. Changed arguments under that key are rejected; new intended work uses a new key.

Commands run in a disposable writable copy of a captured snapshot. The source mount is read-only; durable edits use the file tool. Tests/builds can write their private copy, which is discarded at cleanup. The pinned Node 26.7.0 image supplies Node/npm. Third-party packages are not automatically installed and networking is disabled. Other language/dependency images need their own provisioning, pin and proof.

| Control            | Fixed command profile                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Identity           | UID/GID 65532, all capabilities dropped, no-new-privileges, built-in seccomp                                |
| Filesystem         | Read-only image and source; work tmpfs 32 MiB/4,096 inodes; scratch tmpfs 16 MiB                            |
| Network/namespaces | `none`; private PID/IPC/UTS/cgroup namespaces                                                               |
| Resources          | 256 MiB memory, no additional swap, 0.5 CPU, 32 PIDs, 64 open descriptors, 1 MiB files                      |
| Admission          | Two commands per service, one per workspace; captured workspace revision/digest and profile/engine identity |
| Output/runtime     | 64 KiB captured output with byte offsets; persisted 30-second broker deadline                               |

Engine mutations follow committed intent. Container and exec IDs are journaled before launch. Actual engine exit status and confirmed removal determine completion. A model final message cannot establish success. Cancellation commits before forced removal of the container and its descendants. Deadline/output failures also require cleanup. Captured output prefixes cannot silently change.

Restart resumes observation of a known execution under its original IDs. Ambiguous create/launch boundaries are reconciled or marked interrupted; commands are never blindly resent. Backend/cleanup uncertainty blocks new grants and invalidates readiness. Restore the original backend/profile and reconcile the saved run. Starting without an executor preserves its recovery phase.

The wall deadline requires a running broker; Docker has no separate daemon-side TTL here. After broker death, bounded container work can survive until restart reconciles its persisted deadline.
