# Salaam in your terminal

Run `npm run build` after updating this checkout. Bare `sal` opens the Salaam session picker in an interactive terminal; `sal tui --session UUID` and `sal attach UUID` reconnect directly. Scriptable CLI commands remain available. `sal attach UUID --plain` selects the line interface explicitly, and piped attachments use it automatically.

```sh
sal
sal tui --session SESSION_ID --theme paper
sal attach SESSION_ID --observe
sal attach SESSION_ID --takeover
```

The interface has two native palettes, **Night** and **Paper**, with jade accents, quiet surfaces, readable tool outcomes and no icon-font requirement. Choose `--theme night|paper` or switch from the action menu. `NO_COLOR=1` preserves the layout without color. Narrow terminals hide the workspace rail automatically; Ctrl+B toggles it on wide terminals. The terminal title and application chrome identify Salaam.

| Key                                    | Action                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Enter                                  | Save the exact composer text to the durable outbox, then deliver it        |
| Alt+Enter / Ctrl+J                     | Insert a newline; Shift+Enter also works with supported keyboard protocols |
| Ctrl+K                                 | Search actions by visible name, description or ID                          |
| Ctrl+P / Ctrl+N                        | Pick an existing session / create a new session                            |
| Ctrl+O                                 | Review operation-bound approvals                                           |
| Ctrl+G / Ctrl+T                        | Open checked changes / command results                                     |
| Tab                                    | Cycle Conversation, Changes, Commands and Context                          |
| PageUp / PageDown                      | Scroll the body; mouse wheel is also supported                             |
| Ctrl+R                                 | Refresh service state and the current diff                                 |
| Ctrl+E                                 | Edit the prompt with `VISUAL`, then `EDITOR`, then `vi`                    |
| F1                                     | Keyboard help                                                              |
| Ctrl+C / Ctrl+D with an empty composer | Detach and leave work running                                              |

The editor accepts multiline Unicode paste, keeps per-session drafts in memory, and offers accepted-input history. Unsubmitted drafts are not persisted after process loss. Quoted editor executable paths and arguments are supported; shell expansion is absent. The external editor gets normal terminal modes, a private temporary prompt file and a 64 KiB result limit. Terminal modes, alternate screen, bracketed paste and title are restored on normal detach and handled signals. A SIGKILL cannot run cleanup; the PTY proof checks recovery in a new attachment independently.

## Service truth in each view

Existing pre-coding daemons remain usable: missing coding/executor fields and routes mean those capabilities are off. Enabling the new coding tools requires a current service explicitly configured with its coding root and executor.

Conversation shows committed messages, queued instructions, bounded live previews, recent tool activity, pending approvals and explicit interruptions. A preview is replaced by committed transcript state and discarded after connection loss; it is not a completion receipt. The recent transcript has a 100-message snapshot limit. **Browse full history** opens bounded saved entry pages, including before compaction; **Read artifact** opens saved evidence without acknowledging a child result. **Inspect tool activity** shows recorded inputs and outcomes under their original attempt/tool IDs. Input previews are bounded and indicate truncation.

Changes displays a service-checked diff against the imported baseline and its workspace identity/revision. Alt+Left/Right pages files. Original source checkouts remain outside the writable coding copy. External edits or a locked workspace can prevent a checked diff; inspect the reported conflict and use the explicit `sal workspace refresh` workflow after reviewing its observed digest. A displayed old revision cannot authorize an edit to a newer revision.

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

The explicit rehearsal runner requires an already provisioned, operator-approved disposable host directory and uses offline fixtures:

```sh
npx --no-install tsc -p tsconfig.json
node scripts/remote-rehearsal.mjs --host APPROVED_ALIAS \
  --root /home/USER/.cache/salaam-m10.ID --report .state/evidence/m10/remote.json
```

It creates only its named fixture source, private service state and wrapper under that root, exercises real SSH PTYs plus ACP protocol coding, records identities/outcomes and stops its test service. It does not install system runtimes, copy keys or make live provider calls. This is an opt-in acceptance tool, not the M12 job/bootstrap service.

## Implementation and acceptance scope

The UI reuses the exact `@earendil-works/pi-tui@1.3.0` rendering/editor primitives, while Salaam owns its layout, themes, menus, authority and lifecycle. It does not launch Pi’s interactive app. The test harness controls real PTYs and parses their output with pinned `@xterm/headless@5.5.0`; retained screenshots render actual terminal cells rather than product mockups.

Design references were the [Crush terminal interface](https://github.com/charmbracelet/crush), [OpenCode TUI](https://github.com/anomalyco/opencode), [Pi terminal primitives](https://github.com/earendil-works/pi/tree/main/packages/tui) and [Zed external-agent integration](https://zed.dev/docs/ai/external-agents). Their service/client separation and keyboard-oriented controls informed Salaam’s own visual design.

`npm run test:acceptance` runs the complete source test suite, repeats the new operator recovery/coding proofs three times and retains the existing 20-repetition S1–S6 gate. CI stores actual terminal-cell SVG/text captures alongside its platform manifests. Source-only test discovery prevents compiled rehearsal helpers from causing duplicate test runs.

Local PTY and ACP protocol proofs are independent of the named Zed GUI rehearsal. The Zed 1.24.2 GUI check passed on an unlocked macOS desktop on 2026-10-18; its [evidence record](evidence/m10-zed-gui.json) covers actual tools, bound approvals, owned-file/diff inspection and same-session reload. The adapter fix found during that rehearsal passes all 186 local tests and the subsequent full platform acceptance CI run. M11 task controls and M12 job/schedule/inbox controls are implemented. The M12 SSH pilot is independent of the earlier Zed GUI rehearsal.

## Durable task actions

Ctrl+K → **Task actions** creates or revises a JSON plan, starts/continues/reviews a step, runs configured checks, records completion or an explicit exception, grants bounded progression, pauses/cancels, and captures/compares/restores checkpoints. Context shows the objective, step IDs/states, dependencies, request/token reservations, elapsed runtime, remaining step grant and fresh verification status. The service enforces every action over the same controller/revision rules as the CLI. Lost replies remain in the durable outbox; stale actions remain rejected for review. Detach keeps admitted work running, pause prevents future steps, and cancel revokes active owned work. See [task controls](durable-tasks.md) for exact semantics and limits.

## One-shot job actions

Ctrl+K → **Job actions** binds the current unstarted checked task to a one-shot definition, reviews its complete binding, submits a stable occurrence key, or cancels owned work. Context shows the shared job/occurrence IDs and state. Ctrl+Home/End jumps to the start/end of long pages. Hard terminal loss preserves admitted work; an observer can inspect the same occurrence after reconnect. A repeated trigger cannot restart an interrupted attempt. See [jobs](jobs.md) for authority, outbox and recovery semantics.

Ctrl+K also exposes **Recurring jobs and schedules** and the global **Operator inbox**. Recurring templates capture a checked plan/workspace; each admitted occurrence has fresh work identities. Schedule revisions cannot change the template, and duplicate keys never dispatch another run. Inbox acknowledgement clears only the reviewed attention revision and never decides a permission. ACP shares the same records through Salaam extension methods/metadata; a new Zed GUI inbox rendering check is outside this protocol proof.
