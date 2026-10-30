# Changelog

Salaam uses Semantic Versioning. Before 1.0, a minor release may introduce breaking
CLI or service changes; patches preserve documented behavior. State schema upgrades
are forward-only: keep a stopped-daemon backup before upgrading.

## [Unreleased]

## [0.0.4] - 2026-10-30

Board work on a protected AgentPod station, made to match the Hermes workflow, plus a sandbox
for local commands.

### Added

- Approvals: "Approve for this run", per-agent "Always allow" (offered on workspace writes, owners
  and admins only), plain-words approval offers, and rules added at renewal joining the run in
  flight.
- Completion critic: a plan may declare a rubric; a read-only reviewer judges the verified
  deliverables before the task completes. Completion hooks are required checks.
- Checkpoints: read-only checkpoints of a station run, their diff against the live workspace, and
  restore exactly as approved.
- Command sandbox: bubblewrap on Linux and Seatbelt on macOS. With no usable sandbox, local
  commands are refused unless the host config sets `unsandboxed_commands: "allow"`.
- Command network through the broker: with `command_network: "broker"` in the host config, local
  commands reach only the hosts the operator lists in the stk policy (`local-commands`
  egress `hosts`). Everything direct stays blocked, and each command's result counts the hosts it
  reached or was refused. Needs SuperToolkit v0.0.4.
- Board parity: the work-status tool-step tail carries each step's output and a readable title;
  plan updates reach the card; board reads are served by the hub.
- Operator persona pinned by digest in the host manifest.
- Budgets and retries: step request budgets, rate-limit retry then a provable stop, and
  verification-budget stops that settle without anyone clearing them.
- A fetch host that keeps failing is paused briefly instead of failing the run.
- Add `--tools-user` (`SALAAM_TOOLS_USER`) to run local agent commands, edits and
  undo as a separate unprivileged OS user via a runas-restricted sudo rule, so
  tools cannot read the provider credential. Without it, startup warns.

### Fixed

- A verification read refused at spawn no longer leaves the daemon unable to start; a stuck
  pid-less helper settles once `/proc` proves no helper runs (Linux only; elsewhere it stays
  fenced).
- A run stopped by its own failed acceptance check reaches the board as a failed run instead of
  parking.
- Readable titles for MCP steps with no input, and for finished steps.

### Upgrade notes

- Hosts without a usable bubblewrap (Linux) or Seatbelt (macOS) now refuse local commands. Install
  or repair the sandbox, or set `unsandboxed_commands: "allow"` explicitly.
- Release after AgentPod v0.1.118 (hub): the step output field and board reads need that hub.

## [0.0.3] - 2026-10-22

- Update the MCP SDK and optional Hermes certificate bundle to patched releases.
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
