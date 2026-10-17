# Salaam development

Use the exact Node and npm versions in `.nvmrc` and `package.json`. Install with `npm ci --ignore-scripts`; dependencies and Pi artifacts are pinned.

Before finishing a code change, run `npm run format:check`, `npm run check`, and the tests relevant to the changed behavior. `npm test` builds first and exercises the real pinned Pi executable with an offline provider. Local socket and process supervision tests need host permissions when a sandbox blocks them.

Keep Pi-specific wire records inside the adapter and house extension. Never edit Pi JSONL directly. Commit application state and its events in one transaction, and publish events only after commit. Check saved request IDs before testing new-mutation revisions.

Required-control failures must deny new model/tool grants and invalidate worker readiness. A model's final message is not proof that a managed operation succeeded. Inspect actual tool outcomes, including nested calls.

Update the readiness and recovery regression tests when changing supervision, authentication, policy or context admission. Do not claim S1–S5 from a passing S6 test. Keep unsupported capabilities explicit in health output and documentation.

Keep fixtures in disposable directories. Do not use real provider credentials or external side effects in the default suite. Never fetch or install plugins during a model turn.
