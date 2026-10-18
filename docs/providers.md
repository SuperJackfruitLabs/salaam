# Claude and credentials

The default provider is offline. Configure the first live provider through the
hidden terminal prompt:

```sh
sal auth set anthropic
sal service start --provider anthropic --state "$HOME/.local/state/salaam-claude"
sal session create --cwd "$PWD" --state "$HOME/.local/state/salaam-claude"
sal attach SESSION_ID --state "$HOME/.local/state/salaam-claude"
```

The key is saved at `~/.config/salaam/credentials/anthropic` with mode 600 in a
mode-700 directory. It is plaintext protected by OS permissions. The hidden prompt
keeps it out of shell history and arguments. `ANTHROPIC_API_KEY` takes precedence;
unset it to use the file. Salaam does not load `.env` files.

Prompts are billable. Readiness does not validate account billing or authentication.
The pinned route defaults to `claude-sonnet-5-5`, low reasoning and 4,096 output
tokens; it also accepts `--model claude-sonnet-4-6`. `--max-output-tokens` accepts
128–8,192. `--workspace-id` adds the provider workspace header. Metadata comes from
the pinned Pi catalog and does not establish every account's model access.

Routes are durably bound per session. Offline sessions stay offline; create a
fresh session for Claude. Restart with the same route to resume it. Provider and
Pi retries are disabled. Unknown usage stays unknown; request limits are not
currency caps.

Only live workers receive the key. It is excluded from configuration JSON, process
arguments, journal events and operator responses. The endpoint is fixed to
`https://api.anthropic.com`; custom proxies, subscription OAuth, fallback routes
and server tools are unsupported. Rotate the saved key and restart at a safe work
boundary. Credential values and digests are not persisted in the journal.

Coding requires [separate setup](coding.md). See the
[service reference](service-reference.md) for admission and failure handling.
