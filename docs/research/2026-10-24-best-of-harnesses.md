# Best of harnesses: what Salaam should take from each

Date: 2026-10-24. Status: research note, no code changes.

## How to read this

Two kinds of evidence:

- **Verified (code):** I read it in the AgentPod or Salaam source on 2026-10-24.
- **Verified (docs):** I fetched or searched the vendor's current docs this session. The URL is given.
- **Unverified:** taken from the vendor docs URL as I last knew it, and not re-fetched this session. Treat these as leads to confirm before building. They are marked _(unverified)_.

## 1. Summary

The operator's complaint is accurate. Salaam is the strongest harness in the estate, and among the
public tools, on **verification and trust**. That covers bound admissions, operation digests, exact approvals, checked tasks
that need real verification evidence, budgets, checkpoints, and an honest "unknown" outcome. It is
among the weakest on **visibility**. A strict board run ends in a digest receipt. It sends no live
activity to the card, no human-readable handoff and no deliverable that a person can open.

Hermes is the opposite. The `agentpod-live` plugin streams answer, reasoning and tool deltas to Matrix,
and sends turn/step/approval reports to the fleet card. Nothing proves that the work was done.

The tools people prefer in 2026 combine both, and the pattern is consistent:

1. **A live, scrubbable session log.** Examples are Copilot's session view with `gh agent-task --follow`, Devin's timeline,
   and Codex cloud's task log.
2. **A reviewable deliverable** attached to the unit of work. Examples are a draft PR with a diff, Cursor's
   screenshots and videos, and Jules's plan and diff.
3. **Evidence that the deliverable works**, such as test logs, a critic pass or computer-use recordings.

Salaam already has item 3, and more rigorously than any of them. Item 1 and item 2 are what it lacks.
They are mostly projection work: Salaam already records the events and artifacts. It does not publish them.

## 2. Harnesses AgentPod supports today (verified, code)

The station-descriptor registry in `apps/node-agent/internal/descriptor/` defines **nine** harness ids:

| id            | Integration in AgentPod                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes`      | Profiles under one multiplexed gateway, each with its own Matrix identity: login, avatar and profile writers are Hermes-only. Native skills (`hermesskills`, kanban-worker). The `agentpod-live` plugin (`integrations/hermes/agentpod-live`) streams `dev.agentpod.stream.delta`, `thought.delta` and `tool.update`, and reports turn/step/writing/approval to `~/.agentpod/fleet.sock`. Declared config covers `approvals.mode/timeout/command_allowlist`, `plugins.enabled` and `skills.external_dirs`. Hermes is also the only harness with STT/TTS writers. |
| `openclaw`    | Gateway plus per-agent stations. The `agentpod-errors` plugin standardises errors. MCP reaches it through the hub MCP proxy in `session/new`. Declared config includes `allow_conversation_access`.                                                                                                                                                                                                                                                                                                                                                              |
| `pi`          | Run via `pi-acp`. The `agentpod-errors` extension. MCP through the proxy. Native skill discovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `codex`       | Run via `codex-acp`. Native skills, with readiness checks on adapter and engine identity. Listed in `MCP_PROXY_HARNESSES`. Matrix "harness mark".                                                                                                                                                                                                                                                                                                                                                                                                                |
| `claude-code` | Run via the Claude ACP adapter. Native skill loading and discovery probe. MCP proxy. Harness mark.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `opencode`    | Also a provisionable cloud runtime (`RuntimeHarness = none\|opencode\|pi`, 2048 MB measured). Reads the OpenCode DB log. MCP proxy. Harness mark.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kilo`        | Descriptor and changeset capability. It is also in the ACP registry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `muse`        | Muse Code, run over ACP (the spike passed 2026-10-13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `salaam`      | Leaf station with the capabilities `inventory, health, logs, fs.read, acp, skills.inventory`. Configuration is report-only, except for the host manifest. It is the only harness with `execution-evidence` and `execution-artifacts` contract schemas (`packages/contract/src/execution-*.ts`). `scripts/harness-conformance.mjs` checks it against the first-class harness spec of 2026-10-23.                                                                                                                                                                  |

Every descriptor other than Salaam's appends the **changeset** capability (`AppendChangesetCap`), so
the console can show a workspace diff for those stations. Salaam's station does not advertise it.
Permission modes in AgentPod gate edits only (`ask`, `accept-edits`, `full-auto`). Salaam maps them in its
admitted interactive path (`docs/agentpod-integration.md`).

## 3. The wider field

The ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, fetched
2026-10-24) lists 43 agents, including Amp, Google Antigravity, Auggie, Claude Agent, Cline, Codex,
Cursor, Devin, Factory Droid, Gemini CLI, GitHub Copilot CLI, goose, Grok Build, Junie, Kilo, Kimi
CLI, Mistral Vibe, OpenCode (v1 and v2), pi ACP, Poolside, Qoder and Qwen Code. Every one of them is a
possible AgentPod harness without new transport work.

## 4. Best of the best, by category

### Visibility of work

| Capability                                                      | Best at                              | Why                                                                                            | Source                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Live session log of every unit of work, streamable from the CLI | GitHub Copilot coding agent          | A session is linked from the PR timeline. `gh agent-task view --log --follow` streams it live. | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions        |
| Scrubbable timeline with restore                                | Devin                                | Timeline panel; restore memory and files to any checkpoint.                                    | https://docs.devin.ai/working-with-teams/using-playbooks                                                 |
| Visual proof attached to the deliverable                        | Cursor cloud agents                  | Videos, screenshots and logs attached to the PR (with known posting bugs).                     | https://cursor.com/help/ai-features/background-agents                                                    |
| The PR as the handoff                                           | Copilot, Codex cloud, Jules, Factory | A draft PR with a diff, description and linked issue is a reviewable deliverable.              | https://docs.github.com/en/copilot/using-github-copilot/coding-agent/using-the-copilot-coding-agent-logs |
| Live token and tool streaming into chat                         | Hermes + agentpod-live (ours)        | Answer, thought and tool deltas, plus fleet card steps.                                        | agentpod `integrations/hermes/agentpod-live/README.md`                                                   |
| Plan shown before work                                          | Jules                                | The plan is shown for approval or revision before any code is written.                         | Third-party guides only _(unverified in official docs)_                                                  |
| Post-hoc session insights                                       | Devin                                | Analysis of a finished session, on demand.                                                     | https://docs.devin.ai/product-guides/session-insights                                                    |

### Verification and trust

| Capability                                           | Best at             | Why                                                                                                         | Source                                                                               |
| ---------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Bound admission, operation digests, unknown outcomes | **Salaam**          | Every effect is bound to a plan digest and approval. It never replays or claims an unknown outcome.         | salaam `src/agentpod-work.ts`, `docs/limitations.md`                                 |
| Checked tasks that need real evidence                | **Salaam**          | `task-verification`, `station-task-verification`, budgets.                                                  | salaam `docs/durable-tasks.md`                                                       |
| Adversarial critic before completion                 | Jules               | A critic reviews every proposed change before it is finished.                                               | https://developers.googleblog.com/meet-jules-sharpest-critic-and-most-valuable-ally/ |
| Computer-use testing of the built software           | Cursor cloud agents | Each agent has its own VM and tests in a desktop or browser.                                                | https://cursor.com/blog/agent-computer-use                                           |
| Hook-enforced checks                                 | Claude Code         | `PreToolUse`, `PostToolUse` and `Stop` hooks can block. A Stop hook can refuse completion until tests pass. | https://docs.anthropic.com/en/docs/claude-code/hooks _(unverified)_                  |
| OS sandbox for commands                              | Codex CLI           | Seatbelt/Landlock sandbox with workspace-write and network-off defaults.                                    | https://developers.openai.com/codex/security _(unverified)_                          |

### Workspace model

| Capability                                     | Best at                               | Why                                                                               | Source                                                                      |
| ---------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| One clean cloud environment per task           | Codex cloud, Copilot (Actions), Jules | A fresh container or VM per task, with a setup script.                            | https://developers.openai.com/codex/cloud _(unverified)_                    |
| Checkpoints and rewind                         | Claude Code, Cline, Devin             | `/rewind` restores code and conversation. Cline has per-step workspace snapshots. | https://docs.anthropic.com/en/docs/claude-code/checkpointing _(unverified)_ |
| Parallel worktrees                             | Cursor, Claude Code, Conductor-style  | One git worktree per agent.                                                       | _(unverified)_                                                              |
| Fresh occurrence workspaces for recurring jobs | **Salaam**                            | Immutable templates, with overlap and missed-slot rules.                          | salaam `docs/jobs.md`                                                       |

### Approvals and permissions

| Capability                                    | Best at                   | Why                                                                                           | Source                                                            |
| --------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Exact-operation approval with revision checks | **Salaam**                | The approval binds to an operation digest. A newer policy invalidates pending auto-approvals. | salaam `docs/autonomy.md`                                         |
| Remote approval from chat                     | Hermes (ours)             | Approvals are answerable from Matrix by number and reported to the fleet card.                | agentpod-live README                                              |
| Rule-based allow/deny per tool and pattern    | Claude Code, Gemini CLI   | `permissions.allow/deny` with tool(pattern) rules, managed policy.                            | https://docs.anthropic.com/en/docs/claude-code/iam _(unverified)_ |
| Policy-as-code for tool calls                 | goose, Codex (execpolicy) | Per-extension permission levels; Starlark exec policy.                                        | _(unverified)_                                                    |

### Tools, MCP and extensibility

| Capability                               | Best at                 | Why                                                                             | Source                                                               |
| ---------------------------------------- | ----------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Skills as progressive-disclosure files   | Claude Code / Agent SDK | `SKILL.md` front matter loaded on demand. Plugins bundle skills, hooks and MCP. | https://docs.anthropic.com/en/docs/claude-code/skills _(unverified)_ |
| Extension marketplace with one-click MCP | Cline, goose, Zed       | MCP marketplace; extensions as first-class units.                               | _(unverified)_                                                       |
| Lifecycle-hook plugins                   | Hermes (ours)           | `pre_llm_call`, `on_stream_delta`, `pre/post_tool_call`, approval hooks.        | agentpod-live README                                                 |
| Admitted MCP with resolutions            | **Salaam**              | Toolkit admission, owners, recorded resolutions.                                | salaam `src/toolkit-*.ts`, `docs/mcp.md`                             |

### Memory and identity

| Capability                                | Best at                                                   | Why                                                                    | Source                                           |
| ----------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| Persistent persona plus own chat identity | Hermes (ours)                                             | SOUL.md persona, its own Matrix account and avatar, long-lived memory. | agentpod `descriptor/hermes*.go`                 |
| Team knowledge recalled automatically     | Devin                                                     | Knowledge entries recalled across sessions; playbooks.                 | https://cognition.ai/blog/sept-24-product-update |
| Repo memory files                         | Claude Code (CLAUDE.md), Codex (AGENTS.md), Kiro steering | Hierarchical instruction files.                                        | _(unverified)_                                   |
| Corrected facts with evidence             | **Salaam**                                                | Task context records and corrects facts and saves evidence.            | salaam `docs/task-context.md`                    |

### Session lifecycle

| Capability                                | Best at                             | Why                                                                 | Source                           |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Detach, reattach, replay without resubmit | **Salaam**                          | Durable service; a client outbox retries the same request identity. | salaam `docs/limitations.md`     |
| Background cloud runs from anywhere       | Codex cloud, Copilot, Cursor, Jules | Start from web, mobile, issue or Slack, and come back later.        | Copilot track-sessions URL above |
| Resume and fork a conversation            | Claude Code, Agent SDK              | `--resume` and `--fork-session`.                                    | _(unverified)_                   |

### Multi-agent

| Capability                            | Best at                 | Why                                                                 | Source                                                                 |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Sub-agents with isolated context      | Claude Code / Agent SDK | Typed sub-agents with their own tools and context window.           | _(unverified)_                                                         |
| Handoffs as a primitive               | OpenAI Agents SDK       | Handoffs, guardrails and tracing are built in.                      | https://openai.github.io/openai-agents-python/handoffs/ _(unverified)_ |
| Cross-runtime delegation (A2A)        | **Salaam**              | Outbound and inbound A2A peers, including Hermes and OpenClaw.      | salaam `docs/a2a.md`                                                   |
| Proposal and integrate across workers | **Salaam**              | Coding proposals built by specialists and integrated by the parent. | salaam `docs/agents.md`                                                |

### Planning

| Capability                               | Best at                                 | Why                                                       | Source                                                             |
| ---------------------------------------- | --------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| Spec → design → tasks as committed files | Kiro                                    | Requirements, design and tasks documents drive execution. | https://kiro.dev/docs/specs/ _(unverified)_                        |
| Live to-do list streamed to the client   | Claude Code, Codex (ACP `plan` updates) | The ACP `plan` session update renders as a checklist.     | https://agentclientprotocol.com/protocol/agent-plan _(unverified)_ |
| Plan approval gate                       | Jules, Cline (Plan/Act)                 | Execution waits on an approved plan.                      | see above                                                          |

### Model, cost and context

| Capability                    | Best at                | Why                                                         | Source                        |
| ----------------------------- | ---------------------- | ----------------------------------------------------------- | ----------------------------- |
| Hard per-task budgets         | **Salaam**             | Task budgets and bounded progression.                       | salaam `src/task-budget.ts`   |
| Multi-provider routing        | OpenCode, Aider, goose | Any provider; separate architect and editor models (Aider). | _(unverified)_                |
| Compaction at a safe boundary | Salaam, Claude Code    | Salaam compacts only at an idle boundary.                   | salaam `docs/task-context.md` |

### Integration surfaces

| Capability                                 | Best at                        | Why                                       | Source                 |
| ------------------------------------------ | ------------------------------ | ----------------------------------------- | ---------------------- |
| Issue → agent → PR                         | Copilot, Jules, Factory, Devin | Assign an issue; get a PR.                | Copilot URLs above     |
| One agent in every editor                  | ACP (Zed, JetBrains, Neovim)   | 43 registry agents in any ACP client.     | ACP registry URL above |
| Lock-screen live activity, phone approvals | AgentPod + SuperMessage (ours) | The fleet card, fed only by Hermes today. | agentpod-live README   |

### Observability

| Capability                  | Best at                        | Why                                                                            | Source                                                                         |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| OTel metrics and events     | Claude Code, Codex, Gemini CLI | Token, cost, tool and session metrics over OTLP.                               | https://docs.anthropic.com/en/docs/claude-code/monitoring-usage _(unverified)_ |
| Built-in traces             | OpenAI Agents SDK              | Every run is traced by default, with spans per tool, handoff and guardrail.    | _(unverified)_                                                                 |
| Execution evidence contract | **Salaam**                     | Contract-typed evidence and artifacts. AgentPod node has `otelenv`/`acptrace`. | agentpod `packages/contract/src/execution-evidence.ts`                         |

### Operator UX and errors

| Capability                           | Best at                        | Why                                        | Source                                    |
| ------------------------------------ | ------------------------------ | ------------------------------------------ | ----------------------------------------- |
| Standard error card across harnesses | AgentPod (OpenClaw/Pi plugins) | One error shape across harnesses.          | agentpod `integrations/*/agentpod-errors` |
| Honest state in the TUI              | **Salaam**                     | "Service truth in each view".              | salaam `docs/tui.md`                      |
| Take over the agent's machine        | Cursor, Devin                  | Remote desktop or IDE into the agent's VM. | Cursor background-agents URL              |

## 5. Per-harness notes (the best thing to take from each)

- **Hermes:** live streaming and fleet-card reports through lifecycle-hook plugins; approval from chat; a persistent persona and identity. Take the event vocabulary as is.
- **OpenClaw:** a gateway with many agents and a standard error plugin.
- **Pi:** a minimal core with extensions. Salaam already runs on Pi.
- **Codex CLI and cloud:** OS sandbox defaults; a cloud task per environment that yields a diff/PR; OTel _(unverified)_.
- **Claude Code / Agent SDK:** hooks that can block completion, skills, plugins, sub-agents, checkpoints and rewind, OTel _(unverified)_.
- **OpenCode / Kilo:** multi-provider routing, a client/server split, two ACP entries.
- **Muse Code:** ACP-native. No differentiator verified.
- **GitHub Copilot coding agent and CLI:** the issue → draft PR flow; the session log is linked from the PR; `gh agent-task --follow` (verified).
- **Cursor:** cloud agents in their own VMs that attach videos and screenshots (verified, with known bugs); remote desktop takeover.
- **Devin:** timeline with checkpoint restore, playbooks, Knowledge, session insights (verified).
- **Jules:** plan before code, and a critic pass before completion (critic verified on Google's blog; plan flow only in third-party sources).
- **Kiro:** spec-driven tasks and steering files _(unverified)_.
- **Cline / Roo Code:** Plan/Act modes, per-step checkpoints, an MCP marketplace, custom modes (Roo) _(unverified)_.
- **Aider:** git-native commits for every change; architect/editor model split _(unverified)_.
- **goose:** extension-first MCP, recipes, per-tool permission levels _(unverified)_.
- **Gemini CLI:** the reference ACP implementation, policy rules, OTel _(unverified)_.
- **Amp, Factory Droid, Augment (Auggie), Junie, Qwen Code, Kimi CLI, Grok Build, Antigravity, Mistral Vibe, Poolside, Qoder:** all in the ACP registry (verified). Their feature claims were not checked this session.
- **OpenHands:** an open-source cloud agent with a sandbox runtime and an event-stream architecture _(unverified)_.
- **Zed agent, Warp agents, Continue, Windsurf/Cascade, Sourcegraph Amp:** editor- and terminal-native agents _(unverified)_.
- **OpenAI Agents SDK:** handoffs, guardrails and tracing by default _(unverified)_.

## 6. Gap analysis for Salaam, ranked by impact on a board workflow

| Rank | Gap                                                                                                                    | Best reference                                     | Salaam today                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **No live activity on the card.** Strict runs emit nothing to the fleet socket or Matrix.                              | Hermes agentpod-live, Copilot session log          | Events exist in its store (`tool.started` and so on), and `/v1/health` carries `last_activity_at`. No `fleet.sock` reporter was found in `src/`. |
| 2    | **Handoff is a receipt, not a report.** A digest proves integrity but tells a reviewer nothing.                        | Copilot/Codex draft PR description, Devin insights | `agentpod-work.ts` hands off `producer_terminal_digest` and artifact digests.                                                                    |
| 3    | **No deliverables in SuperLibrary.** Artifacts are digested and never published where people look.                     | Cursor attaching artifacts to the PR               | `superlibrary` is a recognised MCP name in `mcp-protocol.ts`, but no publish path for artifacts was found.                                       |
| 4    | **No changeset/diff on the station.** Every other descriptor advertises a changeset; Salaam does not.                  | Codex cloud and Copilot diffs                      | `workspace-diff.ts` and `local-diff.ts` exist locally but are not surfaced to AgentPod.                                                          |
| 5    | **Plan not streamed.** No ACP `plan` updates; `/plan` is only a model instruction.                                     | Claude Code/Codex ACP plan, Jules                  | Durable task steps exist but are not shown as a checklist.                                                                                       |
| 6    | **No OTel export.**                                                                                                    | Claude Code, Codex, Gemini CLI                     | No OTel references found in `src/`. It has usage evidence and an execution trace.                                                                |
| 7    | **No critic or completion hook.**                                                                                      | Jules critic, Claude Code Stop hook                | Verification is evidence-based but has no adversarial review step.                                                                               |
| 8    | **No chat identity or persona on the board.**                                                                          | Hermes                                             | The station has no Matrix login writer; it is Hermes-only.                                                                                       |
| 9    | **No OS sandbox by default.** Commands run as the OS user unless `--tools-user` is set; Docker is needed for commands. | Codex sandbox                                      | `docs/autonomy.md`, `docs/security.md`.                                                                                                          |
| 10   | **No timeline scrub or restore in the UI.**                                                                            | Devin, Claude Code rewind                          | `task-checkpoints.ts` and `local-undo.ts` exist but have no operator UI on AgentPod.                                                             |

Where Salaam already leads: bound admissions and digests, exact approvals, checked-task evidence,
budgets, honest unknown outcomes, A2A, recurring jobs and durable detach. None of the gaps needs
weakening these. Each gap is a **projection** of state Salaam already records.

## 7. Recommended adoption order

1. **Stream activity.** Emit Hermes's fleet-report kinds (turn started, tool step with title and counts,
   writing, approval asked and answered, turn finished) from Salaam's event store to `~/.agentpod/fleet.sock`,
   and emit ACP `tool_call` and `plan` updates on the admitted path. Reuse the existing contract
   (`packages/contract/src/fleet-report.ts`); do not invent a new one.
2. **Human handoff alongside the receipt.** Generate a structured report from recorded evidence: what was
   asked, what changed (diffstat), the checks run and their results, open questions and links. Keep the digest
   as the proof and make the report cite it.
3. **Publish deliverables to SuperLibrary.** Push each terminal artifact, with its digest, to SuperLibrary
   and put the link on the card. The digest makes the published copy verifiable, which is the trust that Hermes lacks.
4. **Advertise a changeset capability** from `workspace-diff`, so the console shows the diff as it does for
   every other harness.
5. **OTel export** of usage, tool and turn spans, keyed to the admission id, into the SuperWitness stack.
6. **Critic or completion gate.** An optional reviewer step before terminal, which records its verdict as evidence.
7. **Identity:** a Matrix login and persona for Salaam stations, so the board agent speaks in the room.
8. **Checkpoint timeline in the console**, then a default OS sandbox.

The first three items answer the operator's complaint directly. They turn "proves completion but shows
nothing" into "shows everything, and each piece shown is bound to a proof".
