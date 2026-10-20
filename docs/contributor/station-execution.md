# Protected station execution contract

Station execution is a separate, explicit host profile. It preserves the existing
owned-copy coding mode. It does not turn an AgentPod workspace into a writable
mount for a model's shell, and older AgentPod manifests cannot enable it by adding
unknown fields.

The first profile is `linux-systemd-station-v1`: a Linux system service host with
systemd, cgroups v2, a root-owned Salaam controller, and an operator-reviewed
runtime image root. Commands use a dynamic OS user. Other hosts must refuse this
profile; the ordinary session, HTTP MCP and native Toolkit profiles retain their
existing platform support. Running the controller as root does not give the model
a root shell: Pi exposes only the managed bridge tools, and command execution uses
the separate unit boundary below.

## Private admission

`station_config` in an AgentPod host-plan input points to an owner-only, version-1
JSON document containing:

- `kind`: `linux-systemd-station-v1`.
- `workspace` and `workspace_identity`: the exact admitted path and its device/inode
  fingerprint. A replaced root requires new admission.
- `files`, `systemd_run`, `systemctl`: canonical absolute executable paths and
  their exact `sha256` values.
- `runtime_root`, `runtime_fingerprint`, `runtime_image_digest`: the reviewed
  runtime tree, its filesystem metadata fingerprint and its recorded OCI image
  digest. A metadata fingerprint detects drift; it does not independently verify
  an asserted image origin. Preparation must verify and record the actual image.

The host plan emits schema 5, with `station_execution.config` and
`station_execution.configuration_digest`. Managed HTTP and native Toolkit may be
included through their existing private references. Schemas 2, 3 and 4 keep their
previous meanings. The node startup receipt remains version 1 and binds the whole
host manifest, while daemon health reports the station configuration digest.

The configured Go node binary supplies the private `salaam-station-files-v1`
entry point. It reads one closed JSON request on stdin without loading enrollment
credentials. Actual versioned metadata discovery and a real command-boundary
probe precede station readiness. An executable path, its hash, or the existence
of a systemd service alone cannot establish readiness.

## Files and large repositories

The file primitive uses Linux `openat2` with beneath-root, no-symlink, no-magic-link
and no-mount-crossing resolution. Regular files must have one link. Special files,
path traversal, symlink escapes and hardlinks are rejected. Credential/control
directories, provider homes, `.env` files, `.git`, dependency environments and
known private key files are excluded. The workspace cannot contain the controller's
home, runtime, configuration or state.

Indexing reads bounded metadata, rather than injecting file contents into model
context. It supports up to 100,000 files and 120,000 entries, including a 50,000-file
acceptance repository. Listings and literal filename searches return 40 entries; text reads return scalar-safe
pages with an exact content hash. A metadata revision is distinct from a file's
content hash. Individual text reads are bounded at 256 KiB and proposed edits at
16 KiB. These limits belong to this profile and do not raise the owned-copy limits.

A patch binds the execution root, configuration, worker epoch, attempt, tool-call
ID, complete proposed bytes, observed tree revision and exact prior file hash.
Creation uses a null prior hash; deletion uses null content. The existing durable
human decision surface presents this workspace-specific permission. A decision
cannot authorize a different payload, target, revision, run or operation kind.

The controller journals dispatch intent and the actual private helper PID/start
identity before sending its request. The helper has a bounded admission deadline
and parent-death handling. It rechecks metadata and file content before its atomic
namespace operation. An existing human edit is refused. A detected race during
replacement preserves displaced bytes and leaves an uncertain result for
reconciliation; it cannot justify a blind second write. The threat boundary is
untrusted model commands, not an adversarial host administrator.

The producer returns actual observed content and revision receipts, which the
consumer validates. Only the owning controller can commit a verified local result.
An interrupted helper, malformed receipt, missing PID record or unconfirmed stop
never becomes a successful patch because the model says it finished. Saved call
IDs precede fresh grants. Explicit operator attestation remains a separate fact
from an original unknown result.

## Commands and broker routing

A check uses a filtered, immutable snapshot of the reviewed actual root, bounded
at 512 MiB. Copying streams file bytes and rechecks source metadata. Commands see
that snapshot at `/workspace` through a read-only bind. Their temporary writes
stay in private temporary storage. A check passes only with a zero exit status,
confirmed cleanup and an unchanged actual source revision. Generated command
files are not silently integrated or published as source artifacts.

The transient systemd unit fixes `RootDirectory`, dynamic user, private network,
private devices and temporary storage, hidden foreign processes, empty capabilities,
no-new-privileges and read-only system/control paths. The command environment is
cleared. Its limits are 512 MiB memory, zero swap allowance, 64 tasks, one CPU,
30 seconds and 64 KiB output/per-file size. Private temporary filesystems cap
`/tmp` at 64 MiB/4,096 inodes and `/var/tmp` at 16 MiB/1,024 inodes. A daemon allows at most two active station checks;
one root serializes its file/command work. One attempt may prepare at most 32
station mutations/checks.

Commands have no network access, provider keys, node credentials, control sockets
or Docker socket. Managed HTTP MCP and native Toolkit execute in the trusted
daemon through the separately admitted station assignment/broker. Setting proxy
variables only on ACP is insufficient. Commands cannot bypass the broker through
`NO_PROXY` or a sibling station endpoint because this command profile grants no
network path. Online package installation and arbitrary command networking are
not part of this first profile.

## Recovery and cancellation

Journal schema 26 records station calls, private helper ownership and systemd unit
intent, configuration, invocation and cgroup identities. Launching, running,
unconfirmed and stopped resources remain distinguishable. A unique unit name plus
the exact context description binds inspection and stopping to its recorded owner.
Reused invocation identities are rejected. Actual empty-cgroup observation is the
stop receipt; an empty in-memory job map is not.

Worker loss, explicit turn cancellation, root revocation and lease expiry commit
station tombstones before asynchronous cleanup. Fresh grants recheck the root and
task controls. A reconnect resumes saved calls, rather than submitting another
patch or command. Startup stops or fences inherited resources before advertising
readiness. Unknown writes remain unknown until their owning operator settlement;
stale or missing command results remain failed checks. Cleanup does not require a
new work lease. Required cleanup failure retains the parent fence and service
state ownership.

The private request corpus is owned in AgentPod's
`internal/stationfs/testdata/salaam-station-files-v1.json` and mirrored in Salaam.
The Go producer exercises its request cases; the TypeScript consumer exercises its
receipt cases. These are different assertions. Real kernel, process, systemd,
actual Pi, authenticated node/proxy and scoped Claude/Library acceptance must be
recorded separately; a fixture or a successful protocol reply does not establish
live product or fleet acceptance.
