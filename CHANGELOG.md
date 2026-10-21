# Changelog

Salaam uses Semantic Versioning. Before 1.0, a minor release may introduce breaking
CLI or service changes; patches preserve documented behavior. State schema upgrades
are forward-only: keep a stopped-daemon backup before upgrading.

## [Unreleased]

## [0.0.3] - 2026-10-22

- Improve local coding with direct workspace access, repository context, model and
  provider selection, and complete terminal slash-command controls.
- Configure permission policy separately from task progression, with scoped
  auto-approval that preserves execution and workspace boundaries.
- Add AgentPod station execution with principal, occupant and run binding,
  explicit revocation, deterministic startup and durable reconnect recovery.
- Admit managed HTTP MCP and bounded Toolkit processes using pinned schemas,
  private control channels, durable effect receipts and protected credentials.
- Bind durable Superpipeline runs and exact human decisions to task recovery,
  fresh native verification and one recorded completion.
- Admit pinned runtime, configuration and shared skills with provenance, drift
  detection and explicit supported-capability reporting.
- Join native child, tool, check and usage evidence across products, export
  immutable artifacts to Library and support independent Witness verdicts.
- Preserve uncertain effects and historical receipts across restarts. Report
  telemetry delivery and artifact export failures separately, and retry exports
  against the original saved upload rather than duplicating them.

State upgrades are forward-only. Stop the daemon and back up its private state
before upgrading an existing installation. Broad fleet migration and additional
substrate acceptance are not part of this release.

## [0.0.2] - 2026-10-19

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
