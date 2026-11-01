# Modularity and code-quality plan

Status: proposed 2026-11-02. Ships as one release (0.0.7); phases merge to main one PR at a
time, and nothing is tagged until the last phase is done.

## Where the code is today

Measured on main at f23624f.

| Measure                                      | Today                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Source files                                 | 167, all flat in `src/`, 64,905 lines                                                                                                  |
| Largest import cycle                         | **89 files, 33,813 lines**: every one reaches every other                                                                              |
| Other cycles                                 | `service` ↔ `a2a-inbound`                                                                                                              |
| Files over 2,000 lines                       | `agentpod-work` 3,924, `service` 3,548, `tui` 3,266, `supervisor` 2,150                                                                |
| Files over 1,000 lines                       | 8 more (`cli` 1,922 … `managed` 1,004)                                                                                                 |
| Longest methods                              | `service.handle` 2,465 lines; `agentpod-work.historicalKnownReadOnlyFailure` 1,405; `supervisor.bridge` 784; `tui.runSlashCommand` 594 |
| Files running raw SQL on `store.db`          | 51 (1,008 `prepare` calls); 71 tables declared in `store.ts`                                                                           |
| Linter                                       | none (Prettier only)                                                                                                                   |
| Empty `catch` blocks                         | 201                                                                                                                                    |
| Non-null assertions (`!`)                    | 655                                                                                                                                    |
| `any`                                        | 110, of which `Record<string, any>` 58                                                                                                 |
| Inline `import('./x.js')` types              | 112, mostly hiding cycles                                                                                                              |
| `console.*` / `process.exit` outside the CLI | 102 / 21                                                                                                                               |

What already works and stays: `strict` and `noUncheckedIndexedAccess` in tsconfig, Prettier,
3,132 unit tests and 69 proof files that drive the product from outside (HTTP, TUI, ACP, the
agent's bridge), and an evidence gate that refuses skipped tests.

### Why the cycle exists

`store.ts` is the persistence layer, yet it imports features: it constructs the usage ledger,
the worker boundary and the execution authority, which each import the store back, and it
reaches into `toolkit-resolutions`, `acp-outcome` and `readiness-fingerprint`. Fifty-two files
import the store, so almost everything ends up in one knot. Fifty-one of them also write SQL
against its tables directly, so no feature owns its own data.

## Target structure

Feature folders, each with an `index.ts` that is its only public entry point. Dependencies
point one way, down this list:

| Layer         | Modules                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. `core`     | protocol types, errors, transport, config, state lock, package digest. Imports nothing from `src`.                                                                                                                                         |
| 2. `store`    | connection, transactions, the event log and migrations. Imports only `core`. Each feature's tables and queries live in that feature's repository, registered with the store's migrations.                                                  |
| 3. Features   | `providers`, `execution`, `runtime` (supervisor, Pi, house extension, hooks, turns, children), `local` (desk coding, sandbox, edits, undo, diff), `tasks`, `agentpod` (work, stations, managed), `toolkit`, `mcp`, `harness`, `web`, `a2a` |
| 4. Interfaces | `service` (HTTP API: router + controllers), `acp`, `host`                                                                                                                                                                                  |
| 5. Clients    | `tui`, `cli`. Talk to the service over its protocol; never import `store` or features.                                                                                                                                                     |
| Composition   | one `app` module that builds the object graph (store, ledgers, supervisor, service) and nothing else does `new` on another module's internals.                                                                                             |

Rules, enforced by a test (see Phase 0):

1. A module imports another only through its `index.ts`.
2. No cycles between modules. A cycle inside one module is a smell, not a failure.
3. A layer imports only from layers below it. Features import each other only when a dependency
   points down a documented edge; otherwise the lower one exposes an interface and the
   composition root injects the implementation.
4. Only a feature's own repository touches its tables.
5. Source files stay under 1,000 lines; a file over 600 needs a reason in its header.

## Code practices

These apply to every line the phases touch, and become lint rules so they hold afterwards:

- **ESLint with typed rules** (`typescript-eslint` strict-type-checked, flat config, pinned):
  `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`,
  `consistent-type-imports`, `no-explicit-any`, `no-non-null-assertion`, `no-empty` (a `catch`
  that ignores an error says why in a comment), `no-console` outside `cli`.
- **Ratchets, not big-bang**: where a rule has hundreds of existing hits (`!`, `any`, empty
  catch), a test records the count per file and fails if it goes up. Each phase lowers it in
  the code it touches. The target at release: no `any`, no unexplained empty catch, `!` only
  where an index was just checked.
- **Errors**: one `SalaamError` base in `core` with a `code`; features throw subclasses, the
  service maps codes to HTTP status in one place. No `process.exit` outside `cli`.
- **Types at boundaries**: wire and SQL rows are parsed once into named types; no
  `Record<string, any>` past the parser. Type imports use `import type`, never inline
  `import('./x.js')`.
- **Small units**: functions under ~80 lines; a method that long becomes a named step or a
  strategy object. Classes have one job and take their collaborators in the constructor.
- **Named constants** for timeouts, limits and sizes, kept next to the code that uses them.
- **Tests mirror the source tree** (`test/unit/<module>/…`) and import through the module's
  `index.ts` where they test public behaviour.

## Phases

Each phase is one PR (or a few), merged when the full CI is green. **The behaviour does not
change.** CLI, HTTP routes, ACP messages and the state database schema stay exactly as they are;
the existing tests are the oracle and change only their import paths, except the new
architecture and lint tests.

| Phase | What                                                                                                                                                                                                                        | Done when                                                 |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 0     | **Guardrails.** ESLint with the rules above; `test/unit/architecture.test.ts` computes the import graph and reports cycles, layer and entry-point violations against a module map; ratchet baselines for every count above. | CI fails on a new cycle, a new `any` or a new empty catch |
| 1     | **Untangle the core and the store.** Move shared types and errors to `core`; the store stops constructing the ledgers and authorities (the composition root does); per-feature tables move behind repositories.             | The 89-file cycle is gone; `store` imports only `core`    |
| 2     | **Folders.** `git mv` every file into its module, add `index.ts` public APIs, update imports, scripts that load `dist/src/...`, the house-extension path, and mirror the tests. Pure moves, one commit per module.          | Entry-point rule on; module graph acyclic                 |
| 3     | **Service.** `handle()` becomes a route table and one controller per resource (sessions, control, submissions and runs, work, tasks and reviews, integrations); errors map in one place. Fixes the `a2a-inbound` cycle.     | `service` under 1,000 lines; no controller over 600       |
| 4     | **Runtime.** `supervisor.bridge()` becomes one handler per kind of request behind a `BridgeHandler` interface; launch building moves out of `start()`; split `house-extension` by tool.                                     | Same size limits                                          |
| 5     | **AgentPod work.** The failure checks become `FailureRule` classes in an ordered list; the 1,405-line check splits into the evidence it gathers and the decision it makes; `station-work` follows the same pattern.         | Same size limits; each rule has its own test file         |
| 6     | **Clients.** `tui`: a `SlashCommand` registry (one file per command group), panels and approvals as components; `tui-view` by panel. `cli`: one module per command group with the help text beside it.                      | Same size limits; clients import no feature internals     |
| 7     | **The rest over the line** (`local-coding`, `acp`, `managed`, `store` leftovers) and the ratchets to their targets: no `any`, no unexplained empty catch.                                                                   | No file over 1,000 lines; ratchet targets met             |
| 8     | **Close.** Update `docs/contributor` and `AGENTS.md` with the module map and rules; CHANGELOG; release 0.0.7.                                                                                                               | Released                                                  |

### How each phase is checked

- Locally before pushing: `format:check`, `check`, ESLint, the full unit suite, the proofs for the
  area that moved.
- CI: the full matrix, including the macOS and Linux acceptance runs and the release package
  install.
- After Phase 2 and at the end: the TUI, ACP (Zed) and a desk session run by hand on the Mac
  against the built checkout.

### Risks

- **Conflicts with other Salaam work.** Phase 2 moves every file; any open PR conflicts. Land
  Phase 2 quickly and avoid other Salaam changes while it is open.
- **Path-loaded files.** 61 scripts and tests load `dist/src/<file>.js` by path, and Pi loads
  the house extension by path. Phase 2 updates them all; the acceptance runs catch a miss.
- **Behaviour slipping during restructuring** (Phases 3–7). Tests drive the product from outside,
  so they hold; where a phase finds an area no test covers, it adds the test first, against the
  old code.
