# Salaam as a daily driver: interactive audit (2026-10-31)

Salaam 0.0.4 compared with 11 other coding-agent harnesses on the desk-side experience: Claude Code, Codex CLI,
Gemini CLI, OpenCode, Aider, Cursor CLI, Amp, Goose, Crush, Kimi Code CLI and Pi, plus Cline and Roo for
reference. Each harness was checked against its current docs (2026-10-31). Salaam was audited from its code and
from a tmux-driven pass of its terminal UI on macOS.

## Headline

Step 0 gave the same three small tasks to both harnesses in a scratch copy of this repo. Claude Code finished all three in 14 to 51 seconds. Salaam on macOS finished none:

- Seatbelt blocked git and every toolchain outside the repo.
- Any failed command failed the whole task.

The terminal UI itself is fast. A prompt is ready 0.9 s after attaching, the session is back 1.4 s after re-attaching, and there are 53 commands. Working in it is slow:

- Edits rewrite whole files. A one-line change cost about 3,500 tokens and produced a 315-line review.
- Stopping or steering a turn is hard.
- Approvals offer only Deny or Approve once, and show internals.
- Model and thinking can't be switched mid-session.

Pi, which Salaam is built on, already leads on sessions, compaction, model switching, skills, MCP and headless use. It
leaves out the interactive approval and mode layer on purpose. That layer is where Salaam's exact-operation
approvals are strongest, so Salaam is the right place to build it.

## The 15 features a daily driver needs

| #   | Feature                                                     | Best in class                       | Salaam 0.0.4                                                     |
| --- | ----------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| 1   | Streaming TUI, multiline input, history, external editor    | Claude Code                         | yes                                                              |
| 2   | @-file mention, image paste                                 | Claude Code, OpenCode               | partial: path completion only, no images                         |
| 3   | Approval rules (allow/ask/deny), "always for this session"  | OpenCode                            | partial: exact approvals and path scopes, but every command asks |
| 4   | One-key mode switch (plan, accept edits, auto)              | Claude Code, Kimi (Shift+Tab)       | no                                                               |
| 5   | Undo or rewind of files and conversation                    | Cline (shadow git per tool), Gemini | partial: one edit back                                           |
| 6   | Resume, continue, session picker                            | Pi                                  | partial: works, but needs the full session id                    |
| 7   | Auto-compaction                                             | Claude Code, Pi                     | yes (Pi)                                                         |
| 8   | Switch model or thinking mid-session                        | Claude Code, Pi                     | no: new sessions only                                            |
| 9   | Diff review before accepting                                | Cursor (Ctrl+R), Codex /review      | no: the Changes tab shows operation records                      |
| 10  | AGENTS.md hierarchy, /init                                  | Codex, OpenCode                     | partial: only after `/skills review`                             |
| 11  | Steer or queue while running, interrupt without losing work | Claude Code, Amp                    | no: Esc does nothing, typing queues                              |
| 12  | Custom commands, skills, MCP                                | Claude Code, OpenCode               | partial: skills and MCP, no user commands or hooks               |
| 13  | Background shells                                           | Claude Code, Kimi                   | no                                                               |
| 14  | Headless JSON for scripts                                   | Claude Code, Pi                     | yes                                                              |
| 15  | Live cost, tokens, "needs you" notifications                | Crush, Claude Code                  | partial: usage panel, no notifications                           |

**What Salaam has that no other harness does:**

- verified checks and sealed receipts;
- a completion critic;
- approvals bound to the exact operation;
- restore tied to exact file states;
- uncertain actions are never replayed.

## Plan (operator-approved 2026-10-31)

1. **Unblock:**
   - On macOS, Seatbelt allows git and an operator-chosen read-only list of toolchain folders.
   - In interactive sessions, failed commands are feedback, not a failed task.
   - One `salaam` command to start, and resume from a picker.
   - Edits are targeted, and their review shows only the change.
   - The model is told its platform. Stale help is fixed.
2. **Desk flow:**
   - Esc stops a turn and typing steers it.
   - Approvals offer once, this session or always, without showing internals, plus allow/ask/deny rules.
   - A Shift+Tab mode cycle: plan, accept edits, auto, and full access, with the sandbox level switchable mid-session and a warning.
   - AGENTS.md loads automatically.
   - Model and thinking can be switched mid-session.
   - Built-in web search: free and lightweight first (keyless sources, self-hosted SearXNG), with a paid API optional.
3. **Trust and review:** rewind to any turn, per-file diff review with a follow-up instruction, @ attaching file contents, images, background shells, notifications.
4. **Fit:** git helpers, user commands and hooks, ACP parity for Zed.

Board and station work keep the strict sandbox and its fail-closed semantics.

---

## Appendix B: Terminal UI pass (tmux)

## Appendix D: Harness matrix

## Appendix A: Step 0 (three tasks, Salaam vs Claude Code)

Salaam v0.0.4 (12a260c, built from a clone) was compared with Claude Code (`claude -p`, headless) on
the Mac. Both used throwaway clones of the Salaam repo and the same three prompts. Salaam ran a
`--local-coding` session, with commands under Seatbelt (workspace-write, no network), on the
Anthropic default model `claude-sonnet-5-5`. Approvals were answered by a script as soon as they
appeared. Claude Code ran with `acceptEdits` and an allowlist for `npx vitest` and git.

### Results

|                           | Salaam 0.0.4                                                                                                                                                   | Claude Code                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Steps to start            | 3 commands (`service start --provider anthropic`, `session create --local-coding --cwd`, then `attach` or `session submit`), and a short `--state` path        | 1 (`claude` in the repo)                     |
| Service and session start | ~1 s each                                                                                                                                                      | ~instant                                     |
| Task 1, fix one help line | Edit correct in 63 s. First approval at ~28–47 s. **Attempt marked failed.** 2 approvals                                                                       | Done in 51 s, 10 turns, correct              |
| Task 2, add a unit test   | Test file written correctly (3/3 pass outside). **Could not run the test** (EPERM). **Attempt failed.** 3 approvals                                            | Done in 30 s, test written and run, 3/3 pass |
| Task 3, run one test file | **Failed in 16 s:** `npx vitest` got EPERM                                                                                                                     | 14 s: 8 passed, 0 failed                     |
| Approval wording          | Clear: "Runs as your local user, in a Seatbelt sandbox (workspace-write): it can write only inside this workspace, and has no network", plus the exact command | Not compared (headless, pre-allowed)         |
| Edits                     | Its file-patch tool applies and verifies, but it chose shell `sed` twice for task 1                                                                            | Edit tool                                    |
| Diff shown                | Not seen in this headless run                                                                                                                                  | Not seen (headless)                          |
| Undo                      | Not exercised                                                                                                                                                  | Not exercised                                |
| Resume after restart      | The session is listed after a service restart (state `exited`)                                                                                                 | `--resume` exists, not exercised             |

### What broke Salaam, ranked by how much it blocks daily use

1. **git is unusable inside the macOS sandbox.** `git diff` under Seatbelt exits 69 with "You have not agreed to the Xcode license agreements". `/usr/bin/git` is an `xcrun` shim, and its license and developer-dir lookups are denied by the profile. Outside the sandbox git works. Almost every coding task touches git. Plan step 1 (Seatbelt profile on macOS: allow the reads xcrun needs, read-only).
2. **Toolchains outside the repo are unreadable.** `npx vitest` got EPERM on `~/SuperJackfruit/salaam/node_modules/...`. In this trial `node_modules` was a symlink into the home folder, but the same wall stands for `~/.npm`, `~/.nvm`, `~/.cargo`, `~/.rustup`, `~/go`, Homebrew prefixes outside `/opt/homebrew`, and git's `~/.gitconfig`. A real checkout with an in-repo `node_modules` would be better, but `npx` still needs `~/.npm`. Step 1: an operator-set read-only allowlist of toolchain paths, with sensible defaults per language, still with no home-wide read.
3. **One failed command fails the whole attempt.** Every task ended "failed (tool salaam_local)" even when the model recovered and finished, as in task 1. For interactive coding a non-zero exit is normal feedback, not a stop. Step 3: a command that exits non-zero is a result, not an attempt failure. Board strictness can stay, since there the step's check decides.
4. **The model isn't told it is on macOS with BSD tools.** It used GNU `sed -i 's/…/'`, which fails on BSD sed, then retried. Step 3: tell the worker the platform (OS, BSD userland) in its context. It also preferred `sed` over its own patch tool for a one-line edit, which costs an extra approval each time.
5. **Starting takes three commands and flags**, plus a short-state-path gotcha: `State path is too long for a Unix socket` with a deep `--state`. Step 1: one `salaam` in a repo starts or reuses the daemon and opens a local coding session there.
6. **Stale help:** `session create --local-coding` still says "(no OS sandbox)". This is a one-line fix.
7. **Approvals for every command.** 1–3 per small task, with the first ~30 s in. Step 3: the existing per-agent "Always allow" for workspace writes, plus a "this repo, these commands" rule, would remove most of them.
8. **Not measured, still to check in step 3:** diff display in the TUI, checkpoint undo for local sessions, time to the first token in the TUI, and resuming an exited session.

### Setup actually needed (Salaam)

The build is already there (`npm run build`, ~1 s incrementally), and an existing `~/.config/salaam/credentials/anthropic`. Then:
`salaam service start --provider anthropic --state <short path>`, `salaam session create --local-coding --cwd <repo>`, and `salaam attach <id>` (or `session submit` plus answering `approvals approve --digest --revision`).

Note: the `sal` on PATH links to `~/SuperJackfruit/salaam`, which is on 0.0.3; the operator's local Salaam checkout is behind main.

### Recommendation

Fix 1, 2 and 3 first (git, toolchain reads, failed commands). Without them no real task completes in Salaam on the Mac. 4–7 are polish that matters within a day of use. Then rerun these three tasks, and add a TUI pass to measure diffs and undo.

## Appendix B: Terminal UI pass (tmux)

Salaam at `12a260c` (v0.0.4), on the Mac, run as a local coding session under Seatbelt with Claude Sonnet 5.5. The TUI was driven in a detached tmux session at 160×45. The screen captures are in `tui-captures/` (31 files). The setup took three commands: `service start --provider anthropic --state /tmp/sal-tui` (2 s), `session create --local-coding --cwd <repo>`, and `attach <session-id>`. The clone and the state directory have since been removed.

### Results

| #   | Check                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Timing / evidence                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Attach to a usable prompt; a short prompt                     | **Good.** A clean layout with tabs (Conversation · Changes · Commands · Context), a side panel (control, attention, provider, a USAGE line with an estimated $), and hints in the footer. The answer is grounded and cites `docs/index.md` lines 3–5.                                                                                                                                                                                                                                                                              | Usable in **0.9 s**. The short turn finished in under about 25 s. First-token time was not captured cleanly (my matcher hit the echoed prompt). The status line stayed "Instruction accepted." after the turn ended (`02-short-prompt-done.txt`). |
| 2   | A one-line edit (`# Guarded coding` → `# Coding with Salaam`) | **Works, but the review is painful.** The banner reads only "Local edit: <workspace path>": no file name, no change. Ctrl+O opens a review that shows the **whole new file (315 lines)**, not a diff, and says "**Scroll to the end to enable approval** · 1–18 of 315" (End jumps there). The only choices are **Deny / Approve once**, and the footer shows the approval UUID, the digest, the revision and the expiry. The model wrote the **whole file** through the edit tool: 3,494 output tokens, about $0.07 for one line. | The approval appeared at about 6 s and the edit applied **0.6 s** after Enter. `git diff` showed 1 line changed (`04-approval-review.txt`, `06-after-approve.txt`).                                                                               |
| 2b  | The Changes tab (Ctrl+G)                                      | **Misleading.** It shows "saved operation records, not a live Git diff", and the preview begins with the **old** heading.                                                                                                                                                                                                                                                                                                                                                                                                          | `07-changes.txt`                                                                                                                                                                                                                                  |
| 3   | Undo                                                          | **Works for the last edit only.** `/undo` "Review and revert the last completed local edit" opens the whole file again (Lines 1–36 of 322); End then Enter applies "reviewed inverse". The message reads "Reverted the reviewed local edit. Conversation history is preserved." It goes back one step only, with no turn picker.                                                                                                                                                                                                   | File reverted, git clean (`09-undo-review.txt`, `10-after-undo.txt`)                                                                                                                                                                              |
| 4   | Interrupting and steering                                     | **Weak.** Typing during a turn **queues** the text ("YOU · queued"), and the queued instruction ran only after the whole original task finished, so the unwanted work was done anyway. **Esc does nothing** to a running turn, and **Ctrl+C detaches** rather than stopping. Stopping takes Ctrl+K → `/cancel` → a picker of instructions by ID (the cursor started on the _queued_ one) → a confirm that defaults to "**Keep current state**". `/steer <text>` exists but is not the default for typing.                          | `11-steer.txt` … `16-queue-result.txt`                                                                                                                                                                                                            |
| 5   | Slash commands                                                | **Many (53 lines of help).** Includes `/diff` (live git diff), `/permissions` (Inspect only = read-only, Review every mutation, Auto-approve scoped edits for exact files or prefixes; shell still asks), `/steer`, `/queue`, `/compact`, `/history`, `/usage`, `/copy`. **`/model` and `/thinking` say "applies to a new session"**; the provider list opens on "Offline demo". `/coding` help still says "unsandboxed commands".                                                                                                 | `17-help.txt`, `18-diff.txt`, `19-permissions.txt`, `20-model.txt`, `21-thinking.txt`                                                                                                                                                             |
| 6   | Quit and resume                                               | **Resume is good, starting it is not.** Ctrl+C detaches cleanly. Re-attaching shows the conversation intact in **1.4 s**. But `attach` needs the full **session ID**: there is no "continue last" or per-repo default (`salaam attach SESSION_ID`).                                                                                                                                                                                                                                                                                | `22-detach.txt`, `23-resumed.txt`                                                                                                                                                                                                                 |
| 7   | Input                                                         | Multiline input (Alt+Enter) **works**. History recall (Up) **works**. **Ctrl+U did not clear** the recalled text, which was glued onto the next prompt ("…require?Actually only do…"). `@docs/ins` showed **no completion popup**, and Tab did nothing. Whether `@` attaches file contents could not be shown, because the model answered from its earlier read. Image paste and Ctrl+E were not tried.                                                                                                                            | `24-at-complete.txt`, `25-multiline.txt`, `26-history.txt`, `27-at-attach.txt`                                                                                                                                                                    |
| 8   | Overall feel                                                  | Polished visually, responsive, and it never lost state. The friction is in the _decisions_: reviewing an edit or undo means scrolling whole files, stopping a turn takes 4–5 keys, model choice is locked, and the status line lags.                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                 |

### UX problems, ranked (with audit phase)

1. **Edits are whole-file rewrites, and their reviews show whole files** (315 lines, scroll-to-end gate, no diff). That makes edits slow, expensive (3.5k output tokens for one line) and hard to review. The fix is a search-and-replace or patch edit tool, plus a diff-first review that highlights the hunk, with no scroll gate when the diff is small. _Phase 2 (desk flow) / Phase 3 (diff review)._
2. **Stopping or steering a running turn is hard.** Esc does nothing and Ctrl+C detaches. Typing queues instead of steering. Cancel defaults to the queued item and to "Keep". Make Esc interrupt the current turn, make typing during a turn steer it (with queue as an explicit option), and default cancel to the running work. _Phase 3._
3. **Approval choices are Deny / Approve once only,** in local coding, with internals (UUID, digest, revision, expiry) shown to the user. Add "for this session" and per-repo rules, and move the binding details behind a key. _Phase 2._
4. **Model and thinking are locked per session.** `/model` and `/thinking` only apply to new sessions, and the picker defaults to "Offline demo". _Phase 2._
5. **Resume needs the session ID**, and starting takes three commands. Add `salaam` / `salaam --continue` for this repo. _Phase 1._
6. **The Changes tab shows operation records, not a diff,** and its preview showed the pre-edit text. Point it at the live diff (`/diff` already has one). _Phase 3._
7. **Undo is one step and reviews the whole file.** Add a turn picker and a diff view. _Phase 3._
8. **Input handling:** no `@` completion popup appeared, `@` contents are probably not attached, and Ctrl+U does not clear the input. _Phase 3._
9. **Read-only / plan mode exists** (`/permissions` → Inspect only) but sits behind a menu. Add a one-key mode cycle. _Phase 2._
10. **The status line goes stale** ("Instruction accepted." after the turn ended), and the help text is stale ("unsandboxed commands"). _Phase 1._

## Appendix C: Salaam inventory

Sources: the code (`src/tui*.ts`, `src/cli*.ts`, `src/local-*.ts`, `src/acp/server.ts`, `src/tui/input.ts`) and the docs (`docs/tui.md`, `docs/autonomy.md`, `docs/context-and-skills.md`, `docs/clients.md`, `docs/mcp.md`, `docs/coding.md`).

The hands-on evidence is step 0's run on this Mac (`step0-findings.md`, CLI and headless). The full-screen TUI needs a real terminal (TTY), which this agent's shell cannot provide. So TUI behaviour here comes from code and docs, not from interactive use. Three TUI points stay unmeasured: time to first token, how diffs look, and undo.

Legend: **P** present · **~** partial · **M** missing.

| #   | Dimension                       |     | Evidence                                                                                                                            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Start                           | ~   | step 0; `cli-help.ts`                                                                                                               | It takes 3 commands: `sal service start --provider anthropic --state …`, `sal session create --local-coding --cwd …`, `sal attach <id>`. The service and the session each start in about 1 s. A long `--state` path fails with "too long for a Unix socket". Auth reuses `~/.config/salaam/credentials/<provider>`. There is no single `salaam` command for "start here". The `sal` on PATH is the operator's 0.0.3 checkout.                                                                                                                                                                                                                                                                                                     |
| 2   | TUI                             | P   | `tui.ts:1-40,324-342`, `tui-view.ts:1,77-79,138-155`, `tui-theme.ts`, `docs/tui.md:45-62`                                           | Built on pi-tui. Messages render as Markdown. There are four tabs: Conversation, Changes, Commands and Context. **Input:** multiline (Alt+Enter, Ctrl+J or Shift+Enter), per-session drafts, input history (`addToHistory`), and an external editor (Ctrl+E, using `VISUAL`, then `EDITOR`, then `vi`). **Navigation:** a command palette (Ctrl+K), session picker and new session (Ctrl+P, Ctrl+N), approvals (Ctrl+O), tabs (Ctrl+G, Ctrl+T), and a rail toggle (Ctrl+B). Two themes, Night and Paper, plus `NO_COLOR`. Live token previews are bounded; committed messages replace them. **Missing:** vim mode, custom keybindings, mouse support (not found).                                                                 |
| 3   | Context in                      | ~   | `tui.ts:189-190` (CombinedAutocompleteProvider with cwd); pi-tui `autocomplete.js:315` (`@` file completion via `fd`); `acp.ts:608` | `@` completes file paths, needing `fd`, which is installed here. But the path is sent as plain text: Pi expands `@file` only in its own CLI and print mode, not in the RPC mode Salaam uses. So the model still has to read the file itself. **No images**: ACP advertises `image:false`, and the TUI has no image paste. No URL fetch on input (fetch only as a model tool, through the broker). No stdin piping into a session.                                                                                                                                                                                                                                                                                                 |
| 4   | Project instructions and memory | ~   | `docs/context-and-skills.md`                                                                                                        | Pi's automatic discovery of context, skills and prompts is **switched off on purpose**. `AGENTS.md` and skill bundles load only after an explicit `/skills review AGENTS.md …`, which pins them by digest within 128 KiB; a change needs a new review. There is no automatic `AGENTS.md`, `CLAUDE.md` or `.salaam` instructions on start, and no "memory" the model writes itself. The persona is pinned only for station hosts, not local sessions. Safer than the others, but a daily-use speed bump.                                                                                                                                                                                                                           |
| 5   | Modes                           | ~   | `docs/autonomy.md`, `/permissions`, `/plan`                                                                                         | Three permission presets: **Inspect** (read-only), **Review every mutation** (the default), and **Auto-approve scoped edits** (exact files or `dir/` prefixes, revision-checked, kept across restarts). They can be changed mid-session through `/permissions`. **There is no auto mode for commands**: every shell command needs an exact approval. `/plan` is a model request, not an enforced plan mode. `/progression` (manual or bounded steps) is separate from permissions.                                                                                                                                                                                                                                                |
| 6   | Approvals                       | P/~ | `approvals`, Ctrl+O, step 0 wording                                                                                                 | Each approval is bound to the exact operation: the edit's old and new contents, or the exact command, working directory and timeout. The wording is clear, for example "Runs as your local user, in a Seatbelt sandbox (workspace-write): … no network". "Always allow" exists per agent for workspace **writes** on stations, and as the scoped-edit preset locally. Missing: "always allow this command" or a command allowlist per repo. In step 0 that meant 1–3 approvals per small task, the first about 30 s in.                                                                                                                                                                                                           |
| 7   | Diffs                           | ~   | `docs/tui.md:27,70,105-111`, `/diff`, `local-diff.ts` (22 lines), `workspace-diff.ts`                                               | The approval view shows each file's old and replacement contents, up to 8 files and 32 KiB. The Changes tab shows recorded local edit proposals and outcomes. `/diff` shows the actual git changes; Ctrl+R refreshes it. Missing: accepting or rejecting a single hunk, a side-by-side or word diff, and inline diffs in the conversation (not confirmed in code).                                                                                                                                                                                                                                                                                                                                                                |
| 8   | Undo                            | ~   | `/undo`, `local-undo.ts` (143 lines), `docs/tui.md:31-35`; task checkpoints                                                         | `/undo` reviews and reverts the **last** completed local edit (one level), keeps the conversation, refuses if files changed since, and **cannot undo shell commands**. A crash leaves a durable fence that `/undo reconcile` clears. Task checkpoints with capture, compare and restore exist for durable tasks. Missing: rewinding to any earlier turn (Claude Code's `/rewind`, Cline's checkpoints) and undoing both code and conversation together.                                                                                                                                                                                                                                                                           |
| 9   | Sessions                        | P   | `/sessions` (`/resume`), `/name`, `/history`, `/fork`, `/export`, `/copy`                                                           | Durable sessions survive daemon and TUI restarts; detaching leaves work running. Listing and resuming work (step 0: a session was still listed after a restart, as `exited`). `/fork` branches an idle local conversation, sharing the workspace. `/export` writes Markdown and never overwrites. `/history` pages through the full saved history, including before compaction. **Strong**: durable control and outbox records with replay-safe delivery.                                                                                                                                                                                                                                                                         |
| 10  | Context management              | ~   | `/compact`, `/context`, `/usage`, `/status`, `/model`, `/thinking`                                                                  | Compaction is manual, at an idle boundary, from a durable checkpoint. Usage and context can be inspected, including "unknown" observations. **Model, provider and thinking can be chosen only for a new session**, not changed mid-session. No live cost or token meter was found in the status line. No automatic compaction threshold found.                                                                                                                                                                                                                                                                                                                                                                                    |
| 11  | Commands and extensibility      | ~   | `tui-commands.ts` (35 commands), `docs/mcp.md`, `/agents`, `/skills`                                                                | **Present:** 35 built-in slash commands plus a palette; operator-declared MCP over stdio or HTTP (`sal mcp`, `--mcp-config`, no secrets in the file); reviewed skills; child and specialist workers (`/agents`, a read-only reviewer and explorer); `/queue` and `/steer` for in-flight guidance. **Missing:** user-defined slash or prompt commands, user hooks (pre/post tool), plugins, and background shells. Commands run in the foreground only, with a 2-minute maximum and 64 KiB of output.                                                                                                                                                                                                                              |
| 12  | Git helpers                     | M/~ | `/diff`, `/review`                                                                                                                  | Read-only git diff, and `/review`, which asks the model to review the changes. Missing: commit and message generation, branch and PR helpers, and auto-commit as in Aider. **Git inside commands is blocked on macOS** (finding 15).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 13  | Editor and IDE                  | ~   | `docs/clients.md:30-104`, `acp.ts:608`                                                                                              | An ACP v1 stdio server, with a Zed `agent_servers` template documented. **Limits:** no images or embedded context, no client terminal or file-system delegation, no modes, no model selection, no dynamic MCP (`mcpServers` must be `[]`; Zed's forwarded servers must be disabled). Only the checked-in client fixture proves it; there is no recorded Zed session. No VS Code or JetBrains extension.                                                                                                                                                                                                                                                                                                                           |
| 14  | Headless and scripting          | P   | `sal session submit`, `approvals approve --digest --revision`, `attach --plain`, ACP, the operator socket API, jobs and schedules   | Strong for automation: durable submits, an outbox, one-shot jobs, recurring schedules, and an operator inbox. There is no one-line `salaam -p "…"` print mode like `claude -p`; it takes a session plus submit plus polling.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 15  | Sandbox on macOS                | ~   | step 0; `command-sandbox.ts` (Seatbelt profile)                                                                                     | Seatbelt with workspace-write and no network works, and the profile is deny-by-default. **It blocks git** (`/usr/bin/git` is an `xcrun` shim; its Xcode licence and developer-dir reads are denied, giving exit 69) **and toolchains outside the repo** (`~/.npm`, nvm, cargo, go, a `node_modules` symlink into home). The network allowlist through stk exists (#99), but needs stk running on the Mac. **One failed command fails the whole attempt** (`local-coding.ts`), even after the model recovers. The model isn't told it's on macOS with BSD tools, so its GNU `sed -i` fails. The docs are stale: `docs/autonomy.md` and `docs/tui.md:111` still say "without an OS sandbox", and so does the `--local-coding` help. |
| 16  | Unique to Salaam                | P   | `task-*.ts`, `task-critic.ts`, `station-checkpoints.ts`, `acp-outcome.ts`, `usage-evidence.ts`                                      | Not found elsewhere: **approvals bound to the exact operation**, rechecked by content hash before applying; durable tasks with **verified checks and sealed receipts**; a **completion critic** with a read-only reviewer; **checkpoint restore bound to both tree digests**; **durable sessions and an outbox** that never replay uncertain effects; a policy revision recorded with each auto-decision; evidence and usage observations ("unknown" stays unknown); and a sandbox that is refused by default, with an opt-in.                                                                                                                                                                                                    |

### Summary

**Already solid:**

- **A capable TUI:** a palette, tabs, multiline input, an external editor and themes.
- **Durable sessions:** resume, fork, export and history.
- **Exact approvals** and a scoped-edit auto-approve preset.
- **MCP, skills and child workers.**
- **Strong scripting and ACP basics.**

**Blocks a desk-side daily driver**, worst first:

1. **macOS sandbox:** git and toolchains are blocked (15).
2. **A failed command fails the whole attempt** (15).
3. **Three commands to start, with no `salaam` "here" command** (1).
4. **Every command needs an approval**, with no command allowlist (5, 6).
5. **No automatic project instructions** (4): a reviewed `AGENTS.md` is required each time it changes.
6. **Model and thinking are fixed per session** (10), with no live cost meter.
7. **Undo is one level and edits only**; there is no rewind to a turn (8).
8. **No per-hunk diff review** (7).
9. **`@` completes paths but doesn't attach file contents; no images** (3).
10. **No user hooks, custom commands, background shells or git commit helpers** (11, 12).
11. **ACP gaps for editors** (13): images, modes, model selection and MCP.
12. **Stale docs and help text** about the sandbox (15).

**Not measured, because there was no TTY:** time to first token in the TUI, how diffs actually look, the undo flow, and how resume feels interactively.

## Appendix D: Harness matrix

Date: 2026-10-31. Scope: the interactive daily-driver experience, not autonomy or safety (the 2026-10-24 Salaam note covers those).

**Method.** I fetched official docs and changelogs on 2026-10-31. Cells say "n/d" (not documented) when the pages I read did not cover the item. I did not guess. Cells marked `(3p)` come only from third-party sources. Three findings change the field:

- **Kimi CLI is archived.** It was replaced by **Kimi Code CLI**, and old installs "will stop working". The Kimi column describes Kimi Code CLI.
- **Gemini CLI** was replaced by Antigravity CLI for the free and Google One tiers on 2026-06-18.
- **goose** moved to `aaif-goose/goose` under the Agentic AI Foundation. The block.github.io docs return 404, and goose-docs.ai pages came back empty.
- The **Amp** manual is behind a sign-in. Amp cells come from ampcode.com/news.

Sources (column key → URL):

- CC = Claude Code: https://code.claude.com/docs/en/interactive-mode
- CX = Codex CLI: https://learn.chatgpt.com/docs/codex/cli and https://developers.openai.com/codex/guides/slash-commands
- GM = Gemini CLI: https://geminicli.com/docs/ and https://geminicli.com/docs/reference/commands/
- OC = OpenCode: https://opencode.ai/docs/ and https://opencode.ai/docs/permissions/
- AD = Aider: https://aider.chat/docs/usage/commands.html
- CU = Cursor CLI: https://cursor.com/docs/cli/overview and https://cursor.com/docs/cli/using
- AM = Amp: https://ampcode.com/news and https://ampcode.com/manual/appendix/legacy-permissions-rules.txt
- GO = goose: https://github.com/block/goose (now aaif-goose)
- CR = Crush: https://github.com/charmbracelet/crush
- KM = Kimi Code CLI: https://www.kimi.com/code/docs/en/kimi-code-cli/guides/interaction.html and the kimi-command reference
- PI = Pi: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/docs (slash-commands.md, sessions.md, mcp.md, security.md, keybindings.md, compaction.md)
- CL = Cline: https://docs.cline.bot/llms.txt and https://docs.cline.bot/core-workflows/checkpoints.md

### A. Start, TUI, context in (dimensions 1–3)

|     | 1 Start / auth                                   | 2 TUI: editor, keys, themes                                                                                                                         | 3 Context in                                                   |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| CC  | yes: `claude` in any repo; sub or key            | yes: vim mode (`jj` remap), Ctrl+R history search, Ctrl+G external editor, rebindable keys, themes, transcript viewer (Ctrl+O), fullscreen renderer | yes: @ mentions, image paste, `!` bash                         |
| CX  | yes: installer, ChatGPT sign-in                  | partial: composer, VISUAL/EDITOR for long prompts; vim n/d                                                                                          | yes: `--image` and paste; `/mention path`; @ n/d               |
| GM  | yes: npm; personal or enterprise auth            | yes: `/vim`, `/theme`, settings editor                                                                                                              | yes: `@path` (gitignore-aware), `!` shell mode; images n/d     |
| OC  | yes: many package managers; `/connect`           | yes: themes, keybinds; also desktop app                                                                                                             | yes: fuzzy @ file, drag-drop images                            |
| AD  | yes                                              | yes: `--vim`, multiline `{ }`, `/editor`, `/voice`                                                                                                  | yes: `/add`, `/read-only`, `/paste` image, `/web` URL          |
| CU  | yes: `agent` install script                      | partial: n/d beyond modes                                                                                                                           | yes: @ files and folders; images n/d                           |
| AM  | yes: CLI (rebuilt 2026-05), web, mobile          | partial: TUI sidebar removed 2026-08                                                                                                                | n/d                                                            |
| GO  | yes: CLI + desktop + API; 15+ providers          | n/d                                                                                                                                                 | n/d                                                            |
| CR  | yes: brew, npm, winget, Nix; Ctrl+L model picker | yes: Ctrl+P palette, themes with live editing                                                                                                       | n/d                                                            |
| KM  | yes                                              | yes: Shift-Enter/Ctrl-J newline, per-dir history, Ctrl-G editor                                                                                     | yes: @ path completion, Ctrl-V image or video paste, `!` shell |
| PI  | yes: curl/npm/Nix, `/login`                      | yes: named actions in `keybindings.json`, `/hotkeys`, themes                                                                                        | yes: `@path`; images n/d                                       |
| CL  | VS Code extension, plus `npm i -g cline` CLI     | IDE                                                                                                                                                 | yes: @ context (docs page "Adding Context")                    |

### B. Memory, modes, approvals (dimensions 4–6)

|     | 4 Instructions / memory                                                  | 5 Modes and mid-session switch                                                                                                   | 6 Approvals                                                                                                                                              |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC  | CLAUDE.md hierarchy, auto memory, /init                                  | Shift+Tab cycles Manual → acceptEdits → plan → bypass                                                                            | per tool, command and path rules; persisted "always"                                                                                                     |
| CX  | AGENTS.md, `/init`                                                       | `/permissions` (legacy `/approvals`); review mode is read-only                                                                   | untrusted / on-request / never `(3p)`                                                                                                                    |
| GM  | GEMINI.md, `/memory`, `/init`, auto memory                               | `/plan` read-only; trusted folders                                                                                               | n/d in the pages read                                                                                                                                    |
| OC  | AGENTS.md via `/init`                                                    | **Tab** switches Plan and Build agents                                                                                           | best documented: allow/ask/deny per tool, bash globs, paths; `once/always/reject` where always lasts the session; `doom_loop` guard; per-agent overrides |
| AD  | n/d (conventions files)                                                  | `/ask`, `/code`, `/architect`, `/context`                                                                                        | n/d; edits are auto-committed                                                                                                                            |
| CU  | `.cursor/rules` plus root AGENTS.md and CLAUDE.md                        | Shift+Tab or `/plan`, `/ask`, `--mode`                                                                                           | y/n per command                                                                                                                                          |
| AM  | AGENTS.md (page behind login)                                            | "Dial" low/medium/high/ultra (2026-07)                                                                                           | `amp permissions` rules; passkey "Proof of Human" for some operations                                                                                    |
| GO  | n/d                                                                      | auto / approve / smart_approve / chat via `/mode` `(3p)`; default is autonomous `(3p)`                                           | n/d                                                                                                                                                      |
| CR  | CRUSH.md and AGENTS.md (global and project); init with configurable name | n/d                                                                                                                              | allow/deny tools in config; read-only bash runs unprompted; `--yolo`                                                                                     |
| KM  | AGENTS.md, /init `(3p)`                                                  | Shift-Tab or `/plan`; Always Ask / `/yolo` Ask When Needed / `/auto` Never Ask; leaving plan mode always needs you; `/goal` mode | 1/2/3 keys; "approve for this session"; permanent allow/deny in config                                                                                   |
| PI  | context files; project trust gates their loading                         | none: no plan mode by design                                                                                                     | **none**: "does not ask for approval before every tool call"; isolate it with a sandbox                                                                  |
| CL  | `.clinerules`                                                            | Plan & Act                                                                                                                       | Auto Approve and YOLO pages                                                                                                                              |

### C. Diffs, undo, sessions, context (dimensions 7–10)

|     | 7 Diffs / edits                                                                    | 8 Undo                                                                                    | 9 Sessions                                                                                                                                                    | 10 Context, models                                                                                                    |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| CC  | inline diffs, open in editor                                                       | Esc Esc rewind of code and/or conversation (checkpoints)                                  | `/resume`, continue, fork                                                                                                                                     | auto-compact, /model, effort control, cost display                                                                    |
| CX  | live diffs, `/diff` includes untracked files, `/review` against a branch or commit | `/undo` turn `(3p)`; docs also suggest git checkpoints                                    | `codex resume`, chat search, `/fork` `(3p)`, cloud handoff                                                                                                    | `/model`; compaction n/d                                                                                              |
| GM  | n/d                                                                                | `/rewind` (Esc Esc) reverts chat and files; `/restore` reverts files to before a tool ran | `/resume`, `/chat` tagged checkpoints                                                                                                                         | `/compress`, `/model`, thinking budget, `/stats`                                                                      |
| OC  | n/d                                                                                | `/undo` and `/redo`                                                                       | share and export: n/d in pages read                                                                                                                           | n/d                                                                                                                   |
| AD  | `/diff` since last message                                                         | `/undo` reverts aider's last git commit                                                   | `/save`, `/load`, `/copy-context`                                                                                                                             | `/tokens`, `/model`, `/reasoning-effort`, `/think-tokens`                                                             |
| CU  | **Ctrl+R review**: per-file, `i` adds a follow-up                                  | n/d                                                                                       | `agent ls`, `--continue`, `--resume=id`                                                                                                                       | `/summarize` (alias `/compress`); `/model` n/d                                                                        |
| AM  | "Diffs": review and stage in Amp (2026-06)                                         | n/d                                                                                       | threads shared; handoff instead of compaction; fork removed 2026-01                                                                                           | Dial modes; Puck "Explain Usage"                                                                                      |
| GO  | n/d                                                                                | n/d                                                                                       | resume and named sessions `(3p)`                                                                                                                              | n/d                                                                                                                   |
| CR  | n/d                                                                                | n/d                                                                                       | multiple sessions per project; clients can join a shared workspace                                                                                            | switch LLM mid-session, context kept                                                                                  |
| KM  | n/d                                                                                | `/undo`                                                                                   | `--continue`, `--session`, `/sessions`; can override mode on resume                                                                                           | `/compact`, `/model`; Ctrl-O shows compaction summaries                                                               |
| PI  | n/d                                                                                | via the tree: `/tree` navigation, `/fork` from an earlier message                         | **strongest**: `/tree` branches with branch summaries, `/fork`, `/clone`, `/name`, a searchable picker, `/export` HTML/JSONL, `/share` viewer link, `/import` | auto and `/compact [instructions]`, `/model`, `/thinking`, `/scoped-models` cycling, `/session` shows tokens and cost |
| CL  | Compare opens the IDE diff                                                         | **best**: shadow-git checkpoint after every tool; restore Files, Task, or both            | IDE task history                                                                                                                                              | n/d                                                                                                                   |

### D. Extensibility, git, IDE, headless, sandbox (dimensions 11–15)

|     | 11 Commands / extensibility                                                                                                    | 12 Git                                              | 13 IDE / ACP                                  | 14 Headless                               | 15 Sandbox default                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------- | ----------------------------------------- | ------------------------------------------ |
| CC  | slash and custom commands, hooks, skills, plugins, MCP, subagents, background bash and agents (Ctrl+B, `/tasks`)               | commit and PR flows, worktrees, co-author trailer   | VS Code and JetBrains; ACP through an adapter | `-p`, JSON / stream-json                  | permission prompts; optional OS sandbox    |
| CX  | skills, plugins, hooks, subagents, `codex mcp`; steer mid-turn                                                                 | worktrees (named in nav only)                       | IDE extension                                 | `codex exec`                              | workspace-write in git repos `(3p)`        |
| GM  | TOML custom commands, extensions, skills, hooks, subagents (also remote), MCP                                                  | git worktrees                                       | IDE companion, ACP mode                       | headless mode                             | optional sandboxing                        |
| OC  | custom commands, plugins, agents, MCP, LSP, custom tools, SDK, server                                                          | n/d                                                 | IDE extension, ACP                            | n/d in pages read                         | none; permissions only                     |
| AD  | `/run`, `/test`, `/lint` feed output back into the chat                                                                        | auto-commit, `/commit`, `/git`                      | n/d                                           | n/d                                       | none                                       |
| CU  | MCP via the editor's `mcp.json`; `&` sends to a Cloud Agent                                                                    | `-w/--worktree`                                     | Cursor editor                                 | `-p --output-format json`                 | `/sandbox` toggle (network)                |
| AM  | skills (replaced custom commands), plugins, custom agents, Puck meta-agent                                                     | n/d                                                 | n/d                                           | `-x` execute `(3p)`; Streaming JSON (nav) | Orbs, remote or self-hosted                |
| GO  | 70+ MCP extensions, recipes `(3p)`                                                                                             | n/d                                                 | uses ACP for subscriptions                    | `goose run` `(3p)`                        | n/d                                        |
| CR  | Agent Skills, hooks (preliminary), MCP stdio/HTTP/SSE with OAuth, LSP                                                          | commit trailer: assisted-by, co-authored-by or none | n/d                                           | n/d                                       | n/d                                        |
| KM  | skills as `/skill:name`, MCP                                                                                                   | n/d                                                 | `kimi acp` (Zed, JetBrains)                   | print mode `(3p)`                         | n/d                                        |
| PI  | extensions, skills, prompt templates, Pi packages on npm or git, MCP stdio/HTTP (`pi mcp add`, `/mcp`); no subagents by design | n/d                                                 | ACP through pi-acp (external)                 | print, JSON, RPC, SDK                     | **none**; docs recommend a container or VM |
| CL  | workflows, hooks (SDK plugins), MCP, subagents                                                                                 | Kanban: parallel agents in worktrees                | the IDE itself                                | CLI headless                              | n/d                                        |

### E. Ideas worth copying (dimension 16)

- **CC:** queue messages while the agent works and flush them with Ctrl+Enter; Ctrl+B sends a running command to the background; a timed-out command moves to the background instead of being killed; double Esc saves a cleared draft to history.
- **CX:** `/review` against a base branch; steer the active turn; hand off to the cloud and apply the result locally.
- **GM:** two distinct undo verbs (`/rewind` for the conversation, `/restore` for files from before a tool ran); tagged chat checkpoints.
- **OC:** the `doom_loop` guard (asks after the same call repeats three times); Tab toggles Plan and Build; `external_directory` rule.
- **AD:** `/test` and `/lint` feed failures straight back into the chat; `/voice`; `/web`; an architect/editor model pair.
- **CU:** Ctrl+R diff review with an `i` follow-up per file; the `&` prefix sends work to the cloud; the masked sudo prompt never shows the password to the model.
- **AM:** handoff to a new thread instead of compaction; steer instead of queue; voice control of agents through Puck.
- **CR:** desktop notification when a permission is needed or a turn finishes; join one workspace from several clients; configurable attribution trailer.
- **KM:** "approve for this session"; leaving plan mode always needs a human; `/goal` with queued next goals; Ctrl-S injects input into the running turn.
- **PI:** a session tree with branch summarisation; `/share` returns a viewer link; HTML export; keybindings by named action.
- **CL:** a shadow-git snapshot after every tool, including untracked files, with a three-way restore.

### Best in class per dimension

1. **Start:** OpenCode (widest install matrix plus `/connect`).
2. **TUI:** Claude Code (vim mode, history search, external editor, transcript viewer).
3. **Context in:** Aider (`/web`, `/paste`, `/read-only`, `/voice`); Kimi for pasting video.
4. **Memory:** Claude Code (hierarchy plus auto memory); Gemini and Cursor also read others' files.
5. **Modes:** Kimi (three autonomy levels, plan exit gated, `/goal`); Claude Code's Shift+Tab cycle.
6. **Approvals:** OpenCode (pattern rules, once/always/reject, doom_loop).
7. **Diffs:** Cursor (Ctrl+R review); Codex `/review` against a branch.
8. **Undo:** Cline (shadow git, three-way restore); Gemini `/rewind` and `/restore`; Claude Code rewind.
9. **Sessions:** Pi (tree, fork, clone, export, share, import).
10. **Context management:** Pi (`/compact` with instructions, branch summaries, scoped model cycling); Aider for model and effort knobs.
11. **Extensibility:** Claude Code (hooks, skills, plugins, subagents, background tasks).
12. **Git:** Aider (auto-commit plus undo); Cursor `-w` worktrees; Crush trailers.
13. **IDE / ACP:** Gemini, Kimi and OpenCode (native ACP).
14. **Headless:** Pi (print, JSON, RPC, SDK); Claude Code `-p` stream-json.
15. **Sandbox:** Codex (sandboxed by default); Amp Orbs for remote isolation.

### Top 15 features a daily-driver harness must have (ranked)

| #   | Feature                                                                  | Have it (documented)                     | Pi today                                  |
| --- | ------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------- |
| 1   | Streaming TUI, multiline editor, history and external editor             | CC, KM, AD, GM, PI                       | yes                                       |
| 2   | @-file fuzzy mention and image paste                                     | CC, OC, KM, AD; @ only: GM, CU, PI       | partial (images n/d)                      |
| 3   | Approval prompts with allow/ask/deny rules and "always for this session" | OC, CC, KM, CR, CU                       | **no**                                    |
| 4   | One-key mode switch between plan/read-only, accept edits and auto        | CC, CU, KM (Shift+Tab); OC (Tab)         | **no** (no plan mode by design)           |
| 5   | Undo or rewind of files and conversation                                 | CL, GM, CC, OC, AD, KM                   | partial (tree and fork, not file restore) |
| 6   | Resume, continue and a searchable session picker                         | CC, CX, CU, KM, PI, GM                   | yes                                       |
| 7   | Auto-compaction plus manual compact                                      | CC, PI, GM, CU, KM                       | yes                                       |
| 8   | Mid-session model and thinking switch                                    | CC, PI, AD, CR, GM, CX                   | yes                                       |
| 9   | Diff review before accepting (per file, with a follow-up)                | CU, CX, AM, CL, AD                       | n/d                                       |
| 10  | AGENTS.md hierarchy and /init                                            | CX, OC, CU, CR, GM, CC                   | partial                                   |
| 11  | Queue or steer while running, and interrupt without losing work          | CC, CX, KM, AM                           | n/d in pages read                         |
| 12  | Custom slash commands, skills and MCP                                    | CC, GM, OC, CR, PI, CX                   | yes                                       |
| 13  | Background shells and tasks                                              | CC, KM                                   | n/d                                       |
| 14  | Headless JSON mode for scripts and CI                                    | CC, CU, PI, CX, GM                       | yes                                       |
| 15  | Notifications and status (cost, tokens, "needs you")                     | CR (desktop notify), CC, PI (`/session`) | partial                                   |

**Takeaway for Salaam.** Pi already leads on sessions and scripting (items 6–8, 12 and 14). The daily-driver gaps are items 3, 4, 5, 9, 11 and 13. That is the interactive approval and mode layer Pi leaves out on purpose, and Salaam's own admission and approval machinery could fill it. The highest-value copies: OpenCode's rule model, Claude Code and Kimi's Shift+Tab mode cycle with a gated plan exit, Cline's shadow-git restore, and Cursor's Ctrl+R review.
