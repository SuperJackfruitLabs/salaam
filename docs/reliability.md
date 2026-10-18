# Reliability and support

Salaam records accepted instructions, task state, approvals and operation receipts
in a host-local journal. Client reconnects and service restarts have different
recovery rules. Understand that distinction before leaving work unattended.

## What reconnecting preserves

Detaching closes a client. The service keeps admitted work running. A reconnect
reads committed events and follows the same session; it does not submit an old
instruction again. A private client outbox retries unresolved submissions with
their original request IDs.

Worker or service death interrupts work already dispatched. An interrupted attempt
requires explicit continuation after inspection. Queued work keeps its identity;
recovery does not treat an uncertain model response as permission to retry.

## What completion means

A conversation reply is a model response, not a guarantee that code or an external
effect succeeded. A checked task needs fresh acceptance evidence bound to its
workspace and execution configuration. Approvals apply to the operation reviewed,
and uncertain effects need reconciliation before further work.

## Supported environment

The supported runtime is Node 26.7.0 on macOS and Linux. Command execution uses
a proven Linux Docker backend; macOS needs a local Linux VM or a remote host.
Other runtimes, Windows, hostile same-user programs, untested engines and power-loss
durability are outside the supported claims. Offline checks do not validate your
Claude credentials, billing or unattended live-model behavior.

## When something gets stuck

Inspect the session, task, operation, command or inbox item before changing it.
Use the matching recovery action and stable request identity. Do not delete a
journal or recreate an occurrence to make an uncertainty disappear. Preserve a
private stopped-service backup before upgrades or repair.

For a bug report, include the Salaam and Node versions, OS, command, and a minimal
reproduction. Redact API keys, prompts, private paths and session content before
sharing logs. Report issues through the
[repository](https://github.com/SuperJackfruitLabs/salaam/issues).

See [recovery limitations](limitations.md), [security](security.md), and
[safe upgrades](install.md).
