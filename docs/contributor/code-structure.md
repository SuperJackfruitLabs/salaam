# Code structure

How `src/` is organised, the rules that keep it that way, and the checks that enforce them.
The rules are tests: `test/unit/architecture.test.ts`, `test/unit/dist-imports.test.ts` and
`npm run lint`. If one of them fails, the change has broken the structure, not the test.

## Modules

Each folder in `src/` is a module. Its `index.ts` is the only file other modules import; files
inside a module import each other directly.

| Layer | Modules                         | What lives there                                                                                                                                       |
| ----- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1     | `core`                          | Wire types and errors (`protocol`), transport, config and digests, records and shared helpers. Imports nothing from `src`.                             |
| 2     | `store`                         | The SQLite connection, schema and migrations, event log, and per-concern queries (sessions, control, attempts, snapshot); usage and execution ledgers. |
| 3     | `providers`, `execution`, `web` | Model providers and credentials; the execution boundary, proofs and managed work; web fetch and search.                                                |
| 4     | `coding`, `local`, `mcp`        | Coding workspaces in containers; desk coding under the OS sandbox (commands, edits, approvals, hooks); MCP clients and admission.                      |
| 5     | `workers`, `toolkit`            | Child and external workers; SuperToolkit calls, owners and resources.                                                                                  |
| 6     | `harness`, `runtime`            | External harness adapters; the supervisor, its bridge handlers (`runtime/bridge/`), the Pi launch, and the house extension (`runtime/house/`).         |
| 7     | `tasks`                         | Durable tasks, jobs, schedules, teams, verification.                                                                                                   |
| 8     | `agentpod`, `a2a`               | AgentPod work and its failure rules (`agentpod/failures/`), stations; A2A peers.                                                                       |
| 9     | `service`, `host`               | The HTTP service (router, one controller per resource); host start and configuration.                                                                  |
| 10    | `tui`                           | The terminal client: app, slash command registry (`tui/commands/`), panels, sections.                                                                  |
| 11    | `acp`                           | The ACP server for editors.                                                                                                                            |
| 12    | `cli`                           | Argument dispatch and one module per command group (`cli/commands/`).                                                                                  |

The layer order is `LAYERS` in the architecture test. A module imports only from lower layers;
within a layer, modules do not import each other.

## Rules

1. **Imports point down.** When a lower layer needs something from a higher one, the lower layer
   declares a narrow interface listing only the members it uses, and the higher layer passes the
   implementation in through a constructor or options. Examples: `runtime/station.ts`
   (`StationBridge`), `workers/children.ts` (`ChildSupervisor`), `a2a/inbound.ts`
   (`A2AInboundService`). No service locators, no global registries.
2. **Cross-module imports go through `index.ts`**, which re-exports by name (no `export *`).
   Two exceptions: a lazy `await import()` may name a file so the module stays unloaded until
   needed, and the files a separate process loads (the house extension in Pi, the edit and
   orphan helpers) import files directly so that process loads only what it needs.
3. **No cycles between modules.** A cycle inside one module is allowed but kept small
   (`LARGEST_CYCLE`, currently 5, inside `store`).
4. **Files stay under 1,000 lines**; a file over 600 says why in its header. `OVERSIZE` in the
   architecture test lists exceptions and is empty.
5. **The house extension's code is digested.** Every file Pi loads with it is hashed by
   `bundleDigest` in `core/config.ts`; the architecture test fails if one is missing.
6. **Scripts, fixtures and `bin` load the build by path** (`dist/src/<module>/<file>.js`) and are
   not type checked. `dist-imports.test.ts` checks every such path and imported name exists.

## Lint

`npm run lint` runs oxlint with type-aware rules (`.oxlintrc.json`; oxlint-tsgolint works with
TypeScript 7). Existing findings are counted per rule in `scripts/lint-baseline.json`:

- A count may fall but never rise. After a cleanup, `npm run lint -- --update` locks it in;
  lint fails until you do, so a stale baseline cannot hide a regression.
- A rule absent from the baseline must be clean everywhere: for example floating or misused
  promises, and `return` in `finally`.
- `src/` must stay clean of the rules it has cleared (`SRC_CLEAN` in `scripts/lint.mjs`), whatever
  the baseline allows in tests and scripts: no `any`, no unexplained empty `catch`, type-only
  imports, no unused code, no `console` outside `cli`.

Remaining counts (mostly `!` non-null assertions and unchecked type assertions) are held, not
cleared: rewriting them wholesale risks changing behaviour. Lower them in code you touch.

## Practices

- **Errors:** throw `ServiceError` with a code from `core/protocol`; the service maps codes to
  status in one place (`service/router.ts`). A rethrown error keeps its cause.
- **Parse at the boundary.** JSON from the wire, SQL rows and Docker or provider responses are
  parsed once into named types; `unknown` is narrowed there, never passed on as `any`.
- **Small units.** Functions under about 80 lines; a long method becomes named steps or a
  strategy object (see `agentpod/failures/`).
- **Named constants** for timeouts, limits and sizes, beside the code that uses them.
- **Characterize before restructuring.** Before moving behaviour, commit a test against the old
  code that pins it (routes, SQL statements, wire messages, rendered output, the Pi launch), then
  restructure until it passes unchanged. Snapshot tests must pass in a bare environment
  (`env -i PATH="$PATH" HOME="$HOME" CI=true node node_modules/vitest/vitest.mjs run test/unit`);
  CI sets no `COLORTERM` or `TERM_PROGRAM`.

## Adding a module

Create `src/<name>/index.ts`, add the name to the right layer in `LAYERS`, and export from the
index only what other modules use. The architecture test fails for a folder with no layer.
