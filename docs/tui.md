# Terminal

The terminal app is where you talk to the agent, review its changes and answer its
approvals. It connects to the Salaam service, so closing it never stops work.

## Launch

```sh
salaam code          # this folder's latest session, or a new one
salaam -c            # the same
salaam code --new    # a new session in this folder
salaam code --resume # pick any session, this folder's first
salaam               # the session picker
salaam attach SESSION_ID --observe   # watch without taking control
```

`--theme night|paper` picks the palette. A piped attachment, or `--plain`, uses a
line interface for scripts.

Sessions made with `/coding` or `salaam code` edit files and run commands in the folder
itself, each under [permissions](permissions.md) and the [sandbox](sandbox.md).
`/new` makes a read-only session that can list, read and search files but not edit or
run anything.

## Slash commands

Type `/` to see command completions. Tab or Enter accepts a completion; Enter then runs the command. Commands and aliases share one registry with the action palette and `/help`. Unknown commands and malformed arguments remain in the composer. `/queue`, `/steer`, `/plan`, `/review`, `/init` and the git helpers send instructions to the model; the others act locally.

<!-- generated:slash-commands -->

| Command                              | Also          | What it does                                                                                |
| ------------------------------------ | ------------- | ------------------------------------------------------------------------------------------- |
| `/help [command]`                    | `/commands`   | Show commands and their execution type                                                      |
| `/exit`                              | `/quit`, `/q` | Detach; preserve the session and running work                                               |
| `/keys`                              | `/hotkeys`    | Show keyboard shortcuts                                                                     |
| `/model [provider/model]`            | `/models`     | Switch this session’s provider and model                                                    |
| `/provider [provider]`               |               | Switch this session’s provider                                                              |
| `/thinking [level]`                  |               | Switch this session’s reasoning effort                                                      |
| `/coding [workspace]`                |               | New local coding session with reviewed edits and commands                                   |
| `/init`                              |               | Draft an AGENTS.md for this repository; the edit asks for approval                          |
| `/new [workspace]`                   |               | Create a session in a workspace                                                             |
| `/sessions [session-id]`             | `/resume`     | Switch or resume a session                                                                  |
| `/name <name>`                       | `/rename`     | Set a durable session label                                                                 |
| `/history`                           |               | Browse complete durable session history                                                     |
| `/compact`                           |               | Compact an idle session using its durable checkpoint                                        |
| `/cancel`                            | `/stop`       | Cancel an instruction with explicit confirmation                                            |
| `/queue [text]`                      |               | Save a durable next-turn instruction, or inspect the queue                                  |
| `/steer <text>`                      |               | Send recorded guidance to an active local turn; uncertain delivery never replays            |
| `/diff`                              |               | Review workspace changes file by file                                                       |
| `/commit`                            |               | Draft a commit of the current work; staging and the commit each ask (uses provider credits) |
| `/branch <name>`                     |               | Switch to a branch, creating it if needed                                                   |
| `/pr [base]`                         |               | Push this branch and open a pull request; both always ask, except in YOLO                   |
| `/tools`                             |               | Inspect available capabilities and recorded tool activity                                   |
| `/permissions`                       |               | Configure local permissions independently of task progression                               |
| `/mode`                              |               | Cycle review → accept edits → auto (shift+tab)                                              |
| `/full-access`                       |               | Turn full access on or off: commands run without the OS sandbox; dangerous ones still ask   |
| `/yolo`                              |               | Turn YOLO on (type yolo to confirm) or off: no sandbox and no approvals                     |
| `/approvals`                         |               | Review exact pending approval requests                                                      |
| `/context`                           |               | Inspect session context, facts and usage                                                    |
| `/usage`                             |               | Show recorded usage and unknown observations                                                |
| `/status`                            |               | Show connection, model and session capabilities                                             |
| `/copy`                              |               | Copy the last complete assistant response to the local clipboard                            |
| `/export [path]`                     |               | Export full durable conversation as Markdown; never overwrite                               |
| `/settings`                          |               | Choose terminal appearance and model settings                                               |
| `/fork`                              |               | Fork an idle local conversation; keep the same workspace                                    |
| `/rewind [turn]`                     |               | Rewind files, conversation or both to before an earlier turn                                |
| `/undo [reconcile]`                  |               | Review and revert the last completed local edit; retain conversation history                |
| `/plan [request]`                    |               | Ask the model for a plan (uses provider credits; not a permission mode)                     |
| `/review [focus]`                    |               | Ask the model to review workspace changes (uses provider credits)                           |
| `/skills [review <paths...>\|clear]` |               | Inspect or review digest-bound context and skills                                           |
| `/mcp`                               |               | Show admitted managed MCP capabilities                                                      |
| `/agents`                            |               | Inspect native/external worker profiles and child work                                      |
| `/progression`                       |               | Choose manual or bounded task progression; permissions stay separate                        |
| `/tasks`                             |               | Open durable task actions                                                                   |
| `/classifier [name\|on\|off]`        |               | Pick the small-model command reviewer for this session, or turn it off                      |
| `/hooks [trust\|revoke]`             |               | Show your hooks and this workspace’s; trust or revoke the workspace file                    |
| `/jobs [stop <id>]`                  | `/bg`         | Show background commands and their output, or stop one                                      |

<!-- /generated:slash-commands -->

Your own saved prompts appear here too; see [Commands](commands.md).

Shift+Tab (or `/mode`) cycles a coding session through review, accept edits and auto. `/full-access`, `/yolo` and `/classifier` are covered in [Permissions](permissions.md).

A command with shell features (pipes, redirects) can never become an approval rule, so its prompt offers only Approve once and Deny. If a terminal is killed while holding control, the next `salaam code` waits out its lease (at most 15 s). A terminal that is still alive keeps control; press Ctrl+K and choose Take control to take it.

## Rewind and undo

`/rewind` lists the session's turns, newest first. Each turn checkpoints the folder before it starts, in a shadow Git repository under Salaam's state directory; the folder's own `.git` is never read or written, and `.gitignore`d files, `node_modules`, `.env*`, key files and Salaam's own state are not captured. Choose files, conversation or both, read the summary of what restoring does, and confirm once. Files are restored only if the folder is still exactly the tree you reviewed; otherwise nothing is written and you review again. A conversation rewind never cuts history: it forks a new session from before that turn, the old session stays as it was, and the turn's instruction comes back into the message box to edit. Commands and effects outside the folder are not undone. When files are written as a separate tools user, only the conversation can be rewound.

`/undo` refuses concurrent file changes and cannot reverse shell commands or external effects. A crash or partial failure leaves a durable fence across local coding sessions sharing the root. Inspect the recorded inverse and restore the original files before `/undo reconcile`; reconciliation verifies every file rather than retrying the edit. Conversation history stays intact.

## Fork, skills and export

`/fork` requires an idle local session with no pending work or uncertain effects. The branch retains captured history; inherited provider usage is not charged to it again. Both conversations still point at the same files, so this is not a Git worktree or filesystem snapshot.

`/skills` reports the current disabled implicit skill-discovery policy; it does not install or enable skills. `/mcp` shows only admitted capabilities. Neither command silently expands authority. `/export` refuses existing destinations and includes tool records; review its contents before sharing.

## Models

Model and reasoning selection keep existing sessions and running work intact. Each local session retains its provider/model across daemon restarts. Configure authentication using `sal auth login PROVIDER` or `sal auth set PROVIDER`; choosing a catalog model does not establish account access. The header shows the selected session's model. Compaction preserves the saved transcript for history retrieval; its checkpoint is not a model-generated conversation summary.

Older sessions retain their original capabilities. Create a new local session to gain workspace inspection. If the daemon predates this feature, finish active work, run `sal service stop`, and reopen `sal` to load the updated executable.

## Themes and keys

The interface has two native palettes, **Night** and **Paper**, with jade accents, quiet surfaces, readable tool outcomes and no icon-font requirement. Choose `--theme night|paper` or switch from the action menu. `NO_COLOR=1` preserves the layout without color. Narrow terminals hide the workspace rail automatically; Ctrl+B toggles it on wide terminals (it is not readline back-char here). The terminal title and application chrome identify Salaam.

<!-- generated:keys -->

**In the conversation**

| Key                  | Action                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `Enter`              | send: The durable outbox saves it before delivery                                                       |
| `Alt+Enter / Ctrl+J` | new line                                                                                                |
| `Tab`                | switch view: Conversation · Changes · Commands · Context                                                |
| `PageUp / PageDown`  | scroll: Ctrl+Home/End jump to the top/bottom                                                            |
| `@`                  | attach a file or image                                                                                  |
| `/`                  | slash commands                                                                                          |
| `Ctrl+R`             | search sent messages: Ctrl+R for older, Enter keeps, Esc restores                                       |
| `Ctrl+A/E`           | Ctrl+U/K/W · Ctrl+Y · Ctrl+-: Line start/end, kill to start/end/word, yank, undo; Alt+B/F words         |
| `!command`           | run a shell command: Same approval, sandbox and danger check                                            |
| `Ctrl+C`             | stop, clear, then leave: Stops a running turn, else clears text; twice on empty leaves. Work continues. |
| `/rewind`            | go back to an earlier turn                                                                              |
| `/jobs`              | background commands                                                                                     |
| `/undo`              | revert the last edit                                                                                    |
| `Ctrl+K`             | all actions                                                                                             |
| `F2`                 | all actions                                                                                             |
| `Ctrl+P`             | sessions                                                                                                |
| `Ctrl+N`             | new session                                                                                             |
| `Ctrl+O`             | approvals                                                                                               |
| `Alt+G`              | changes                                                                                                 |
| `Ctrl+T`             | commands                                                                                                |
| `Ctrl+B`             | show or hide the side panel                                                                             |
| `Ctrl+X`             | full transcript on or off                                                                               |
| `F5`                 | refresh                                                                                                 |
| `Ctrl+G`             | external prompt editor                                                                                  |
| `Shift+Tab`          | next mode                                                                                               |
| `F1`                 | these keys                                                                                              |

**While a turn runs**

| Key         | Action                      |
| ----------- | --------------------------- |
| `Esc`       | stop the turn               |
| `Enter`     | steer it                    |
| `Tab`       | queue for after             |
| `Ctrl+K`    | all actions                 |
| `F2`        | all actions                 |
| `Ctrl+P`    | sessions                    |
| `Ctrl+N`    | new session                 |
| `Ctrl+O`    | approvals                   |
| `Alt+G`     | changes                     |
| `Ctrl+T`    | commands                    |
| `Ctrl+B`    | show or hide the side panel |
| `Ctrl+X`    | full transcript on or off   |
| `F5`        | refresh                     |
| `Ctrl+G`    | external prompt editor      |
| `Shift+Tab` | next mode                   |
| `F1`        | these keys                  |

**Reviewing changes**

| Key         | Action                      |
| ----------- | --------------------------- |
| `Alt+→`     | next file                   |
| `Alt+←`     | previous file               |
| `Alt+↓`     | next hunk                   |
| `Alt+↑`     | previous hunk               |
| `a`         | accept the file or hunk     |
| `r`         | revert it (asks first)      |
| `i`         | tell the model about it     |
| `Ctrl+K`    | all actions                 |
| `F2`        | all actions                 |
| `Ctrl+P`    | sessions                    |
| `Ctrl+N`    | new session                 |
| `Ctrl+O`    | approvals                   |
| `Alt+G`     | changes                     |
| `Ctrl+T`    | commands                    |
| `Ctrl+B`    | show or hide the side panel |
| `Ctrl+X`    | full transcript on or off   |
| `F5`        | refresh                     |
| `Ctrl+G`    | external prompt editor      |
| `Shift+Tab` | next mode                   |
| `F1`        | these keys                  |

<!-- /generated:keys -->

Approvals show their own keys along the bottom of the card. `Ctrl+D` with an empty message box detaches.

The tables above and the in-app key sheet (`?`, F1 or `/keys`) are both built from the table the terminal binds, so they list the keys that actually work. It changes with where you are: a running desk turn shows Esc, Enter and Tab; the Changes review shows its file, hunk, accept, revert and instruct keys. Approvals show their own keys along the bottom.

While a turn runs, the status line shows a live progress line: what the agent is doing (Thinking, Editing, Running a command), elapsed seconds, tokens and `esc to interrupt`. It repaints every second without input.

## The message box

The editor accepts multiline Unicode paste; a paste over 10 lines or 1000 characters collapses to a `[paste #N +L lines]` marker that backspace removes whole, Ctrl+G shows in full, and Enter sends expanded. It keeps per-session drafts in memory. Messages you send are kept for Up-arrow and Ctrl+R across sessions in `$XDG_STATE_HOME/salaam/history.json` (mode 600, newest 500); anything that looks like a credential (API keys, tokens, `password=`, private keys, long base64) is never written, and `SALAAM_HISTORY=off` keeps history in memory only.

`!command` in a local coding session asks the model to run exactly that command through `salaam_local`, so it takes the same approval prompt, session mode, OS sandbox and danger check as any command the model runs; the terminal never runs it itself. Outside local coding it is refused. Unsubmitted drafts are not persisted after process loss. Quoted editor executable paths and arguments are supported; shell expansion is absent. The external editor gets normal terminal modes, a private temporary prompt file and a 64 KiB result limit. Terminal modes, alternate screen, bracketed paste and title are restored on normal detach and handled signals. A forced process kill cannot run terminal cleanup; open a new attachment to recover.

## Continue, resume and terminal status

`salaam -c` (or `salaam --continue`) is short for `salaam code --continue`: it reopens this folder's latest session, or starts one and says _No earlier session in this folder, so this is a new one._ The session picker (Ctrl+P, `salaam code --resume`) lists this folder's sessions first, newest first, each with what you last asked and how long ago.

The window title says the state: `Salaam · NAME · working`, `· needs you` while an approval waits, or `· idle`. Inside [Herdr](https://herdr.dev) the pane also reports `working`, `blocked` or `idle` and a resume command (`salaam --session ID`) through Herdr's documented `"$HERDR_BIN_PATH" pane report-agent` command, and releases the pane on exit; outside Herdr nothing is sent. Neither carries prompt or command text. `SALAAM_TERMINAL_STATUS=off` turns both off. The previous window title is restored on exit.

## Views

Existing pre-coding daemons remain usable: missing coding/executor fields and routes mean those capabilities are off. Enabling the new coding tools requires a current service explicitly configured with its coding root and executor.

Conversation shows committed messages, queued instructions, bounded live previews, one compact line per recent tool call (`Edit src/x.ts +3 −1`, `Bash npm test ✓ exit 0` with the last three output lines; Ctrl+X shows all of them with their output), pending approvals and explicit interruptions. A preview is replaced by committed transcript state and discarded after connection loss; it is not a completion receipt. The recent transcript has a 100-message snapshot limit. **Browse full history** opens bounded saved entry pages, including before compaction; **Read artifact** opens saved evidence without acknowledging a child result. **Inspect tool activity** shows recorded inputs and outcomes under their original attempt/tool IDs. Input previews are bounded and indicate truncation.

In a local coding session, Changes is a per-file review of what changed in the folder since the review base (the first turn's checkpoint, moved forward as you accept). Alt+Left/Right moves between files and Alt+Up/Down between hunks (none selected means the whole file). With the message box empty, `a` accepts the selection (marks it reviewed; the file is not touched), `r` reverts it to the base after one confirm, and `i` starts a follow-up instruction about it. A revert is refused if the folder changed after you looked.

In a coding workspace, Changes displays a service-checked diff against the imported baseline and its workspace identity/revision. Alt+Left/Right pages files. Original source checkouts remain outside the writable coding copy. External edits or a locked workspace can prevent a checked diff; inspect the reported conflict and use the explicit `sal workspace refresh` workflow after reviewing its observed digest. A displayed old revision cannot authorize an edit to a newer revision.

Commands displays stable run IDs, captured workspace revisions, actual terminal states and exit codes. **Command logs** reads the captured output by byte offset. **Cancel a command** and **Cancel current work** are separate confirmed actions; neither is implied by detach. Unknown outcomes stay unknown and use the scriptable reconciliation workflow. Context shows the session/worker/workspace, explicit task facts, child/result identities, executor details and recorded/estimated/unknown usage.

Approval review shows the exact target and value in plain words, with a one-line reason it asks: the danger check's category and reason for a dangerous command, otherwise what the session mode leaves to a person. An edit shows its diff, added lines in jade and removed lines in red. `d` shows the binding: digest, revision, worker epoch, expiry and approval ID. Focus opens on **Approve once**, so Enter approves the request you see. `y` approves once, `n` denies, and in a desk session `s` approves for the session, `a` always in this repo, and `f` denies and opens a one-line reason that reaches the agent as feedback. If the turn has ended, that reason is put in the composer instead. In desk sessions there is no read-to-the-end gate; a long change says how many lines are below. Strict (host, board and child) work still has to be scrolled to the end before approval is enabled. Closing the card records no decision. Current binding/expiry checks and the server's durable decision admission reject stale requests. An observer may decide a bound approval without taking the controller lease. Concurrent requests are selected by target or ID.

The controller lease coordinates operators of the same trusted OS account. An observer cannot send instructions. Taking control is explicit and preserves running attempts and commands. A new controller retries journaled pending submissions with their original logical IDs. An interrupted attempt after service death is never silently replayed; **Continue interrupted work** requires a new instruction. **Stop service** is a separate confirmation affecting all of that service’s sessions.

## Over SSH

`salaam remote HOST` opens the same terminal on a session that lives on another machine. See [ACP and SSH reference](clients.md#terminal-and-ssh).

## Permissions and progression

`/permissions` and `/progression` (also in `/settings`) set what may run without
asking and how tasks advance. They are separate: progression never approves anything.
See [Permissions](permissions.md) and [Durable tasks](durable-tasks.md).

## Durable task actions

Ctrl+K → **Task actions** creates or revises a JSON plan, starts/continues/reviews a step, runs configured checks, records completion or an explicit exception, grants bounded progression, pauses/cancels, and captures/compares/restores checkpoints. Context shows the objective, step IDs/states, dependencies, request/token reservations, elapsed runtime, remaining step grant and fresh verification status. The service enforces every action over the same controller/revision rules as the CLI. Lost replies remain in the durable outbox; stale actions remain rejected for review. Detach keeps admitted work running, pause prevents future steps, and cancel revokes active owned work. See [task controls](durable-tasks.md) for exact semantics and limits.

## One-shot job actions

Ctrl+K → **Job actions** binds the current unstarted checked task to a one-shot definition, reviews its complete binding, submits a stable occurrence key, or cancels owned work. Context shows the shared job/occurrence IDs and state. Ctrl+Home/End jumps to the start/end of long pages. Hard terminal loss preserves admitted work; an observer can inspect the same occurrence after reconnect. A repeated trigger cannot restart an interrupted attempt. See [jobs](jobs.md) for authority, outbox and recovery semantics.

Ctrl+K also exposes **Recurring jobs and schedules** and the global **Operator inbox**. Recurring templates capture a checked plan/workspace; each admitted occurrence has fresh work identities. Schedule revisions cannot change the template, and duplicate keys never dispatch another run. Inbox acknowledgement clears only the reviewed attention revision and never decides a permission. ACP shares the same records through Salaam extension methods/metadata.

## Local coding sessions

Use `/coding` (or **New local coding session** in the action palette) to create a session with reviewed edits and native shell commands. Existing read-only sessions retain their permissions. The CLI equivalent is `sal session create --local-coding --cwd /absolute/project/path`.

The model reads a file and supplies its content hash with an edit. Review shows the old and replacement contents for each file; approving binds that exact proposal. Salaam rechecks file contents immediately before each replacement and refuses stale proposals. This is optimistic local editing, not a filesystem transaction against other processes writing at the same instant. Up to eight files can be reviewed together, within a 32 KiB review limit. Individual file replacement is atomic; a failure between files is recorded as uncertain, with applied paths retained. There is no automatic rollback over subsequent human changes.

Commands run as you inside the OS sandbox; [Sandbox](sandbox.md) covers what they can reach, servers, and running one command outside it. Foreground commands may run for two minutes and keep 64 KiB of output; servers and watchers go in the background (`/jobs`).

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
