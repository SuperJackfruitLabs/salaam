# Providers and credentials

Salaam uses the provider registry shipped with its pinned Pi runtime. The default
is offline. List provider IDs, authentication methods, and chat models without
making a network request:

```sh
sal providers list
sal models list openai
sal models list google
```

The registry contains 42 providers. All 41 providers with chat models can run
interactive sessions. Typesafe is classifier-only and has no chat route. Image
and classifier operations are outside the session chat interface. A catalog entry
does not establish availability, pricing, or access for your account.

| Family                    | Provider IDs                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic                 | `anthropic`                                                                                                                                                                                                                                                                         |
| OpenAI and Azure          | `openai`, `openai-codex`, `azure`                                                                                                                                                                                                                                                   |
| Google and AWS            | `google`, `google-vertex`, `amazon-bedrock`                                                                                                                                                                                                                                         |
| Gateways                  | `openrouter`, `vercel-ai-gateway`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `github-copilot`, `radius`                                                                                                                                                                     |
| Hosted inference          | `ant-ling`, `baseten`, `cerebras`, `deepseek`, `fireworks`, `groq`, `huggingface`, `meta`, `mistral`, `nvidia`, `together`, `xai`                                                                                                                                                   |
| Regional and coding plans | `kimi-coding`, `minimax`, `minimax-cn`, `moonshotai`, `moonshotai-cn`, `opencode`, `opencode-go`, `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, `zai-coding-cn` |
| Classifier only           | `typesafe`                                                                                                                                                                                                                                                                          |

## API keys

Use the hidden prompt to keep a key out of shell history and process arguments:

```sh
sal auth set openai
sal service start --provider openai --model MODEL_ID --state "$HOME/.local/state/salaam-openai"
sal session create --cwd "$PWD" --state "$HOME/.local/state/salaam-openai"
sal attach SESSION_ID --state "$HOME/.local/state/salaam-openai"
```

Choose `MODEL_ID` from `sal models list openai`. Replace `SESSION_ID` with the ID
returned by creation. Provider prompts may be billable. Readiness makes no model
request and does not validate your account's billing or model access.

For Anthropic, `sal auth set anthropic` remains compatible. Its default model is
`claude-sonnet-5-5`; other providers require an explicit `--model`. All chat models
in the pinned catalog are selectable. `--max-output-tokens N` accepts 128–8,192,
subject to the model's smaller limit. The default is 4,096 or the model's smaller
maximum. Requests use low reasoning when at least 2,048 output tokens fit; smaller
limits disable optional reasoning so a thinking budget cannot exceed the ceiling. `--workspace-id` is specific to Anthropic.

Credentials are plaintext files protected by OS permissions under
`~/.config/salaam/credentials`, with directory mode 700 and file mode 600. New
credentials use `PROVIDER.json`; existing `credentials/anthropic` files still
work. `ANTHROPIC_API_KEY` takes precedence over stored Anthropic credentials.
Other API-key providers follow Pi's stored-key-first resolution and provider
specific environment variables, such as `OPENAI_API_KEY`, `GEMINI_API_KEY`, and
`OPENROUTER_API_KEY`. Salaam does not load `.env` files or Pi's credential store.

## OAuth and cloud setup

Provider-owned setup prompts collect additional configuration and support browser
or device-code authentication when Pi supplies it:

```sh
sal auth login cloudflare-ai-gateway
sal auth login amazon-bedrock
sal auth login google-vertex
sal auth login openai --oauth
sal auth login github-copilot --oauth
sal auth status
sal auth logout openai
```

OAuth is available for Anthropic, OpenAI, legacy OpenAI Codex, GitHub Copilot,
Kimi Coding, Meta, OpenRouter, Radius, and xAI. `sal providers list` reports the
methods actually present in the pinned runtime. OAuth refresh uses private,
process-shared locks so concurrent workers and CLI commands cannot reuse a
rotating refresh token. A failed refresh preserves the prior credential.

Azure needs `AZURE_OPENAI_RESOURCE_NAME` or `AZURE_OPENAI_BASE_URL`, in addition
to its key. `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` can map catalog model IDs to your
deployment names. Cloudflare setup stores account and gateway identifiers. Bedrock
supports a bearer token, configured AWS profile, or Pi's detected AWS credential
chain; set `AWS_PROFILE=default` to select an existing default profile. Vertex
setup supports a Cloud API key, ADC, or a service-account file with project and
location. Cloud credential files stay on the execution host.

**ChatGPT subscription routes have no provider-enforced output-token cap.**
Salaam permits them for interactive sessions and displays the limitation in service
health, startup output, and the TUI. Omit `--max-output-tokens` on these routes; supplying it reports an error.
Durable tasks, scheduled task runs, and budgeted child work are rejected before dispatch.
The same restriction applies to any catalog route that cannot enforce an output cap.
Request-count limits still apply; an output limit or request budget is never a currency spending cap.

## Routing and recovery

Provider, model, output setting, workspace ID, and resolved non-secret endpoint
configuration bind durably to each session. Restart with the same configuration
to resume it. Create a new session to change providers or models. Changes to
Azure deployments, cloud project/region, gateway IDs, or OAuth endpoints cannot
silently move an existing session to another route.

Workers obtain only the selected provider's resolved authentication over the
private bridge before a request. Keys and refresh tokens are absent from worker
configuration JSON, arguments, journal events, and operator responses. Global Pi
settings and unrelated credentials remain excluded. Updated credentials are
resolved for subsequent requests; change credentials at an idle work boundary.
Switching between capped and uncapped authentication requires a service restart so
the visible capability warning cannot become stale. Logout removes stored credentials; external environment credentials remain active.

Salaam validates the serialized model, output controls, tool inventory and actual
task-context frame before durable request admission and network dispatch. SDK
retries, WebSocket fallback, provider-side tools, automatic model fallback, and
unadmitted catalog fetches are disabled. Interrupted requests retain unknown usage
and require explicit continuation. Local fixtures verify integration behavior;
they do not establish live access to every provider or reproduce a provider's
billing system.

This interface exposes Pi's built-in chat registry. Arbitrary `models.json`
providers, custom proxy URLs, and local OpenAI-compatible servers are not imported
implicitly. Coding requires [separate setup](coding.md). See the
[service reference](service-reference.md) for admission and failure handling.
