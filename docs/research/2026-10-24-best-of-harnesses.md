# Best of harnesses: what Salaam should take from each

Date: 2026-10-24. Status: research note, no code changes. Revision 2: every claim the first revision marked unverified was checked against current docs (see "Verification log" at the end).

## How to read this

- **Code:** I read it in the AgentPod or Salaam source on 2026-10-24.
- **Docs:** I fetched the vendor's official docs on 2026-10-24. The URL given is the page I read.
- **Vendor blog:** the claim comes from the vendor's own blog or changelog rather than its reference docs.
- **Unverified:** I could not reach an official source. Very few are left, and each is labelled.

Claims that failed verification were removed. Agents with no checked feature are listed by name only.

## 1. Summary

The operator's complaint is accurate. Salaam is the strongest harness in the estate, and among the
public tools, on **verification and trust**. That covers bound admissions, operation digests, exact approvals, checked tasks
that need real verification evidence, budgets, checkpoints, and an honest "unknown" outcome. It is
among the weakest on **visibility**. A strict board run ends in a digest receipt. It sends no live
activity to the card, no human-readable handoff and no deliverable that a person can open.

Hermes is the opposite. The `agentpod-live` plugin streams answer, reasoning and tool deltas to Matrix,
and sends turn/step/approval reports to the fleet card. Nothing proves that the work was done.

The tools people prefer in 2026 combine both. The pattern holds across vendors:

1. **A live, followable session log.** Copilot's session view and `gh agent-task --follow`, Devin's
   timeline, Warp's task lists and notification mailbox, and Kiro's live task status.
2. **A reviewable deliverable** attached to the unit of work. Copilot and Codex cloud hand off changed files
   and a PR. Cursor attaches videos and screenshots. Antigravity attaches walkthroughs and recordings that
   people can comment on.
3. **Evidence that the deliverable works.** Codex cloud shows test results, Jules runs a critic pass, Cursor
   tests with computer use, and Claude Code Stop hooks can refuse completion.

Salaam already has item 3, and more rigorously than any of them. Item 1 and item 2 are what it lacks.
They are mostly projection work: Salaam already records the events and artifacts. It does not publish them.

## 2. Harnesses AgentPod supports today (code)

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
AgentPod's permission modes (`ask`, `accept-edits`, `full-auto`) gate edits only. Salaam maps them in its
admitted interactive path (`docs/agentpod-integration.md`).

## 3. The wider field

The ACP registry (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json, fetched
2026-10-24) lists 43 agents: Agoragentic, Amp, Google Antigravity, Auggie, Autohand, Bob, Claude
Agent, Cline, Codebuddy Code, Codex, Cortex Code, Corust, crow-cli, Cursor, DeepAgents, Devin, DimCode,
Dirac, Factory Droid, fast-agent, Gemini CLI, GitHub Copilot CLI, GLM Agent, goose, Grok Build, Harn,
Junie, Kilo, Kimchi, Kimi CLI, MiniMax Code, Minion Code, Mistral Vibe, Nova, OpenCode, OpenCode V2,
pi ACP, Poolside, Qoder, Qwen Code, siGit, Stakpak and VT Code. Every one of them is a possible AgentPod
harness without new transport work.

## 4. Best of the best, by category

### Visibility of work

| Capability                                                      | Best at                       | Why                                                                                                                               | Source                                                                                                              |
| --------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Live session log of every unit of work, streamable from the CLI | GitHub Copilot cloud agent    | The session is linked from the PR timeline. `gh agent-task view --log --follow` streams it.                                       | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/track-copilot-sessions                   |
| Scrubbable timeline with restore                                | Devin                         | Pick a checkpoint on the timeline and restore Devin's memory and files to it.                                                     | https://docs.devin.ai/working-with-teams/using-playbooks                                                            |
| Deliverables people can comment on mid-run                      | Google Antigravity            | Task lists, implementation plans, walkthroughs, screenshots and browser recordings. Comments reach the agent without stopping it. | https://developers.googleblog.com/build-with-google-antigravity-our-new-agentic-development-platform/ (vendor blog) |
| Visual proof attached to the PR                                 | Cursor cloud agents           | Videos, screenshots and logs attached to the PR. Staff acknowledge posting bugs.                                                  | https://cursor.com/help/ai-features/background-agents                                                               |
| Changed files and test results at the end of a task             | Codex cloud                   | Review the changed files and test results, ask for follow-ups, then commit or open a PR.                                          | https://learn.chatgpt.com/docs/cloud                                                                                |
| Per-hunk review of all agent edits                              | Zed agent panel               | "Review Changes" opens one multibuffer with every edit. Each hunk can be accepted or rejected.                                    | https://zed.dev/docs/ai/agent-panel                                                                                 |
| Live task list and attention notifications                      | Warp agents                   | Tasks update in real time. Complete, Request and Error notifications appear as toasts and in a mailbox.                           | https://docs.warp.dev/agents/capabilities/agent-notifications/                                                      |
| Live token and tool streaming into chat                         | Hermes + agentpod-live (ours) | Answer, thought and tool deltas, plus fleet card steps.                                                                           | agentpod `integrations/hermes/agentpod-live/README.md`                                                              |
| Post-hoc session analysis                                       | Devin                         | On-demand analysis of a finished session.                                                                                         | https://docs.devin.ai/product-guides/session-insights                                                               |

### Verification and trust

| Capability                                           | Best at             | Why                                                                                                                                                                | Source                                                                                             |
| ---------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Bound admission, operation digests, unknown outcomes | **Salaam**          | Every effect is bound to a plan digest and approval. It never replays or claims an unknown outcome.                                                                | salaam `src/agentpod-work.ts`, `docs/limitations.md`                                               |
| Checked tasks that need real evidence                | **Salaam**          | `task-verification`, `station-task-verification`, budgets.                                                                                                         | salaam `docs/durable-tasks.md`                                                                     |
| Hook-enforced completion                             | Claude Code         | `PreToolUse` can block a call. A `Stop` hook that exits 2 or returns `"decision": "block"` prevents Claude from stopping. A hook that fails to run does not block. | https://code.claude.com/docs/en/hooks                                                              |
| Adversarial critic before completion                 | Jules               | A critic reviews each proposed change before it is finished. Version one is a single pass over the final output.                                                   | https://developers.googleblog.com/meet-jules-sharpest-critic-and-most-valuable-ally/ (vendor blog) |
| Computer-use testing of the built software           | Cursor cloud agents | Each agent has its own VM and tests the software it built.                                                                                                         | https://cursor.com/blog/agent-computer-use (vendor blog)                                           |
| OS sandbox for commands                              | Codex               | `read-only`, `workspace-write` (the local default) and `danger-full-access`. Seatbelt on macOS, bubblewrap on Linux/WSL2, a Windows sandbox on Windows.            | https://learn.chatgpt.com/docs/sandboxing                                                          |

### Workspace model

| Capability                                     | Best at     | Why                                                                                                                                 | Source                                          |
| ---------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| One workspace per cloud task                   | Codex cloud | Each task gets its own workspace from a published environment, with an install script and configurable internet access.             | https://learn.chatgpt.com/docs/cloud            |
| VM per task                                    | Jules       | Jules clones the repo, installs dependencies and edits files in a VM.                                                               | https://jules.google/docs/                      |
| Checkpoints and rewind                         | Claude Code | A checkpoint for every prompt that starts a turn. `/rewind` restores code, conversation or both. Bash-only changes are not tracked. | https://code.claude.com/docs/en/checkpointing   |
| Per-tool-call snapshots                        | Cline       | A shadow git repo with a checkpoint after each tool use. Compare, Restore Files, Restore Task, or both.                             | https://docs.cline.bot/features/checkpoints     |
| Worktree per agent                             | Cursor      | Worktrees isolate each agent's checkout. Setup comes from `.cursor/worktrees.json`.                                                 | https://cursor.com/docs/configuration/worktrees |
| Fresh occurrence workspaces for recurring jobs | **Salaam**  | Immutable templates, with overlap and missed-slot rules.                                                                            | salaam `docs/jobs.md`                           |

### Approvals and permissions

| Capability                                    | Best at       | Why                                                                                                                                                                                           | Source                                                             |
| --------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Exact-operation approval with revision checks | **Salaam**    | The approval binds to an operation digest. A newer policy invalidates pending auto-approvals.                                                                                                 | salaam `docs/autonomy.md`                                          |
| Remote approval from chat                     | Hermes (ours) | Approvals are answerable from Matrix by number and reported to the fleet card.                                                                                                                | agentpod-live README                                               |
| Rule-based allow/ask/deny                     | Claude Code   | `Tool(specifier)` rules, including per-parameter rules such as `Agent(model:opus)`. Modes include plan, auto (classifier-reviewed) and bypassPermissions. Managed settings can disable modes. | https://code.claude.com/docs/en/permissions                        |
| Tiered policy engine                          | Gemini CLI    | TOML `[[rule]]` entries matched by tool, args, command prefix/regex or MCP name, each deciding `allow`, `deny` or `ask_user`. Priorities span tiers from Default to Admin.                    | https://geminicli.com/docs/reference/policy-engine/                |
| Risk-classified approval                      | goose         | Autonomous, Manual and Smart Approval modes, plus per-tool Always Allow, Ask Before and Never Allow.                                                                                          | https://goose-docs.ai/docs/guides/managing-tools/goose-permissions |
| Path-scoped edit permission                   | Roo Code      | A custom mode's `edit` group can carry a `fileRegex`. Edits outside it fail with `FileRestrictionError`.                                                                                      | https://roocodeinc.github.io/Roo-Code/features/custom-modes        |

### Tools, MCP and extensibility

| Capability                             | Best at       | Why                                                                                                                                                                                                      | Source                                   |
| -------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Skills as progressive-disclosure files | Claude Code   | Only a `SKILL.md`'s description stays in context; the body loads when the skill runs. `allowed-tools` and `context: fork` are front-matter fields. Plugins bundle skills, agents, hooks and `.mcp.json`. | https://code.claude.com/docs/en/skills   |
| Lifecycle-hook plugins                 | Hermes (ours) | `pre_llm_call`, `on_stream_delta`, `pre/post_tool_call` and approval hooks.                                                                                                                              | agentpod-live README                     |
| 30+ hook events                        | Claude Code   | Includes `TaskCompleted`, `SubagentStop`, `WorktreeCreate`, `PreCompact` and `Elicitation`.                                                                                                              | https://code.claude.com/docs/en/hooks    |
| Admitted MCP with resolutions          | **Salaam**    | Toolkit admission, owners, recorded resolutions.                                                                                                                                                         | salaam `src/toolkit-*.ts`, `docs/mcp.md` |

### Memory and identity

| Capability                                | Best at          | Why                                                                                                                    | Source                                                   |
| ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Persistent persona plus own chat identity | Hermes (ours)    | SOUL.md persona, its own Matrix account and avatar, long-lived memory.                                                 | agentpod `descriptor/hermes*.go`                         |
| Team knowledge recalled automatically     | Devin            | Knowledge entries are recalled across sessions. Playbooks can be attached and edited live.                             | https://docs.devin.ai/working-with-teams/using-playbooks |
| Scoped steering files                     | Kiro             | `.kiro/steering/` or global steering, with `always`, `fileMatch`, `manual` or `auto` inclusion. AGENTS.md is read too. | https://kiro.dev/docs/steering/                          |
| Workspace memories and workflows          | Windsurf Cascade | Auto-created memories per workspace, rules files, and `.windsurf/workflows/` step lists.                               | https://docs.windsurf.com/windsurf/cascade/memories      |
| Corrected facts with evidence             | **Salaam**       | Task context records and corrects facts and saves evidence.                                                            | salaam `docs/task-context.md`                            |

### Session lifecycle

| Capability                                | Best at     | Why                                                                                             | Source                                                                                       |
| ----------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Detach, reattach, replay without resubmit | **Salaam**  | Durable service; a client outbox retries the same request identity.                             | salaam `docs/limitations.md`                                                                 |
| Start anywhere, run in the cloud          | Codex cloud | Web, mobile, desktop, CLI, IDE and Slack. Tasks keep working while your computer sleeps.        | https://learn.chatgpt.com/docs/cloud                                                         |
| Hand off local work to the cloud          | Copilot CLI | `/delegate` or a `&` prefix commits a checkpoint branch, then the cloud agent opens a draft PR. | https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca |
| Fork a session                            | Claude Code | `/branch` or `claude --continue --fork-session`.                                                | https://code.claude.com/docs/en/checkpointing                                                |

### Multi-agent

| Capability                            | Best at           | Why                                                                                                               | Source                                                                                                              |
| ------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sub-agents with isolated context      | Claude Code       | Own context window, system prompt, `tools`/`disallowedTools`; only a summary returns; resumable by `SendMessage`. | https://code.claude.com/docs/en/sub-agents                                                                          |
| Handoffs as a primitive               | OpenAI Agents SDK | Each handoff is a `transfer_to_<agent>` tool, with `input_filter`, `input_type` and `on_handoff`.                 | https://openai.github.io/openai-agents-python/handoffs/                                                             |
| Orchestrator mode                     | Roo Code          | It delegates subtasks to other modes via `new_task`, routing on each mode's `whenToUse`.                          | https://roocodeinc.github.io/Roo-Code/features/custom-modes                                                         |
| Repo-defined custom agents            | Copilot CLI       | `.github/agents` in a repo, or `~/.copilot/agents`, invoked with `/agent`.                                        | https://github.blog/changelog/2025-10-28-github-copilot-cli-use-custom-agents-and-delegate-to-copilot-coding-agent/ |
| Cross-runtime delegation (A2A)        | **Salaam**        | Outbound and inbound A2A peers, including Hermes and OpenClaw.                                                    | salaam `docs/a2a.md`                                                                                                |
| Proposal and integrate across workers | **Salaam**        | Coding proposals built by specialists and integrated by the parent.                                               | salaam `docs/agents.md`                                                                                             |

### Planning

| Capability                        | Best at | Why                                                                                                                                                              | Source                                              |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Spec files driving execution      | Kiro    | `requirements.md` (or `bugfix.md`), `design.md` and `tasks.md`. Tasks form a dependency graph and run in concurrent waves, with live status in IDE, CLI and web. | https://kiro.dev/docs/specs/                        |
| Plan approval gate                | Jules   | Jules generates a plan you review and approve before any code changes.                                                                                           | https://jules.google/docs/                          |
| Plan and Act with per-mode models | Cline   | Separate Plan and Act modes, optionally with different models.                                                                                                   | https://docs.cline.bot/features/plan-and-act        |
| Standard live plan on the wire    | ACP     | A `plan` session update carries the full list of entries (`content`, `priority`, `status`), replaced on each update.                                             | https://agentclientprotocol.com/protocol/agent-plan |

### Model, cost and context

| Capability                    | Best at     | Why                                                                                   | Source                                        |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------- | --------------------------------------------- |
| Hard per-task budgets         | **Salaam**  | Task budgets and bounded progression.                                                 | salaam `src/task-budget.ts`                   |
| Planner/editor model split    | Aider       | Architect mode: the main model proposes and an `--editor-model` writes the edits.     | https://aider.chat/docs/usage/modes.html      |
| Targeted compaction           | Claude Code | "Summarize from here" or "Summarize up to here" in `/rewind`, with optional guidance. | https://code.claude.com/docs/en/checkpointing |
| Compaction at a safe boundary | **Salaam**  | It compacts only at an idle boundary.                                                 | salaam `docs/task-context.md`                 |

### Integration surfaces

| Capability                                 | Best at                        | Why                                                                                      | Source                                                                                  |
| ------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Issue → agent → draft PR                   | Copilot cloud agent            | An assigned issue produces a draft PR linked to its session log.                         | Copilot track-sessions URL above                                                        |
| One agent in every editor                  | ACP                            | 43 registry agents in any ACP client.                                                    | ACP registry URL above                                                                  |
| Lock-screen live activity, phone approvals | AgentPod + SuperMessage (ours) | The fleet card, which only Hermes feeds today.                                           | agentpod-live README                                                                    |
| Event-triggered background agents          | Continue                       | `cn` CLI headless runs on PR, schedule or webhook triggers; a Mission Control dashboard. | https://docs.continue.dev/ (unverified: checked through mirrors of Continue's own docs) |

### Observability

| Capability                  | Best at           | Why                                                                                                                                             | Source                                                     |
| --------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| OTel metrics and events     | Claude Code       | `claude_code.token.usage`, `cost.usage` and `session.count`; `tool_result`/`tool_decision` events. Enabled with `CLAUDE_CODE_ENABLE_TELEMETRY`. | https://code.claude.com/docs/en/monitoring-usage           |
| OTel events                 | Codex             | An `[otel]` table with OTLP HTTP/gRPC exporters; `codex.tool_decision` and `tool_result` events; prompts redacted by default.                   | https://learn.chatgpt.com/docs/config-file/config-advanced |
| OTel logs, metrics, traces  | Gemini CLI        | Tool-call and API events, token metrics, GenAI semantic metrics and optional traces.                                                            | https://geminicli.com/docs/cli/telemetry/                  |
| Traces by default           | OpenAI Agents SDK | Agent, generation, function, guardrail and handoff spans. Pluggable trace processors.                                                           | https://openai.github.io/openai-agents-python/tracing/     |
| Execution evidence contract | **Salaam**        | Contract-typed evidence and artifacts.                                                                                                          | agentpod `packages/contract/src/execution-evidence.ts`     |

### Operator UX and errors

| Capability                           | Best at                        | Why                                                               | Source                                                |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Standard error card across harnesses | AgentPod (OpenClaw/Pi plugins) | One error shape across harnesses.                                 | agentpod `integrations/*/agentpod-errors`             |
| Honest state in the TUI              | **Salaam**                     | "Service truth in each view".                                     | salaam `docs/tui.md`                                  |
| Take over the agent's machine        | Cursor                         | Take control of the agent's remote desktop.                       | https://cursor.com/help/ai-features/background-agents |
| Attention mailbox                    | Warp                           | Filters for All, Unread and Errors; at most two toasts at a time. | Warp notifications URL above                          |

## 5. Per-harness notes

### Supported by AgentPod

- **Hermes (code):** streams live and reports to the fleet card through lifecycle-hook plugins. Approval from chat, a persistent persona and its own identity. **Take:** the event vocabulary, as is.
- **OpenClaw (code):** a gateway with many agents and a standard error plugin.
- **Pi (code):** a minimal core with extensions. Salaam runs on Pi.
- **Codex (docs):** a three-level OS sandbox (Seatbelt, bubblewrap, Windows) and `on-request`/`never` approval policies. Command rules. OTel `[otel]` events. Cloud tasks each get their own workspace and end in changed files, test results and a PR, and they can be started from Slack or mobile. **Take:** "changed files and test results" as the end of every task.
- **Claude Code (docs):** blocking hooks, including a Stop hook that refuses completion. Rule-based permissions and a classifier auto mode. Progressive-disclosure skills, and plugins that bundle skills, hooks, agents and MCP. Isolated sub-agents. Checkpoints with `/rewind` and targeted summarise. Session fork. OTel. **Take:** a completion hook and OTel metric names.
- **OpenCode, Kilo, Muse (code):** ACP-native. I checked no differentiating feature in their docs this session.

### Outside AgentPod

- **GitHub Copilot (docs):** the cloud agent works issue → draft PR → session log, which `gh agent-task --follow` streams. The CLI has `/delegate` and repo-defined custom agents. **Take:** the session link on the PR.
- **Cursor (docs and vendor blog):** cloud agents in their own VMs that test with computer use and attach videos and screenshots (known posting bugs). Remote-desktop takeover. A worktree per agent.
- **Devin (docs):** a timeline with checkpoint restore, playbooks, Knowledge and session insights.
- **Jules (docs and vendor blog):** a plan approved before code, a VM per task, AGENTS.md support (docs), and a critic pass (Google's blog). The docs did not say what Jules outputs, so I make no claim about a PR.
- **Kiro (docs):** spec files whose tasks run in dependency waves with live status, and steering files with four inclusion modes.
- **Cline (docs):** a checkpoint after every tool use in a shadow git repo, and Plan/Act with a separate model per mode.
- **Roo Code (docs):** custom modes with tool groups and `fileRegex` edit restriction, and an Orchestrator mode that delegates by `new_task`.
- **Aider (docs):** auto-commits every edit with a generated message, `/undo`, separate commits for dirty files, and architect/editor model split.
- **goose (docs):** Autonomous, Manual and Smart Approval modes, plus per-tool Always/Ask/Never. Its recipes page returned 404, so no recipe claim is made.
- **Gemini CLI (docs):** a TOML policy engine with tiers and priorities, and OTel logs, metrics and traces.
- **OpenHands (docs):** Cloud, Agent Canvas, Software Agent SDK, an Agent Server (REST and WebSocket), a Sandbox Server and an Automation Server. The intro page names no CLI or event stream.
- **OpenAI Agents SDK (docs):** handoffs as tools, guardrails, and tracing on by default.
- **Zed (docs):** per-hunk review in a multibuffer.
- **Warp (docs):** live task lists and an attention-notification mailbox.
- **Windsurf Cascade (docs):** workspace memories, rules files and workflows. The docs now redirect to Devin docs.
- **Continue (unverified: checked only through mirrors of Continue's own docs):** Mission Control and event-triggered headless `cn` agents.
- **Google Antigravity (vendor blog):** Artifacts (plans, task lists, walkthroughs, screenshots, browser recordings) that people can comment on mid-run.
- **Augment Auggie (docs):** an indexed context engine in the CLI, and `--print` for automation.
- **JetBrains Junie (vendor blog and help page):** a Code mode that plans and then executes the plan with progress reports.
- **Kimi CLI (README):** native ACP (`kimi acp`). The ACP client observes its file edits and terminal commands.
- **Listed in the ACP registry with no feature checked:** Amp, Factory Droid, Qwen Code, Grok Build, Mistral Vibe, Poolside, Qoder, and the other registry entries in section 3. For Amp and Factory, only third-party sources came up, so I removed their feature claims.

## 6. Gap analysis for Salaam, ranked by impact on a board workflow

Verification did not change the ranking. Every gap is a Salaam-side fact read from the code. The external
checks only strengthened the references: Antigravity, Warp, Codex cloud and Zed are now confirmed examples.

| Rank | Gap                                                                                       | Best reference                                                        | Salaam today                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | **No live activity on the card.** Strict runs emit nothing to the fleet socket or Matrix. | Hermes agentpod-live, Copilot session log, Warp task lists            | Events exist in its store (`tool.started` and so on), and `/v1/health` carries `last_activity_at`. No `fleet.sock` reporter was found in `src/`. |
| 2    | **Handoff is a receipt, not a report.**                                                   | Codex cloud (changed files and test results), Antigravity walkthrough | `agentpod-work.ts` hands off `producer_terminal_digest` and artifact digests.                                                                    |
| 3    | **No deliverables in SuperLibrary.**                                                      | Antigravity Artifacts, Cursor PR attachments                          | `superlibrary` is a recognised MCP name in `mcp-protocol.ts`, but no publish path for artifacts was found.                                       |
| 4    | **No changeset/diff on the station.**                                                     | Zed per-hunk review, Codex cloud diff                                 | `workspace-diff.ts` and `local-diff.ts` exist locally but are not surfaced to AgentPod.                                                          |
| 5    | **Plan not streamed.**                                                                    | ACP `plan` update, Kiro waves, Jules approval                         | Durable task steps exist but are not sent as ACP `plan` entries; `/plan` is only a model instruction.                                            |
| 6    | **No OTel export.**                                                                       | Claude Code, Codex, Gemini CLI, Agents SDK                            | No OTel references found in `src/`. It has usage evidence and an execution trace.                                                                |
| 7    | **No critic or completion hook.**                                                         | Claude Code Stop hook, Jules critic                                   | Verification is evidence-based but has no adversarial review step.                                                                               |
| 8    | **No chat identity or persona on the board.**                                             | Hermes                                                                | The station has no Matrix login writer; it is Hermes-only.                                                                                       |
| 9    | **No OS sandbox by default.**                                                             | Codex sandbox levels                                                  | Commands run as the OS user unless `--tools-user` is set, and need Docker (`docs/autonomy.md`, `docs/security.md`).                              |
| 10   | **No timeline or restore UI.**                                                            | Devin timeline, Claude Code `/rewind`, Cline checkpoints              | `task-checkpoints.ts` and `local-undo.ts` exist but have no operator UI on AgentPod.                                                             |

Where Salaam already leads: bound admissions and digests, exact approvals, checked-task evidence,
budgets, honest unknown outcomes, A2A, recurring jobs and durable detach. None of the gaps needs
weakening these. Each gap is a **projection** of state Salaam already records.

## 7. Recommended adoption order

1. **Stream activity.** Emit Hermes's fleet-report kinds (turn started, tool step with title and counts,
   writing, approval asked and answered, turn finished) from Salaam's event store to `~/.agentpod/fleet.sock`,
   and emit ACP `tool_call` and `plan` updates on the admitted path. Reuse the existing contract
   (`packages/contract/src/fleet-report.ts`); do not invent a new one.
2. **Human handoff alongside the receipt.** Model it on Codex cloud: what was asked, the changed files, the
   checks run and their results, open questions and links. Keep the digest as the proof and make the report cite it.
3. **Publish deliverables to SuperLibrary.** Push each terminal artifact, with its digest, to SuperLibrary
   and put the link on the card. Allow comments, as Antigravity does. The digest makes the published copy
   verifiable, which is the trust that Hermes lacks.
4. **Advertise a changeset capability** from `workspace-diff`, so the console shows the diff as it does for
   every other harness.
5. **OTel export.** Mirror Claude Code and Codex metric and event names (token usage, cost, tool decision and
   result), keyed to the admission id, into the SuperWitness stack.
6. **Completion gate.** A Stop-hook-style check and an optional critic before terminal, with the verdict recorded as evidence.
7. **Identity:** a Matrix login and persona for Salaam stations.
8. **Checkpoint timeline in the console**, then a default OS sandbox at Codex's three levels.

## Verification log (revision 2)

I checked 41 claims that revision 1 marked unverified or left without an official source:
**27 confirmed, 6 corrected, 8 removed**.

Corrected:

- Codex sandbox: Linux uses **bubblewrap**, not Landlock. The docs state no default network setting.
  Approval policies are `on-request` and `never`.
- Codex cloud: each task gets its own **workspace** from a published environment, not a stated "container".
  The task ends in changed files and test results, then a commit or PR.
- Codex "Starlark execpolicy": the docs call these **rules**, and I removed "Starlark".
- goose: permission levels are **per tool** (Always Allow, Ask Before, Never Allow) plus Smart Approval mode,
  not per extension.
- OpenHands: its components are Cloud, the SDK, and the Agent, Sandbox and Automation servers. I removed the "event-stream architecture" claim.
- ACP plan updates: these are a **protocol** feature. The claim that Claude Code and Codex emit them is dropped.

Removed:

- Conductor-style worktrees.
- Cline, goose and Zed MCP marketplaces.
- Codex AGENTS.md (not checked).
- OpenCode and goose multi-provider routing.
- goose recipes (the docs page returned 404).
- Gemini CLI as the "reference ACP implementation".
- Devin remote-IDE takeover.
- Third-party-only feature claims for Amp and Factory Droid.

Added from docs during the check: Antigravity Artifacts, Warp notifications, Zed per-hunk review, Roo
`fileRegex` and Orchestrator, Kiro wave execution and steering, Copilot `/delegate` and custom agents,
Cline per-mode models, Aider auto-commits, Agents SDK trace spans, Auggie and Kimi CLI.
