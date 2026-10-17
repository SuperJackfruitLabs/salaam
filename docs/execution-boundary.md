# M9.1 execution boundary

The selected spike backend is **a broker-managed Linux Docker container using runc and cgroup v2**, reached through an explicit private Unix socket. macOS uses a local Linux VM. M9.1 implements fixed operator-run probes, not a model command tool. The service health response reports `execution.available=false` and `coding_tools=false`; parent and child tool inventories remain unchanged.

The broker uses Docker Engine API **1.47** directly. It does not invoke a host shell or Docker CLI, load Docker contexts/configuration, forward host environment variables, pull images, or provision a VM. The operator provisions the backend and image before the proof. Missing engines/images, degraded daemon controls, configuration drift and unconfirmed cleanup fail closed with a nonzero CLI exit.

## Trust and threat model

Treat repository contents, model output and any eventual repository command as untrusted. Trust the operator account, Salaam broker/build, selected image, Docker daemon, runc, VM/hypervisor and Linux kernel. Engine access is privileged authority and stays on the broker side. A compromised daemon, container escape through a kernel/runtime vulnerability, another process acting as the same trusted operator, physical access and hardware side channels are outside this proof.

The proof uses freshly allocated canaries rather than real credentials or service state. Its private sibling directory contains readable credential/journal/home-key canaries and three real, positively checked Unix sockets representing operator, bridge and engine control. Absolute and relative workspace symlinks target those canaries. Only the disposable workspace is mounted into the container. Passing these probes is evidence for this profile on the observed backend, not a general claim that arbitrary containers are safe.

Docker describes daemon authority, filesystem mounts and kernel controls as separate security considerations in its [security documentation](https://docs.docker.com/engine/security/). The broker uses [create before start](https://docs.docker.com/reference/cli/docker/container/create/) so it can inspect the effective configuration before any payload runs. It retains Docker's [built-in seccomp profile](https://docs.docker.com/engine/security/seccomp/) and also checks seccomp, capabilities and no-new-privileges inside the running container.

## Fixed policy

| Concern     | M9.1 contract                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image       | BusyBox `1.37.0-musl`, OCI index `sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092`; no tag resolution/pull during a proof                                    |
| Filesystem  | Read-only image root; one writable `/workspace` bind, private propagation, nonrecursive; no home, service state, credentials, control sockets, host devices or image-defined volumes |
| Scratch     | `/tmp` tmpfs: 16 MiB, noexec/nosuid/nodev, UID/GID 65532, mode 700; `/dev/shm` 8 MiB                                                                                                 |
| Identity    | UID/GID `65532:65532`; all Linux capabilities dropped; no-new-privileges; built-in seccomp; private PID/IPC/UTS/cgroup namespaces                                                    |
| Network     | `none`, no published ports, host namespace, links, extra hosts or attached network; only loopback is present; metadata/public-address connection attempts fail                       |
| Environment | Explicit `HOME=/tmp` and fixed `PATH`; Docker supplies the fixed container hostname and the shell adds its own PWD/SHLVL; no ambient key/token/socket/proxy variables                |
| Resources   | 128 MiB memory with no additional swap, 0.5 CPU, 32 PIDs, 64 open files, 1 MiB per-file size, no core dumps                                                                          |
| Output      | Local daemon logging with one 1 MiB rotation file, compression disabled; broker HTTP responses capped at 256 KiB, decoded command output at 64 KiB; malformed/oversized frames fail  |
| Lifetime    | No daemon auto-restart; ordinary proof waits have a 10-second wall deadline; timeout/output failure leads to forced removal and an empty-owned-set check                             |

The profile digest binds the fixed configuration, image and probe scripts. The daemon's effective configuration is checked after create and again against the original saved workspace/configuration immediately before start. In the live negative probe, changing the daemon-side memory limit causes denial while the container is still `created`.

## Lifetime and recovery

Before engine mutation, the harness fsyncs a report containing its run UUID. A failed report write prevents engine contact. Every container carries the reserved run/profile labels. A lost create response is not retried; cleanup discovers the possibly created container by the saved run identity. Removal verifies ownership by full container ID and labels, forces container termination, and then checks that the owned set is empty. Failure to confirm cleanup makes the proof fail and retains its scratch directory for reconciliation.

The lifecycle proof starts a detached child inside a container from a separate broker process, waits for the child's own ready marker, kills that broker with SIGKILL, then uses a replacement broker to remove its container. It waits beyond the child's delayed write and checks that no write occurred. No command is replayed.

**Broker death does not itself impose a daemon-side wall deadline.** Fixed probes have bounded programs; an orphan can survive until reconciliation. M9.3 must persist command identities and reconcile or mark interrupted/unknown work before enabling arbitrary execution. The cleanup command can remove a saved run from an older profile revision; it cannot start that work.

## Run the proof

Use the repository's pinned Node/npm versions and build first. The ordinary `npm test` suite uses offline engine fixtures and never pulls or starts containers. The separate Linux CI job provisions this exact public image and requires the real proof to pass; an unavailable engine is a failure rather than a skipped success.

On an already provisioned local Linux engine:

```sh
docker image pull docker.io/library/busybox@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
mkdir -p /tmp/salaam-boundary
npm run verify:execution -- --docker-socket /var/run/docker.sock \
  --scratch-root /tmp/salaam-boundary --report .state/evidence/execution/linux.json
```

For the observed macOS path, use a dedicated Colima profile with only the scratch root shared. Do not mount the home directory or repository into this proof VM. The initial observed tools were Colima 0.10.3 and macOS Virtualization.framework (`vz`), with Docker Engine 29.5.2, runc 1.3.5 and Linux 6.8.0-117-generic arm64 inside the VM. The profile does not activate a different global Docker context:

```sh
mkdir -p /private/tmp/salaam-m9-boundary
colima start salaam-m9 --activate=false --template=false --cpu 2 --memory 2 \
  --disk 10 --mount /private/tmp/salaam-m9-boundary:w \
  --ssh-agent=false --ssh-config=false --port-forwarder=none
docker --host "unix://$HOME/.colima/salaam-m9/docker.sock" image pull \
  docker.io/library/busybox@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
sal execution prove --docker-socket "$HOME/.colima/salaam-m9/docker.sock" \
  --scratch-root /private/tmp/salaam-m9-boundary \
  --report .state/evidence/execution/macos.json
```

The first Colima initialization on this host required completing its VM user Docker-group setup and a VM restart before private socket forwarding worked. This is infrastructure setup, not an application fallback. Inspect a failed report and repair the backend before rerunning.

If the proof is killed or cleanup cannot be confirmed, preserve the report/run UUID and use the same engine:

```sh
sal execution cleanup --docker-socket /path/to/docker.sock --run-id UUID_FROM_REPORT
```

The report records operator platform/Node, engine/kernel/runtime versions, image identity, profile and compiled-source digests, individual checks, exit/log evidence and cleanup outcome. Reprovisioning/changing an engine, image or profile requires a fresh proof. This report does not enable a service capability.

## Gate for subsequent work

Observed on **2026-10-17**: all **15 real-engine checks passed** on macOS arm64 → Colima/vz → Linux arm64. The [saved report](evidence/m9.1-colima-arm64.json) binds compiled-source digest `13d388dd2b5f23cb72a363b6000b062a8af5d854073c28f4f18e0f31498d0a29` and profile digest `1231b5f2b573d62082204bf279d6320b3d75a7387e6d0e2f63b924b5f5a34d01`. Cleanup was confirmed. The offline suite passed **132 tests**, and format/type/Pi-pin verification passed. These results do not claim a native Linux x64 CI run or the later coding milestones.

M9.1 permits proceeding to M9.2 on the observed local VM backend once the real proof and offline regressions pass. Native Linux x64 and other VM/runtime versions require their own reports. A CI definition alone is not evidence of a passing run.

Before coding tools become available, M9.2/M9.3 still need owned workspace identity/revisions, safe file admission and metadata protection, workspace storage limits, managed bridge/ledger integration, durable command handles/logs, recording-failure admission gates and restart reconciliation. The writable workspace is not a rollback mechanism or a total disk quota. The per-file size cap does not cap aggregate workspace writes. The model must never receive mounts, daemon flags, environment overrides or executor credentials as tool parameters. A new tool image or network-enabled profile needs a separately reviewed and proven policy.
