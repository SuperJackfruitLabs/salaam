# Your first session

[Install Salaam](install.md), then start an offline service in disposable state:

```sh
sal service start --state /tmp/salaam-try
sal service status --state /tmp/salaam-try
sal session create --cwd "$PWD" --state /tmp/salaam-try
sal attach SESSION_ID --state /tmp/salaam-try
```

Replace `SESSION_ID` with the returned ID. When ready, enter a short instruction.
The offline provider replies `Offline reply: …` after a managed probe call. This
exercises the real pinned Pi worker without paid requests.

Ctrl+K opens actions, Ctrl+O reviews approvals, and Ctrl+G opens changes when coding
is configured. Ctrl+D with an empty composer detaches. Run the same `attach` command
again to read committed history and follow the same session. Use `--observe` from
another terminal or explicit `--takeover` to replace its controller.

For a scriptable check:

```sh
sal session probe SESSION_ID --state /tmp/salaam-try
sal session inspect SESSION_ID --state /tmp/salaam-try
sal service stop --state /tmp/salaam-try
```

Without `--state`, clients use `SALAAM_STATE_DIR` or `~/.local/state/salaam`. Keep
the same path for one service. Short paths avoid macOS Unix-socket limits.
The daemon detaches by default; `--foreground` keeps it under an external supervisor.

The offline CLI example above uses the managed probe profile. For actual local file inspection, configure
[Claude](providers.md), open `sal` and create a session (or use `sal session create --local`). Local inspection needs no Docker and cannot edit or run commands. To write code, enable [coding](coding.md), or read [terminal controls](tui.md).
Creation and readiness make no model request.
