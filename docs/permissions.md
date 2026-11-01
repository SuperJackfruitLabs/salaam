# Permissions

Salaam asks before it edits a file or runs a command. The session's **mode** decides
what may run without asking, and **approval rules** remember your answers.

## Modes

Press **Shift+Tab** (or type `/mode`) to cycle a coding session through three modes.
The status line shows the current one.

| Mode         | Edits                         | Commands                                                   |
| ------------ | ----------------------------- | ---------------------------------------------------------- |
| Review       | Ask                           | Ask                                                        |
| Accept edits | Inside the project, no asking | Ask                                                        |
| Auto         | Inside the project, no asking | No asking while they stay inside the [sandbox](sandbox.md) |

Some things always ask, even in auto: pushing, opening a pull request, a command that
wants to listen for connections, and a command that asks to run outside the sandbox.

New sessions start in review. In an editor, the same modes are in the mode picker
(see [Editors](editors.md)).

## Full access

`/full-access` runs commands without the sandbox and without asking. A **danger
check** still stops commands that could do real harm and asks, saying why. It reads
plain commands joined by `&&`, `||`, `;` and `|`, looks inside `sudo`, `env`,
`timeout`, `xargs`, `find -exec` and `sh -c`, and treats anything it cannot read as
dangerous: substitutions, heredocs, piping into a shell, and writes outside the
project.

`/full-access` again turns it off. A host can forbid it
(`allow_full_access_sessions`).

## YOLO

`/yolo`, then typing `yolo` to confirm, approves every edit and command with no
sandbox. The status line shows a red `YOLO`, and every approval it makes is recorded
with what full access would have asked. It is only for your own sessions, never for
host-managed, board or delegated work, and a host must allow it
(`allow_yolo_sessions: true`). `/yolo` again turns it off.

## Answering an approval

The approval card shows the exact diff or command and why it asks. Focus starts on
**Approve once**, so Enter approves what you see.

| Key | Answer                                                 |
| --- | ------------------------------------------------------ |
| `y` | Approve once                                           |
| `s` | Approve this exact request for the rest of the session |
| `a` | Always approve it in this repository                   |
| `n` | Deny                                                   |
| `f` | Deny with a one-line reason the agent reads            |
| `d` | Show the binding: digest, revision and expiry          |

A command with shell features (pipes, redirects) can only be approved once. Ctrl+O
opens every pending approval.

## Approval rules

`s` and `a` save rules. You can also write your own in
`~/.config/salaam/permissions.json` (or `$SALAAM_PERMISSIONS_FILE`):

```json
{
  "version": 1,
  "rules": [
    { "effect": "allow", "tool": "command", "command": "npm test *" },
    { "effect": "allow", "tool": "edit", "paths": ["src/**", "test/**"] },
    { "effect": "deny", "tool": "command", "command": "git push *" },
    { "effect": "ask", "tool": "edit", "paths": ["package.json"] }
  ]
}
```

- `effect` is `allow`, `ask` or `deny`. When several rules match, deny wins over ask,
  and ask over allow.
- `tool` is `command`, `edit` or `any`.
- A `command` pattern is plain words. A word may contain `*`, and a final `*` matches
  any further words.
- `paths` are project-relative globs: `**` spans folders, `*` stays within one. An
  allow rule must match every file in an edit.

A repository's rules (made with `a`) cannot approve a dangerous command, a push or a
command outside the sandbox. Your own rules and session rules can.

## Command reviewer

In auto and full access, the danger check cannot see inside some commands: inline code
like `node -e`, a repository script, `npm run`, `npx`, or a program it does not know.
A service started with `--danger-classifier-config FILE` can send those to a small
model for a second opinion. `/classifier` picks the reviewer or turns it off.

The file is JSON, for example
`{"provider":"anthropic","model":"claude-haiku-5-5","key_env":"ANTHROPIC_API_KEY"}`
or `{"provider":"openai-compatible","url":"http://127.0.0.1:11434/v1","model":"…"}`,
with optional `name`, `on_unavailable` (`rules` or `ask`) and `timeout_ms`. List
several as `{"options":[…],"default":"NAME"}`. The key is read from the named
variable, never stored in the file.

Only the command and its working directory are sent, with secret-looking values
removed. The reviewer can only make a command ask; it never lets one run that would
otherwise ask. Without a config file, nothing is ever sent.

## Edits

The agent reads a file and sends its hash with the edit. Approving binds that exact
change, and Salaam checks the file again just before writing it, so an edit to a file
that changed in the meantime is refused. Up to eight files can be reviewed together.
