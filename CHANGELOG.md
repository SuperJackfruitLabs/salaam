# Changelog

Salaam uses Semantic Versioning. Before 1.0, a minor release may introduce breaking
CLI or service changes; patches preserve documented behavior. State schema upgrades
are forward-only: keep a stopped-daemon backup before upgrading.

## [Unreleased]

- Add the complete pinned Pi provider catalog, model listing, API-key and OAuth setup, and cloud credentials.
- Validate all ten chat APIs at dispatch, preserve provider-bound recovery and usage, and restrict uncapped subscription routes to interactive sessions.

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
