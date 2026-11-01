# Hooks

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

## Where hooks live

Yours are in `~/.config/salaam/hooks.json` (or `$SALAAM_HOOKS_FILE`) and always run. A
repository's `.salaam/hooks.json` does **not** run until you review it with `/hooks trust`, which
shows every command and records the file's SHA-256. Any change to the file needs trusting again.
`/hooks revoke` stops it; `/hooks` lists both files and their state.

## Events and matchers

`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `Notification` (an
approval is waiting). A matcher selects tools: empty or `*` is all, `Bash|Edit` are exact names,
anything else is a regular expression. Salaam's tools match by their own names
(`salaam_local`, `salaam_web_search`…) and by Claude Code's (`Bash` for a command, `Edit`/`Write`
for an edit, `Read`, `WebSearch`, `WebFetch`).

## Input and output

The hook gets JSON on stdin with `session_id`, `cwd`, `hook_event_name` and
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

## How they run

Each hook runs like one of the session's sandboxed commands: the same sandbox
and level, no network, a minimal environment (`SALAAM_PROJECT_DIR` and `CLAUDE_PROJECT_DIR` are
set), at the workspace root. A script must be readable inside that sandbox, so keep it in the
workspace or an operator-allowed read path; `~/.config/salaam` is not readable from the sandbox.
On a host whose commands run as a separate tools user, hooks do not run. Timeouts default to
60 seconds (at most 600), output is kept up to 16 KiB per stream, and every run is recorded as a
`hook.run` event with its exit code, duration and output digests.

Hooks run only in your own desk coding sessions; board, station and child sessions run none.
