# Changelog

Salaam uses Semantic Versioning. Before 1.0, a minor release may introduce breaking
CLI or service changes; patches preserve documented behavior. State schema upgrades
are forward-only: keep a stopped-daemon backup before upgrading.

## [Unreleased]

- Add the complete pinned Pi provider catalog, model listing, API-key and OAuth setup, and cloud credentials.
- Validate all ten chat APIs at dispatch, preserve provider-bound recovery and usage, and allow uncapped subscription routes for durable tasks with an explicit token-budget opt-out, while preserving request/runtime limits and rejecting unsupported token caps.
- Add admitted native specialist profiles, immutable repository evidence, reviewer
  findings, durable task-step assignments and passive team messages.
- Give coding specialists private drafts with explicit hash-bound integration,
  protected human edits and fresh parent acceptance checks.
- Add pinned Gemini ACP, Claude ACP and Codex app-server workers with isolated
  execution, concrete shared approvals and durable invocation/recovery records.
- Add pinned A2A analysis peers, private one-use inbound grants, owned task
  reconciliation and named Hermes/OpenClaw transport interoperability.
- Show native, harness and peer workers together in the Salaam terminal, with
  saved identities across disconnects and explicit recovery of uncertain work.

## [0.0.1] - 2026-10-18

Initial release preparation. A version entry is not a published release; see GitHub
Releases for published artifacts.

- Persistent Pi-backed sessions, durable prompt dispatch, approvals, operation
  receipts, task checkpoints, bounded progression, jobs and recurring schedules.
- Salaam Night and Paper TUI, the `salaam` and `sal` CLI commands, SSH attachment,
  ACP integration, and pinned host supervision.
- Pinned, bundled CLI tarballs with checksums and clean-install acceptance on Linux
  and macOS; tag-driven GitHub Releases and optional npm trusted publishing.
- Product landing page and searchable user documentation built from the same repo.
