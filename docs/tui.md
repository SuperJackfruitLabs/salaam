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
| `/diff`, `/tools`, `/approvals`                                        | Inspect actual Git changes, capabilities, tool activity and exact approval requests                                                              |
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

A command with shell features (pipes, redirects) can never become an approval rule, so its prompt offers only Approve once and Deny. If a terminal is killed while holding control, the next `salaam code` waits out its lease (at most 15 s). A terminal that is still alive keeps control; press Ctrl+K and choose Take control to take it.

`/undo` refuses concurrent file changes and cannot reverse shell commands or external effects. A crash or partial failure leaves a durable fence across local coding sessions sharing the root. Inspect the recorded inverse and restore the original files before `/undo reconcile`; reconciliation verifies every file rather than retrying the edit. Conversation history stays intact.

`/rewind` lists the session's turns, newest first. Each turn checkpoints the folder before it starts, in a shadow Git repository under Salaam's state directory; the folder's own `.git` is never read or written, and `.gitignore`d files, `node_modules`, `.env*`, key files and Salaam's own state are not captured. Choose files, conversation or both, read the summary of what restoring does, and confirm once. Files are restored only if the folder is still exactly the tree you reviewed; otherwise nothing is written and you review again. A conversation rewind never cuts history: it forks a new session from before that turn, the old session stays as it was, and the turn's instruction comes back into the message box to edit. Commands and effects outside the folder are not undone. When files are written as a separate tools user, only the conversation can be rewound.

`/fork` requires an idle local session with no pending work or uncertain effects. The branch retains captured history; inherited provider usage is not charged to it again. Both conversations still point at the same files, so this is not a Git worktree or filesystem snapshot.

`/skills` reports the current disabled implicit skill-discovery policy; it does not install or enable skills. `/mcp` shows only admitted capabilities. Neither command silently expands authority. `/export` refuses existing destinations and includes tool records; review its contents before sharing.

Model and reasoning selection keep existing sessions and running work intact. Each local session retains its provider/model across daemon restarts. Configure authentication using `sal auth login PROVIDER` or `sal auth set PROVIDER`; choosing a catalog model does not establish account access. The header shows the selected session's model. Compaction preserves the saved transcript for history retrieval; its checkpoint is not a model-generated conversation summary.

Older sessions retain their original capabilities. Create a new local session to gain workspace inspection. If the daemon predates this feature, finish active work, run `sal service stop`, and reopen `sal` to load the updated executable.

The interface has two native palettes, **Night** and **Paper**, with jade accents, quiet surfaces, readable tool outcomes and no icon-font requirement. Choose `--theme night|paper` or switch from the action menu. `NO_COLOR=1` preserves the layout without color. Narrow terminals hide the workspace rail automatically; Ctrl+B toggles it on wide terminals. The terminal title and application chrome identify Salaam.

| Key                                    | Action                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Enter                                  | Save the exact composer text to the durable outbox, then deliver it               |
| Alt+Enter / Ctrl+J                     | Insert a newline; Shift+Enter also works with supported keyboard protocols        |
| Ctrl+K                                 | Search actions by visible name, description or ID                                 |
| Ctrl+P / Ctrl+N                        | Pick an existing session / create a new session                                   |
| Ctrl+O                                 | Review operation-bound approvals                                                  |
| Ctrl+G / Ctrl+T                        | Open checked changes / command results                                            |
| Tab                                    | Complete slash input, otherwise cycle Conversation, Changes, Commands and Context |
| PageUp / PageDown                      | Scroll the body; mouse wheel is also supported                                    |
| Ctrl+R                                 | Refresh service state and the current diff                                        |
| Ctrl+E                                 | Edit the prompt with `VISUAL`, then `EDITOR`, then `vi`                           |
| F1, or `?` with an empty composer      | Keys for where you are (conversation, running turn, change review)                |
| Ctrl+C / Ctrl+D with an empty composer | Detach and leave work running                                                     |

The key sheet (`?`, F1 or `/keys`) is built from the same table the TUI binds (`src/tui-keymap.ts`), so it lists the keys that actually work. It changes with where you are: a running desk turn shows Esc, Enter and Tab; the Changes review shows its file, hunk, accept, revert and instruct keys. Approvals show their own keys along the bottom.

### Continue, resume and terminal status

`salaam -c` (or `salaam --continue`) is short for `salaam code --continue`: it reopens this folder's latest session, or starts one and says _No earlier session in this folder, so this is a new one._ The session picker (Ctrl+P, `salaam code --resume`) lists this folder's sessions first, newest first, each with what you last asked and how long ago.

The window title says the state: `Salaam · NAME · working`, `· needs you` while an approval waits, or `· idle`. Inside [Herdr](https://herdr.dev) the pane also reports `working`, `blocked` or `idle` and a resume command (`salaam --session ID`) through Herdr's documented `"$HERDR_BIN_PATH" pane report-agent` command, and releases the pane on exit; outside Herdr nothing is sent. Neither carries prompt or command text. `SALAAM_TERMINAL_STATUS=off` turns both off. The previous window title is restored on exit.

The editor accepts multiline Unicode paste, keeps per-session drafts in memory, and offers accepted-input history. Unsubmitted drafts are not persisted after process loss. Quoted editor executable paths and arguments are supported; shell expansion is absent. The external editor gets normal terminal modes, a private temporary prompt file and a 64 KiB result limit. Terminal modes, alternate screen, bracketed paste and title are restored on normal detach and handled signals. A forced process kill cannot run terminal cleanup; open a new attachment to recover.

## Service truth in each view

Existing pre-coding daemons remain usable: missing coding/executor fields and routes mean those capabilities are off. Enabling the new coding tools requires a current service explicitly configured with its coding root and executor.

Conversation shows committed messages, queued instructions, bounded live previews, recent tool activity, pending approvals and explicit interruptions. A preview is replaced by committed transcript state and discarded after connection loss; it is not a completion receipt. The recent transcript has a 100-message snapshot limit. **Browse full history** opens bounded saved entry pages, including before compaction; **Read artifact** opens saved evidence without acknowledging a child result. **Inspect tool activity** shows recorded inputs and outcomes under their original attempt/tool IDs. Input previews are bounded and indicate truncation.

In a local coding session, Changes is a per-file review of what changed in the folder since the review base (the first turn's checkpoint, moved forward as you accept). Alt+Left/Right moves between files and Alt+Up/Down between hunks (none selected means the whole file). With the message box empty, `a` accepts the selection (marks it reviewed; the file is not touched), `r` reverts it to the base after one confirm, and `i` starts a follow-up instruction about it. A revert is refused if the folder changed after you looked.

In a coding workspace, Changes displays a service-checked diff against the imported baseline and its workspace identity/revision. Alt+Left/Right pages files. Original source checkouts remain outside the writable coding copy. External edits or a locked workspace can prevent a checked diff; inspect the reported conflict and use the explicit `sal workspace refresh` workflow after reviewing its observed digest. A displayed old revision cannot authorize an edit to a newer revision.

Commands displays stable run IDs, captured workspace revisions, actual terminal states and exit codes. **Command logs** reads the captured output by byte offset. **Cancel a command** and **Cancel current work** are separate confirmed actions; neither is implied by detach. Unknown outcomes stay unknown and use the scriptable reconciliation workflow. Context shows the session/worker/workspace, explicit task facts, child/result identities, executor details and recorded/estimated/unknown usage.

Approval review shows the exact target, value, expected target version, digest, revision, worker epoch, expiry and approval ID. Scroll through the whole binding before approval is enabled. **Deny is the default**. Closing the card records no decision. Current binding/expiry checks and the server’s durable decision admission reject stale requests. An observer may decide a bound approval without taking the controller lease. Concurrent requests are selected by target or ID.

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

Commands run as your local OS user, **without an OS sandbox**. The approval shows the exact command, working directory and timeout. They can access the user's files and network, even outside the project. Salaam supplies a minimal environment rather than inheriting daemon API keys. Commands have a two-minute maximum runtime and 64 KiB captured-output limit. Foreground process groups are cancelled with the attempt; deliberately daemonized programs are outside this process-group guarantee. Use foreground commands rather than starting background services.

Results appear in the conversation, the Changes/Commands tabs and durable operation receipts. The Commands tab shows recorded commands and outcomes; Changes reviews the folder itself against its checkpoints. A nonzero exit, timeout or cancellation is not reported as success. A controller restart during execution leaves an uncertain operation for inspection and explicit operator resolution; it never automatically repeats the command. Detaching from the TUI does not cancel work. The isolated executor profile retains its separate snapshot-based views.

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
