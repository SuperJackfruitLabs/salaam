# A persistent home for agent work

Salaam is a session service for terminal coding and unattended work. The service
owns task state, approvals, receipts and recovery while a pinned Pi worker owns
the conversation. The terminal, SSH and ACP editor clients share that same service.

**Start here:** [Install Salaam](install.md) → [your first session](quickstart.md)
→ [configure Claude](providers.md).

## Work you can return to

- [Terminal](tui.md): Night and Paper themes, session switching, changes, commands and approvals.
- [Coding](coding.md): owned workspace copies, hash-bound patches and isolated commands.
- [Tasks](durable-tasks.md): checked plans, budgets, checkpoints and explicit completion checks.
- [MCP servers](mcp.md): declare stdio and HTTP servers for the service; a workspace can never add one.
- [Jobs](jobs.md): durable occurrence identities, recurring templates and missed-run policies.
- [Host operation](host-operation.md): reviewed manifests, supervisor recovery and the operator inbox.

## Before unattended work

Read [recovery and limitations](limitations.md). Detaching leaves work running;
daemon death interrupts dispatched work and requires an explicit continuation.
Unknown external outcomes stay unknown until reconciled. Model text cannot mark
a checked task successful.

The default provider is offline. Claude is opt-in and billable. Coding commands
require a proven Docker backend; a private Unix socket assumes one trusted OS user.
