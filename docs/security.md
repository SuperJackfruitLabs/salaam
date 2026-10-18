# Security and isolation

Salaam is designed for one trusted OS account. Private Unix sockets and
permission-protected state directories separate its host-local control surface
from other accounts. They do not isolate hostile programs running as the same
user. There is no public multi-tenant listener.

## Credentials and providers

Claude is opt-in. Its key is supplied to live provider workers and kept out of
operator replies, journal events and command arguments. Saved credentials are
plaintext files protected by OS permissions; use the service user's private
credential store, never a coding workspace. The provider endpoint and tool
inventory are fixed by the admitted session route.

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

## Approvals and recovery

Approvals bind the target, normalized arguments, expected target version, policy,
worker epoch and expiry. A stale displayed diff or previous approval cannot grant
a different operation. Required-control failures deny new grants.

Cancellation stops future dispatch but does not undo external effects. Missing
receipts remain unknown until reconciled. A workspace checkpoint restores only
owned changes; it is not rollback for external systems.

For operational details, see [coding](coding.md), [session operations](service-reference.md),
[host supervision](host-operation.md) and [limitations](limitations.md).
