# Session service architecture

The operator API and private worker bridge share a service process. Pi runs in a separately supervised process, with a managed agent directory, explicit session identity, pinned house extension, builtin execution tools and MCP disabled, and one offline provider route.

```mermaid
flowchart LR
    CLI[Operator CLI] --> API[Local socket API]
    API --> DB[(SQLite journal)]
    API --> SUP[Worker supervisor]
    SUP --> PI[Pi RPC process]
    PI --> EXT[House extension]
    EXT --> BRIDGE[Authenticated worker bridge]
    BRIDGE --> DB
    BRIDGE --> SUP
```

Pi owns the conversation tree. Salaam imports read-only entries, cursors and active-leaf references after a diagnostic settles. Salaam owns session lifecycle, accepted inputs, request responses, artifact references and ordered durable events. It does not maintain an independently editable model transcript.

## Readiness and grants

Each start allocates a new durable epoch. The worker receives a fresh private credential and context nonce. Its manifest must match the service's protocol, package/extension bundle digest, policy digest, session identities, capability set, tool set and provider route. A subsequent RPC state query confirms the actual Pi session path and selected model.

No diagnostic prompt is sent until readiness commits. Every provider admission validates the actual outgoing task-context frame. Every tool checks policy, and the tool implementation obtains its own service grant before reporting success. Nested tool failures invalidate readiness. A manifest claim alone does not supply isolation: the house extension and pinned bundle are trusted code, with runtime failure tests covering those boundaries.

The bridge compares worker credentials and epochs. A persistence failure prevents a grant and revokes readiness in memory even if the unhealthy state cannot be written. The operator's inspection includes that live failure, so a stale persisted `ready` row cannot mask the denial.

## Persistence and delivery

SQLite transactions include both the mutation and its event. Durable request IDs return saved responses after retries, even if the original revision has advanced. SSE subscribes to commit notifications and catches up from the database; client connections never own worker lifetimes.

Artifacts are written, flushed and renamed before their references commit. Their content digest is checked on read. SQLite and Pi JSONL remain separate persistence domains; these tests establish process-crash behavior, not universal host-loss recovery.

The service lifetime lock is held by a separate SQLite rollback-journal connection. This remains locked even while ordinary journal transactions commit, and the OS releases it when the process dies. The service keeps that lock handle reachable until shutdown.

## Process recovery

Pi processes get their own process groups and a name containing the session, epoch and unique service boot ID. The service records process identity before considering the worker ready. On restart it inspects that identity before signalling an old group. An unrelated reused PID is not signalled. If a previous writer cannot be proven stopped, recovery blocks the session rather than risking a second writer.

Workers also stop after bridge loss. The first implementation does not adopt a live worker after supervisor death, replay unknown prompts or resume accepted inputs automatically. Empty Pi sessions may not yet have a JSONL file; they retain their explicit session ID when restarted. A missing transcript with recorded model activity is an integrity failure.

Ordinary worker stop, service stop and client disconnection are different lifetimes. The detached CLI service can outlive its launcher. Interactive attachment and cancellation semantics remain M3 work.
