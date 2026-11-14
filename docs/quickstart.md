# Try it offline

We are going to give Salaam a short, harmless errand before we hand it a project
or a provider account. The session uses throwaway state, calls no model and costs
nothing. Our running joke is appropriately small: the agent's first job is to
prove it can say hello without calling anyone.

## 1. Start an offline service

[Install Salaam](install.md), then start a service in throwaway state:

```sh
sal service start --state /tmp/salaam-try
sal service status --state /tmp/salaam-try
```

The status command now shows a running offline service at the same state path. We
have a durable host for the session, and no provider has heard from us.

## 2. Create and attach to a session

Create a session in the current folder:

```sh
sal session create --cwd "$PWD" --state /tmp/salaam-try
sal attach SESSION_ID --state /tmp/salaam-try
```

Replace `SESSION_ID` with the returned ID. You are now attached to the same durable
session the service owns; closing this terminal will not erase it.

## 3. Send the first instruction

Enter a short instruction and press Enter.

The offline provider replies `Offline reply: …` after a managed probe call. This
exercises the real pinned Pi worker without paid requests.

There is our hello: the worker completed a real managed turn, while the provider
bill stayed exactly where we left it—at zero.

Ctrl+K opens actions, Ctrl+O reviews approvals, and Ctrl+G opens changes when coding
is configured. Ctrl+D with an empty composer detaches. Run the same `attach` command
again to read committed history and follow the same session. Use `--observe` from
another terminal or explicit `--takeover` to replace its controller.

## 4. Inspect the result and stop

Run a scriptable probe, inspect the session, and stop the throwaway service:

```sh
sal session probe SESSION_ID --state /tmp/salaam-try
sal session inspect SESSION_ID --state /tmp/salaam-try
sal service stop --state /tmp/salaam-try
```

You have now exercised startup, durable session creation, attachment, a managed
offline turn, inspection and shutdown. The tiny hello did its whole shift and can
clock out.

Without `--state`, clients use `SALAAM_STATE_DIR` or `~/.local/state/salaam`. Keep
the same path for one service. Short paths avoid macOS Unix-socket limits.
The daemon detaches by default; `--foreground` keeps it under an external supervisor.

When you are ready for real work, [connect a provider](providers.md) and run
`salaam code` in your project.

The same durable path now carries useful work; only the throwaway state and our
very undemanding first assignment disappear.
