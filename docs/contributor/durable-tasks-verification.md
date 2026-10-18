# Durable Tasks contributor notes

## Scope and proofs

`task-recovery` covers the original explicit-admission boundaries. `task-completion`, `task-lifecycle` and `task-gates` independently exercise false completion/failing checks, stale workspace/profile evidence, shared budgets, human approvals, lost responses, daemon SIGKILL between steps/during compaction, active interruption, durable restore intents and newer human edits. The acceptance bundle repeats these four named groups three times, separately from operator and S1–S6 repetitions. Budget unit tests additionally prove legacy migration and parent/child reservations.

`npm run test:tasks:real` is opt-in and requires `SALAAM_TASK_REAL_SOCKET` and `SALAAM_TASK_REAL_SCRATCH` pointing to an already provisioned proven Docker backend. It uses pinned offline Pi, real guarded file changes and isolated `node --test`, including an initially failing test, TUI admission, detach/reconnect, daemon SIGKILL, a bound human approval and fresh final receipts. No provider credentials are needed. Fixture backend tests alone do not establish execution isolation. See [observed verification](verification.md) for actual platform/source identities. M12 schedules and jobs, live-provider behavior, new GUI acceptance and power-loss guarantees remain outside these task proofs.

For the separate two-machine rehearsal, provision a source-only checkout and pinned dependencies in the explicitly approved private VPS directory, then compile the test helpers locally:

```sh
npx --no-install tsc -p tsconfig.json
node scripts/task-remote-rehearsal.mjs --host APPROVED_ALIAS \
  --repo /home/USER/.cache/salaam-m10.ID/m11-CHECKOUT \
  --node /home/USER/.cache/salaam-m10.ID/node-v26.7.0-linux-x64/bin/node
```

The script never provisions a server or copies credentials. It requires the existing native Docker socket, creates its own offline service and owned fixtures, drives the real remote TUI through SSH, kills that service between steps, reconnects for human review, verifies fresh completion, and removes its disposable state/workspaces/containers. It retains a source/backend-bound report and captured terminal cells under `.state/evidence/m11`.
