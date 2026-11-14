# Salaam development

Use the exact Node and npm versions in `.nvmrc` and `package.json`. Install with `npm ci --ignore-scripts`; dependencies and Pi artifacts are pinned.

Before finishing a code change, run `npm run format:check`, `npm run check`, `npm run lint`, and the tests relevant to the changed behavior. `npm test` builds first and exercises the real pinned Pi executable with an offline provider. Local socket and process supervision tests need host permissions when a sandbox blocks them.

Keep Pi-specific wire records inside the adapter and house extension. Never edit Pi JSONL directly. Commit application state and its events in one transaction, and publish events only after commit. Check saved request IDs before testing new-mutation revisions.

Required-control failures must deny new model/tool grants and invalidate worker readiness. A model's final message is not proof that a managed operation succeeded. Inspect actual tool outcomes, including nested calls.

Update the readiness and recovery regression tests when changing supervision, authentication, policy or context admission. Do not claim S1–S5 from a passing S6 test. Keep unsupported capabilities explicit in health output and documentation.

Keep fixtures in disposable directories. Do not use real provider credentials or external side effects in the default suite. Never fetch or install plugins during a model turn.

Update `docs/` in the same PR as any change users can see: commands, keys, CLI options, config, permissions, sandbox or editor behaviour. The command and key tables in `docs/tui.md` and `docs/cli.md` are generated; run `npm run docs:generate` after changing `src/core/slash-commands.ts`, `src/tui/keymap.ts`, `src/cli/help.ts` or a command's help text in `src/cli/commands/`. The docs-reference test fails on stale tables and on any slash command, CLI option, `SALAAM_*` variable or config file the docs name that the code lacks. CI's docs check fails a PR that changes user-facing source without touching `docs/`; label it `no-docs` only when nothing users see changed. Pages in `docs-site/pages.json` deploy to docs.salaam.sh on merge.

Keep the structure in `docs/contributor/code-structure.md`: each folder in `src/` is a module imported only through its `index.ts`, imports point down the layers in `test/unit/architecture.test.ts`, files stay under 1,000 lines, and `src/` stays free of `any` and unexplained empty catches. When a lower layer needs a higher one, declare a narrow interface and pass the implementation in. Before restructuring behaviour, commit a characterization test against the old code first.

## Things agents get wrong

- **Run what CI runs before pushing.** Read `.github/workflows/ci.yml` and `docs-required.yml`: at least `npm run format:check`, `npm run check`, `npm run lint` and the tests for the change. Prettier checks every file, Markdown and workflows included rather than guessing; the commands are there.
- **Snapshots and goldens pass in a bare environment and on Linux.** Run them under `env -i PATH="$PATH" HOME="$HOME" CI=true npx vitest run <file>`. Normalise platform strings (OS, arch) and `COLORTERM` in the test instead of recording your machine's.
- **Count lint baselines on a clean install** (`npm ci --ignore-scripts`), never on a tree with stray packages or a stale build.
- **No skipped tests.** Never `.skip`, `.only` or delete a red test to get green; fix it, or say in the PR why it is red.
- **Characterization test first.** Before a refactor that touches behaviour, commit a test against the old code and prove it can fail (revert the code, watch it go red).
- **Check the PR is still open before pushing to its branch.** PRs are often merged within minutes, and a push to a merged branch strands the work.
- **A docs-only PR runs only `sites` and `docs-checks`.** `scripts/ci-docs-only.mjs` calls a PR docs-only when every changed path is a root `README`/`README.*` or under `docs/` or `docs-site/`; then the application jobs and the evidence gate are skipped, and `docs-checks` runs `npm run format:check` and the docs-reference test. Anything else, and every push, schedule, manual run and call, runs the usual plan. The `check` job is the run's verdict.
- **The CLI entry is `dist/src/cli/cli.js`.** `bin/salaam.mjs` and the deploy scripts load that path; do not move or rename it.
- **Scripts load the build by path.** `scripts/`, `bin/`, `deploy/` and fixtures import `dist/src/...` untyped, so a moved file or export breaks them only at run time. `test/unit/dist-imports.test.ts` covers them: keep it green, don't loosen it.
- **A `v*` tag runs the suite's shared release workflow** (`.github/workflows/release.yml` and `.github/release/`, synced byte-identical from the suite's release kit: change them there, never here; settings in `.github/release-config.json`; Salaam's own hooks are `.github/release/check.sh` and `.github/release/publish.sh`). Its gate needs main's full CI run for the tag's commit and `scripts/release-check.mjs` + `scripts/release-source.mjs` (version, changelog, CI certificate, package bytes, CI attestation); it ships that run's package, then publishes it to npm (`deploy/release/npm-publish.sh`). Only the operator tags.
- **The Claude CI files are synced copies.** `.github/claude/claude-ci.mjs` and the `claude-review`/`claude-triage` workflows come from the suite's shared kit; change them there, not here. The advisory PR review follows [`REVIEW.md`](REVIEW.md).
