# Salaam in your terminal

Run `npm run build` after updating this checkout. Bare `sal` opens the Salaam session picker in an interactive terminal; `sal tui --session UUID` and `sal attach UUID` reconnect directly. Scriptable CLI commands remain available. `sal attach UUID --plain` selects the line interface explicitly, and piped attachments use it automatically.

```sh
sal
sal tui --session SESSION_ID --theme paper
sal attach SESSION_ID --observe
sal attach SESSION_ID --takeover
```

New sessions created in the TUI can inspect the selected local workspace on macOS and Linux without Docker. They can list, read and search actual files. The local inspection profile cannot edit files or execute commands. Hidden paths, credentials/secrets directories, dependency/build directories, symlinks, hard-linked files and database/key files are excluded. Reads are bounded to 256 KiB per file and 16 KiB per page; searches report truncation. Use a narrower path when a scan reaches its limit.

Type `/` to see command completions. Tab or Enter accepts a completion; Enter then runs the command. Commands and aliases share one registry with the action palette and `/help`. Unknown commands and malformed arguments remain in the composer. Only `/queue`, `/steer`, `/plan`, and `/review` send instructions to the model; plan and review ask for confirmation first.

| Commands                                                               | Action                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/help [command]`, `/commands`, `/keys`                                | Command reference and keyboard shortcuts                                                                                                         |
| `/exit`, `/quit`, `/q`                                                 | Detach the terminal; keep the daemon, session and work running                                                                                   |
| `/model [provider/model]`, `/provider [provider]`, `/thinking [level]` | Choose configuration for a new session; reasoning levels are off, minimal, low, medium, high, subject to model support                           |
| `/new [workspace]`, `/coding [workspace]`                              | Create an inspection or reviewed local coding session                                                                                            |
| `/sessions [id]`, `/resume [id]`, `/name <name>`                       | Resume a saved session or set its durable label                                                                                                  |
| `/history`, `/compact`, `/context`, `/status`, `/usage`                | Inspect history/context/usage or compact at an idle boundary                                                                                     |
| `/cancel`, `/stop`                                                     | Explicitly cancel a selected active or queued instruction; these do not stop the daemon                                                          |
| `/queue [text]`                                                        | Save a durable next-turn instruction, or inspect queued work                                                                                     |
| `/steer <text>`                                                        | Send guidance during an active local turn; the service records intent before delivery and never replays an uncertain delivery                    |
| `/diff`, `/tools`, `/approvals`                                        | Review Git changes file by file, capabilities, tool activity and exact approval requests                                                         |
| `/copy`, `/export [path]`                                              | Copy the last complete assistant response on macOS, or export captured history (including pre-compaction records) to a new private Markdown file |
| `/settings`                                                            | Terminal appearance, shortcuts and model selection                                                                                               |
| `/fork`                                                                | Fork an idle local conversation through Pi's session manager; share the workspace, but not pending approvals or task authority                   |
| `/rewind`, `/rewind N`                                                 | Restore files, the conversation or both to before an earlier turn: one reviewed summary, one confirm                                             |
| `/undo`, `/undo reconcile`                                             | Review the inverse of the last completed local edit, or verify files after an interrupted undo without replaying mutations                       |
| `/plan [request]`, `/review [focus]`                                   | Submit a planning or code-review instruction using the current provider; these are prompts, not enforced permission modes                        |
| `/skills`, `/mcp`, `/agents`, `/tasks`                                 | Inspect skill admission, managed MCP, worker profiles/children, or open durable task actions                                                     |

Shift+Tab (or `/mode`) cycles a coding session through **review** (every edit and command asks), **accept edits** (ordinary project edits apply without asking) and **auto** (edits, and commands that stay inside the OS sandbox, run without asking). There is no plan mode; a session saved in it opens in review. Two further levels are separate commands and survive the cycle:

- `/full-access` runs later commands without the OS sandbox and without asking, except commands the danger check calls dangerous. Those still ask and say why. The check reads the plain shell subset only (simple commands joined by `&&`, `||`, `;`, `|`). It unwraps `sudo`, `env`, `timeout`, `nice`, `xargs`, `find -exec` and `sh -c` up to three levels, and treats anything it cannot read as dangerous: substitutions, heredocs, pipes into a shell, and writes outside the workspace. A repo's approval rules cannot approve a dangerous command; your own session or user rules can. The host must allow it (`allow_full_access_sessions`).
- `/yolo` asks you to type `yolo`, then approves every edit and command with no sandbox. The status line shows a red `YOLO`. Each approval is recorded as `permission.yolo-approved`, with what full access would have asked. It is only for your own desk sessions, never host-managed, board or child work, and a host must set `allow_yolo_sessions: true`. `/yolo` again turns it off.
- `/classifier` opens a picker of the configured command reviewers plus Off, like `/model`; `/classifier NAME|on|off` sets it directly. It exists only when the service is started with `--danger-classifier-config FILE` (or `SALAAM_DANGER_CLASSIFIER_CONFIG`); without one, nothing is ever sent. The file is JSON: `{"provider":"anthropic","model":"claude-haiku-5-5","key_env":"ANTHROPIC_API_KEY"}` or `{"provider":"openai-compatible","url":"http://127.0.0.1:11434/v1","model":"…"}`, with optional `"name"`, `"on_unavailable":"rules"|"ask"` (default `rules`) and `"timeout_ms"` (default 3000). To offer several, write `{"options":[…],"default":"NAME"|"off"}`. A host gets no reviewer unless its config names one: `"danger_classifier": {"config": "/abs/path.json", "pin": "NAME"}` (the file's digest is pinned in the reviewed manifest; `pin` fixes the choice, and sessions cannot change or turn it off) or `"forbid"`. The key is read from the named variable, never written in the file. In auto and full access, a command the danger check calls ordinary but cannot see into (inline code such as `node -e`, a repo script, `npm run`, `npx`, or a program it does not know) is sent, with secret-looking values redacted, together with the working directory and nothing else. The reviewer can only make the command ask, shown as `Dangerous (classifier): <reason> (reviewed by <model>)`; it can never let a command run that would otherwise ask. A reply that is not exactly the expected JSON asks. In review mode it is not consulted; in YOLO its verdict is only recorded. Each verdict is recorded as `permission.classifier`, and verdicts are cached per exact command per session.

A command with shell features (pipes, redirects) can never become an approval rule, so its prompt offers only Approve once and Deny. If a terminal is killed while holding control, the next `salaam code` waits out its lease (at most 15 s). A terminal that is still alive keeps control; press Ctrl+K and choose Take control to take it.

`/undo` refuses concurrent file changes and cannot reverse shell commands or external effects. A crash or partial failure leaves a durable fence across local coding sessions sharing the root. Inspect the recorded inverse and restore the original files before `/undo reconcile`; reconciliation verifies every file rather than retrying the edit. Conversation history stays intact.

`/rewind` lists the session's turns, newest first. Each turn checkpoints the folder before it starts, in a shadow Git repository under Salaam's state directory; the folder's own `.git` is never read or written, and `.gitignore`d files, `node_modules`, `.env*`, key files and Salaam's own state are not captured. Choose files, conversation or both, read the summary of what restoring does, and confirm once. Files are restored only if the folder is still exactly the tree you reviewed; otherwise nothing is written and you review again. A conversation rewind never cuts history: it forks a new session from before that turn, the old session stays as it was, and the turn's instruction comes back into the message box to edit. Commands and effects outside the folder are not undone. When files are written as a separate tools user, only the conversation can be rewound.

`/fork` requires an idle local session with no pending work or uncertain effects. The branch retains captured history; inherited provider usage is not charged to it again. Both conversations still point at the same files, so this is not a Git worktree or filesystem snapshot.

`/skills` reports the current disabled implicit skill-discovery policy; it does not install or enable skills. `/mcp` shows only admitted capabilities. Neither command silently expands authority. `/export` refuses existing destinations and includes tool records; review its contents before sharing.

Model and reasoning selection keep existing sessions and running work intact. Each local session retains its provider/model across daemon restarts. Configure authentication using `sal auth login PROVIDER` or `sal auth set PROVIDER`; choosing a catalog model does not establish account access. The header shows the selected session's model. Compaction preserves the saved transcript for history retrieval; its checkpoint is not a model-generated conversation summary.

Older sessions retain their original capabilities. Create a new local session to gain workspace inspection. If the daemon predates this feature, finish active work, run `sal service stop`, and reopen `sal` to load the updated executable.

The interface has two native palettes, **Night** and **Paper**, with jade accents, quiet surfaces, readable tool outcomes and no icon-font requirement. Choose `--theme night|paper` or switch from the action menu. `NO_COLOR=1` preserves the layout without color. Narrow terminals hide the workspace rail automatically; Ctrl+B toggles it on wide terminals (it is not readline back-char here). The terminal title and application chrome identify Salaam.

| Key                                  | Action                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Enter                                | Save the exact composer text to the durable outbox, then deliver it               |
| Alt+Enter / Ctrl+J                   | Insert a newline; Shift+Enter also works with supported keyboard protocols        |
| Ctrl+K (empty composer) / F2         | Search actions by visible name, description or ID                                 |
| Ctrl+P / Ctrl+N                      | Pick an existing session / create a new session                                   |
| Ctrl+O                               | Review operation-bound approvals                                                  |
| Alt+G / Ctrl+T                       | Open checked changes / command results                                            |
| Tab                                  | Complete slash input, otherwise cycle Conversation, Changes, Commands and Context |
| PageUp / PageDown                    | Scroll the body; mouse wheel is also supported                                    |
| Ctrl+X                               | Toggle the full transcript: every tool call and its recorded output               |
| F5                                   | Refresh service state and the current diff                                        |
| Ctrl+G                               | Edit the prompt with `VISUAL`, then `EDITOR`, then `vi`                           |
| Ctrl+R                               | Search messages you sent (reverse-i-search); Ctrl+R again for older, Esc restores |
| Ctrl+A/E, Ctrl+U/K/W, Ctrl+Y, Ctrl+- | Readline editing: line start/end, kill to start/end/word, yank, undo; Alt+B/F     |
| `!command`                           | Run a shell command yourself (local coding sessions; see below)                   |
| `?` with an empty composer           | Keys for where you are (conversation, running turn, change review)                |
| F1                                   | Same key sheet as `?`                                                             |
| Ctrl+C                               | Stop a running coding turn, else clear the composer; twice on empty detaches      |
| Ctrl+D with an empty composer        | Detach and leave work running                                                     |

The key sheet (`?`, F1 or `/keys`) is built from the same table the TUI binds (`src/tui-keymap.ts`), so it lists the keys that actually work. It changes with where you are: a running desk turn shows Esc, Enter and Tab; the Changes review shows its file, hunk, accept, revert and instruct keys. Approvals show their own keys along the bottom.

While a turn runs, the status line shows a live progress line: what the agent is doing (Thinking, Editing, Running a command), elapsed seconds, tokens and `esc to interrupt`. It repaints every second without input.

The editor accepts multiline Unicode paste; a paste over 10 lines or 1000 characters collapses to a `[paste #N +L lines]` marker that backspace removes whole, Ctrl+G shows in full, and Enter sends expanded. It keeps per-session drafts in memory. Messages you send are kept for Up-arrow and Ctrl+R across sessions in `$XDG_STATE_HOME/salaam/history.json` (mode 600, newest 500); anything that looks like a credential (API keys, tokens, `password=`, private keys, long base64) is never written, and `SALAAM_HISTORY=off` keeps history in memory only.

`!command` in a local coding session asks the model to run exactly that command through `salaam_local`, so it takes the same approval prompt, session mode, OS sandbox and danger check as any command the model runs; the terminal never runs it itself. Outside local coding it is refused. Unsubmitted drafts are not persisted after process loss. Quoted editor executable paths and arguments are supported; shell expansion is absent. The external editor gets normal terminal modes, a private temporary prompt file and a 64 KiB result limit. Terminal modes, alternate screen, bracketed paste and title are restored on normal detach and handled signals. A forced process kill cannot run terminal cleanup; open a new attachment to recover.

### Continue, resume and terminal status

`salaam -c` (or `salaam --continue`) is short for `salaam code --continue`: it reopens this folder's latest session, or starts one and says _No earlier session in this folder, so this is a new one._ The session picker (Ctrl+P, `salaam code --resume`) lists this folder's sessions first, newest first, each with what you last asked and how long ago.

The window title says the state: `Salaam · NAME · working`, `· needs you` while an approval waits, or `· idle`. Inside [Herdr](https://herdr.dev) the pane also reports `working`, `blocked` or `idle` and a resume command (`salaam --session ID`) through Herdr's documented `"$HERDR_BIN_PATH" pane report-agent` command, and releases the pane on exit; outside Herdr nothing is sent. Neither carries prompt or command text. `SALAAM_TERMINAL_STATUS=off` turns both off. The previous window title is restored on exit.

## Service truth in each view

Existing pre-coding daemons remain usable: missing coding/executor fields and routes mean those capabilities are off. Enabling the new coding tools requires a current service explicitly configured with its coding root and executor.

Conversation shows committed messages, queued instructions, bounded live previews, one compact line per recent tool call (`Edit src/x.ts +3 −1`, `Bash npm test ✓ exit 0` with the last three output lines; Ctrl+X shows all of them with their output), pending approvals and explicit interruptions. A preview is replaced by committed transcript state and discarded after connection loss; it is not a completion receipt. The recent transcript has a 100-message snapshot limit. **Browse full history** opens bounded saved entry pages, including before compaction; **Read artifact** opens saved evidence without acknowledging a child result. **Inspect tool activity** shows recorded inputs and outcomes under their original attempt/tool IDs. Input previews are bounded and indicate truncation.

In a local coding session, Changes is a per-file review of what changed in the folder since the review base (the first turn's checkpoint, moved forward as you accept). Alt+Left/Right moves between files and Alt+Up/Down between hunks (none selected means the whole file). With the message box empty, `a` accepts the selection (marks it reviewed; the file is not touched), `r` reverts it to the base after one confirm, and `i` starts a follow-up instruction about it. A revert is refused if the folder changed after you looked.

In a coding workspace, Changes displays a service-checked diff against the imported baseline and its workspace identity/revision. Alt+Left/Right pages files. Original source checkouts remain outside the writable coding copy. External edits or a locked workspace can prevent a checked diff; inspect the reported conflict and use the explicit `sal workspace refresh` workflow after reviewing its observed digest. A displayed old revision cannot authorize an edit to a newer revision.

Commands displays stable run IDs, captured workspace revisions, actual terminal states and exit codes. **Command logs** reads the captured output by byte offset. **Cancel a command** and **Cancel current work** are separate confirmed actions; neither is implied by detach. Unknown outcomes stay unknown and use the scriptable reconciliation workflow. Context shows the session/worker/workspace, explicit task facts, child/result identities, executor details and recorded/estimated/unknown usage.

Approval review shows the exact target and value in plain words, with a one-line reason it asks: the danger check's category and reason for a dangerous command, otherwise what the session mode leaves to a person. An edit shows its diff, added lines in jade and removed lines in red. `d` shows the binding: digest, revision, worker epoch, expiry and approval ID. Focus opens on **Approve once**, so Enter approves the request you see. `y` approves once, `n` denies, and in a desk session `s` approves for the session, `a` always in this repo, and `f` denies and opens a one-line reason that reaches the agent as feedback. If the turn has ended, that reason is put in the composer instead. In desk sessions there is no read-to-the-end gate; a long change says how many lines are below. Strict (host, board and child) work still has to be scrolled to the end before approval is enabled. Closing the card records no decision. Current binding/expiry checks and the server's durable decision admission reject stale requests. An observer may decide a bound approval without taking the controller lease. Concurrent requests are selected by target or ID.

The controller lease coordinates operators of the same trusted OS account. An observer cannot send instructions. Taking control is explicit and preserves running attempts and commands. A new controller retries journaled pending submissions with their original logical IDs. An interrupted attempt after service death is never silently replayed; **Continue interrupted work** requires a new instruction. **Stop service** is a separate confirmation affecting all of that service’s sessions.

## SSH to the same execution host

Install the pinned runtime/dependencies and CLI on the permitted execution host first. Start its host-local service with its own provider configuration, coding root and proven executor. No automatic deployment, public listener or credential copying is performed by `remote`.

```sh
sal remote MY_SSH_ALIAS --remote-bin /absolute/path/to/sal \
  --state /absolute/remote/state --session SESSION_ID
sal remote MY_SSH_ALIAS --remote-bin /absolute/path/to/sal \
  --state /absolute/remote/state --session SESSION_ID --observe
```

These paths belong to the remote host. If `--state` is omitted, the remote command uses that host’s normal state resolution. The remote executable defaults to `sal`; supply an absolute path when noninteractive SSH lacks its bin directory. Arguments are shell-quoted; SSH agent and configured port forwarding are disabled. SSH authentication and the host’s OS-account boundary remain the access control. Disconnecting SSH leaves service-owned work running. Reconnect with the same session ID, wait for the old lease to expire or choose Take control.

## Autonomy controls

Use `/permissions` for Inspect, Review, or scoped automatic edits. Use `/progression` independently for manual steps, bounded tasks, or schedules. Both appear in `/settings`. Shell commands still require explicit approval; local permission settings cannot grant missing capabilities or change managed-station authority. See [permissions and progression](autonomy.md).

## Durable task actions

Ctrl+K → **Task actions** creates or revises a JSON plan, starts/continues/reviews a step, runs configured checks, records completion or an explicit exception, grants bounded progression, pauses/cancels, and captures/compares/restores checkpoints. Context shows the objective, step IDs/states, dependencies, request/token reservations, elapsed runtime, remaining step grant and fresh verification status. The service enforces every action over the same controller/revision rules as the CLI. Lost replies remain in the durable outbox; stale actions remain rejected for review. Detach keeps admitted work running, pause prevents future steps, and cancel revokes active owned work. See [task controls](durable-tasks.md) for exact semantics and limits.

## One-shot job actions

Ctrl+K → **Job actions** binds the current unstarted checked task to a one-shot definition, reviews its complete binding, submits a stable occurrence key, or cancels owned work. Context shows the shared job/occurrence IDs and state. Ctrl+Home/End jumps to the start/end of long pages. Hard terminal loss preserves admitted work; an observer can inspect the same occurrence after reconnect. A repeated trigger cannot restart an interrupted attempt. See [jobs](jobs.md) for authority, outbox and recovery semantics.

Ctrl+K also exposes **Recurring jobs and schedules** and the global **Operator inbox**. Recurring templates capture a checked plan/workspace; each admitted occurrence has fresh work identities. Schedule revisions cannot change the template, and duplicate keys never dispatch another run. Inbox acknowledgement clears only the reviewed attention revision and never decides a permission. ACP shares the same records through Salaam extension methods/metadata.

## Local coding

Use `/coding` (or **New local coding session** in the action palette) to create a session with reviewed edits and native shell commands. Existing read-only sessions retain their permissions. The CLI equivalent is `sal session create --local-coding --cwd /absolute/project/path`.

The model reads a file and supplies its content hash with an edit. Review shows the old and replacement contents for each file; approving binds that exact proposal. Salaam rechecks file contents immediately before each replacement and refuses stale proposals. This is optimistic local editing, not a filesystem transaction against other processes writing at the same instant. Up to eight files can be reviewed together, within a 32 KiB review limit. Individual file replacement is atomic; a failure between files is recorded as uncertain, with applied paths retained. There is no automatic rollback over subsequent human changes.

Commands run as your local OS user inside the OS sandbox (Seatbelt on macOS, bubblewrap on Linux) at the session's level: workspace-write by default, so they can read the project and the toolchain and write only inside the project, with no network unless the host routes it through the broker. Full access and YOLO run them without the sandbox. A sandboxed command cannot listen for connections, unless the model marks it `listen: true` and you approve that exact command: auto mode, repo rules and the command reviewer never approve it, though your own session or user rule may. The approval warns that macOS cannot limit listening to localhost, so a server bound to `0.0.0.0` is reachable from your network. On Linux the bubblewrap sandbox has its own network namespace, so a server inside it cannot be reached from the host; a listening command is refused there with that reason (use full access for it). When the sandbox blocks a command it needs (listing your other processes or open apps, your home folder, system services), the model may ask to run that one command outside the sandbox, with `outside_sandbox` saying why. The approval shows the reason. It always asks except in YOLO: auto mode, repo rules and the command reviewer never approve it, though your own rule may. That command runs without the sandbox and the session stays sandboxed. It is refused where the operator forbids full access, and changes nothing under full access. The approval shows the exact command, working directory, sandbox and timeout. Salaam supplies a minimal environment rather than inheriting daemon API keys. Foreground commands have a two-minute maximum runtime and 64 KiB captured-output limit, and their process groups are cancelled with the attempt; long-running servers and watchers go in the background (`/jobs`).

Results appear in the conversation, the Changes/Commands tabs and durable operation receipts. The Commands tab shows recorded commands and outcomes; Changes reviews the folder itself against its checkpoints. A nonzero exit, timeout or cancellation is not reported as success. A controller restart during execution leaves an uncertain operation for inspection and explicit operator resolution; it never automatically repeats the command. Detaching from the TUI does not cancel work. The isolated executor profile retains its separate snapshot-based views.

## Git helpers

In a coding session, `/commit`, `/branch <name>` and `/pr [base]` ask the model to do the git work, and every git command it runs goes through the session's normal command approval and sandbox. Nothing runs git behind your back.

- `/commit` reads the status and diff, stages only the files that belong to the change, and commits with a message in the repository's style. The message is written to a file and committed with `git commit -F`, so the approval shows exactly what will be committed. The author is you, from your own git config; Salaam never invents one. A sandboxed command cannot read `~/.gitconfig`, so Salaam reads your `user.name` and `user.email` itself and passes them in. If either is missing the commit fails with git's own message.
- `/branch <name>` switches to the branch, creating it if needed. Names a shell would read specially are refused before anything is sent.
- `/pr [base]` pushes the current branch and opens a pull request into `base` (the remote's default branch if omitted) with `gh` for GitHub remotes or `tea` for Forgejo/Gitea. It refuses on the base branch itself.
- `/diff` opens the per-file review in Changes.

**Pushing and opening a pull request always ask**, in auto and full access too; only YOLO approves them, and YOLO records that it would have asked. A repository's own rules cannot approve them; a rule you add yourself can. The helpers never amend, rebase, reset, force-push, skip hooks (`--no-verify`) or change git config.

Commit trailers are yours to choose in `~/.config/salaam/git.json`:

```json
{ "trailers": ["Reviewed-by: Your Name <you@example.com>"], "session_trailer": true }
```

`session_trailer` adds `Salaam-Session: <session id>`. With no file, commits carry no trailers.

## Attaching files with `@`

In a local coding session, type `@` in the composer to complete a workspace file. The list
comes from git, so ignored files do not appear. Names with spaces are quoted (`@"my notes.md"`).

When you send the prompt, Salaam attaches each mentioned file:

- A text file is attached in full, up to 64 KiB per file and 256 KiB per prompt. A cut file is
  marked as truncated.
- An image (PNG, JPEG, GIF or WebP, recognised by its bytes) goes to the model as an image, up to
  512 KiB each and four per prompt.
- A directory attaches its listing. A binary file is named but not attached.
- A path outside the workspace, including through a symlink, is refused.
- A file that looks like a secret (`.env`, keys, `.netrc` and similar) needs a confirm first.

Each attachment is named with the start of its SHA-256 so the transcript shows which version the
model read. Board sessions are sent exactly what was typed; `@` is not expanded there.

## Custom commands

A custom command is a saved prompt. Put a Markdown file in `.salaam/commands/` in the repository,
or in `~/.config/salaam/commands/` for your own, and type `/name args`. The format follows Claude
Code's command files:

```markdown
---
description: Fix a GitHub issue
argument-hint: [issue-number]
---

Fix issue $ARGUMENTS, add a test, and run it.
```

- `$ARGUMENTS` is everything after the name; `$ARGUMENTS[0]`, `$0`, `$1`… are single arguments
  (quotes group words). `\$` is a literal dollar. With no placeholder, the arguments are added
  after the prompt as `ARGUMENTS: …`.
- A subdirectory becomes a namespace: `.salaam/commands/frontend/component.md` is
  `/frontend:component`.
- Your command wins over a repository's of the same name. A built-in command such as `/yolo`
  always wins; a file that tries to redefine one is skipped and listed under `/help`.
- A command only writes a prompt. It never runs anything, approves a tool or changes a mode, so a
  repository's commands are loaded without a trust step. `allowed-tools` and similar fields are
  ignored. The expanded prompt goes through the same checks as a typed one, including the confirm
  for secret-looking `@` files.
- Files are limited to 32 KiB, 200 per folder, and must stay inside their folder (symlinks
  included).

Custom commands appear in `/` completion and `/help`.

## Hooks

Hooks run your own commands when something happens in a desk session. The format is Claude
Code's:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./scripts/check.sh", "timeout": 30 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "npx prettier --write ." }]
      }
    ]
  }
}
```

**Where.** Yours are in `~/.config/salaam/hooks.json` (or `$SALAAM_HOOKS_FILE`) and always run. A
repository's `.salaam/hooks.json` does **not** run until you review it with `/hooks trust`, which
shows every command and records the file's SHA-256. Any change to the file needs trusting again.
`/hooks revoke` stops it; `/hooks` lists both files and their state.

**Events.** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `Notification` (an
approval is waiting). A matcher selects tools: empty or `*` is all, `Bash|Edit` are exact names,
anything else is a regular expression. Salaam's tools match by their own names
(`salaam_local`, `salaam_web_search`…) and by Claude Code's (`Bash` for a command, `Edit`/`Write`
for an edit, `Read`, `WebSearch`, `WebFetch`).

**Input and output.** The hook gets JSON on stdin with `session_id`, `cwd`, `hook_event_name` and
the event's fields (`tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `prompt`).

- Exit 0: carry on. For `UserPromptSubmit`, stdout (or `additionalContext`) is added to the
  prompt, up to 8 KiB.
- Exit 2: block. `PreToolUse` stops the tool call before any approval exists, and the model reads
  the reason (stderr) as the tool's result. `UserPromptSubmit` stops the prompt and the turn
  fails with the reason. Other events cannot block.
- A JSON `permissionDecision: "deny"` or `"decision": "block"` also blocks.
- **A hook can never approve.** `"allow"` and `"ask"` are recorded as ignored, and the request
  goes through Salaam's own approval, rules and mode as usual.
- Any other exit, or a timeout, does not block and shows a notice.

**How they run.** Each hook runs like one of the session's sandboxed commands: the same sandbox
and level, no network, a minimal environment (`SALAAM_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` are
set), at the workspace root. A script must be readable inside that sandbox, so keep it in the
workspace or an operator-allowed read path; `~/.config/salaam` is not readable from the sandbox.
On a host whose commands run as a separate tools user, hooks do not run. Timeouts default to
60 seconds (at most 600), output is kept up to 16 KiB per stream, and every run is recorded as a
`hook.run` event with its exit code, duration and output digests.

Hooks run only in your own desk coding sessions; board, station and child sessions run none.
