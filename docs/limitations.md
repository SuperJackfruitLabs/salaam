# Recovery and limitations

Salaam is early software. These boundaries apply to the current implementation.

## One trusted operator account

Private directories and Unix sockets enforce an OS-account boundary. They do not
isolate hostile programs under that same account. There is no public multi-tenant
listener or web authentication layer. SSH uses an existing authorized host; it
does not provision servers or copy credentials.

## Detach, interruption and unknown outcomes

Detaching closes a client and leaves admitted work under the service. Reconnecting
replays history without resubmitting prompts. A flushed client outbox retries the
same request identity after an unknown response.

Worker or daemon death interrupts dispatched attempts. They are never automatically
replayed: inspect them and explicitly continue. A Pi transcript's final answer is
not by itself a service completion receipt.

An external effect may have happened before a lost response or cancellation.
Unknown outcomes stay unknown until lookup or recorded operator resolution.
Cancellation revokes future dispatch but cannot undo prior effects. Inbox
acknowledgement does not approve work, retry it or certify success.

## Coding and unattended work

Filesystem tools require an explicit owned coding root; commands also require a
proven Docker backend. Changed task/job scope cannot silently widen authority.
Regenerate reviewed host manifests after code or runtime changes.

Checked tasks need actual verification evidence. Progression is opt-in and bounded.
Recurring jobs use immutable templates and fresh occurrence workspaces with explicit
overlap and missed-slot rules; they are not unbounded background cron commands.

## Providers and installation

Claude requests are billable; request/output limits do not cap currency spend. The
saved key is permission-protected plaintext. Offline tests do not validate live
provider availability.

The runtime is exactly Node 26.7.0 on macOS and Linux; Windows is untested. State
schemas migrate forward. Keep stopped-daemon backups and use matching packages
when restoring. A source change does not update a running service.

See [reliability and support](reliability.md), and
[installation](install.md) for upgrades.
