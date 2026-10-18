# Coding contributor notes

## Acceptance and observed scope

Default tests remain offline, with no image pulls or real credentials. `npm run test:coding -- --docker-socket PATH --scratch-root SHARED_DIR` separately runs ten versioned repository tasks: discovery, precise edit/crash recovery, multi-file changes, test failure/repair, new module, deletion, human conflict, authority boundaries, daemon SIGKILL/reconnect and descendant cancellation/output/runtime limits.

Reports under `.state/evidence/coding/` record fixture/build/backend identities, captured input snapshots, final trees/digests, real exit/output receipts, events, interventions and cleanup. Linux CI provisions the pinned images and runs the portfolio alongside M9.1. Existing macOS/Linux acceptance jobs retain S1–S6. Only observed job results count as platform evidence.

The Claude evaluation had an approved eight-request total budget and 1,024 maximum output tokens per request. An autonomous clamp fix used five requests. A supplied-patch integration check used the remaining three after immutable revision publication was introduced. Both preserved the tests and passed a separate operator-run behavioral check. These are small functional observations; a matched plain-Pi performance comparison has not been run.

Observed command backends are macOS arm64 → Colima/vz → Linux arm64 and native Linux x64 CI. The [verification record](verification.md#m9-guarded-coding-observations--2026-10-17) binds both to their build/backend identities. Host-local reconnect and daemon replacement are proven. The separate M10 SSH/editor and M12 job pilots cover two-machine operation. TUI, task-level verification/budgets/checkpoints and unattended scheduling are implemented in M10–M12; each has its own source-bound evidence. The existing user daemon is not automatically restarted or reconfigured by this implementation.
