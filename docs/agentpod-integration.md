# AgentPod integration

AgentPod's contract for a first-class harness is in the AgentPod spec
[`docs/superpowers/specs/2026-10-23-salaam-first-class-harness-design.md`](https://github.com/SuperJackfruitLabs/agentpod/blob/main/docs/superpowers/specs/2026-10-23-salaam-first-class-harness-design.md).
That spec also explains how each item is measured, using AgentPod's `scripts/harness-conformance.mjs`
against a live station. This note lists the obligations that fall to Salaam.

## Binding and strict work

- Strict work is enabled only by `host serve` from a reviewed schema-6 manifest, and it must stay that way.
  Pins and `work_control` must never switch it on. The daemon adds
  `work_control` itself in the `/v1/agentpod/attach` reply when the run
  source is Superpipeline.
- `salaam host plan --config` is the interface AgentPod's node uses to produce the manifest. Keep it
  stable and versioned. Its input is `{"mode":"agentpod", state, agentpod_config, station_config,
"strict_work_version":1}`.
- Provide a launcher profile, so an unprivileged node can start a reviewed host through a
  root-owned helper unit. This is the recommended option in the spec. The operator decides between it and running the node as root.
- Tools must run as a separate OS user (`--tools-user`, #46), and the station config must be able to set that user.

## Interactive sessions

- Unadmitted `/v1/sessions` stays refused (`admission_required`).
- The admitted interactive path (`run.source = "interactive"`, attach with `admission_id` and token)
  must map AgentPod's modes: `ask` to ask, `accept-edits` to auto-approve edits, and `full-auto` to auto-approve all.
- Accept HTTP `mcpServers` from ACP `session/new` in the admitted path. This is how AgentPod's
  "Use configured station tools" setting reaches the session.

## Observability

- `/v1/health` must carry `last_activity_at` (RFC3339), both top-level and per session.
- Daemon logs (journal) must never contain prompt or tool content. AgentPod tails them on the
  station's Logs tab.
- AgentPod may read the workspace read-only. It never reads the state directory.
