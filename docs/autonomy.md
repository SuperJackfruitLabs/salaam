# Permissions and progression

Salaam configures **what may execute** separately from **how work advances**. Open `/permissions` and `/progression`, or select either from `/settings`. Both controls are available in the action palette.

## Local permissions

| Mode                      | Edits                                                                             | Shell commands          |
| ------------------------- | --------------------------------------------------------------------------------- | ----------------------- |
| Inspect                   | Denied                                                                            | Denied                  |
| Review every mutation     | Exact approval required                                                           | Exact approval required |
| Auto-approve scoped edits | Automatic for all files matching the configured scope; other edits require review | Exact approval required |

Coding sessions default to Review. Inspection sessions retain their read-only capability: a permission setting cannot turn them into coding sessions. Use `/coding` to create a coding session first. Managed stations and specialist workers retain their host/parent authority and cannot use these local presets.

Scopes are exact project-relative filenames or directory prefixes ending in `/`: for example `README.md`, `src/`, and `test/`. `src/` does not match `src-other/`. Globs, absolute paths, traversal and private paths are rejected. All files in a multi-file edit must match for automatic approval. Existing restrictions on symlinks, hard links, hidden/private files, file sizes and optimistic content hashes remain in force.

Review the workspace, mode and complete scope list before saving. Changes are controller-authorized and revision checked, stored durably with events, and do not alter task budgets or progression. A newer policy invalidates previously auto-approved operations that have not executed. Already-running commands are not stopped by changing this setting; cancel them explicitly. Policy changes do not automatically approve previously pending manual reviews.

An automatic decision records the policy revision/digest and exact operation binding. Execution still requires the original worker/attempt, current authority, an unexpired approval, a valid task grant, unchanged files and settled resources. Uncertain operations are never replayed. Configuring permissions advances the state schema so older daemons refuse to open it rather than ignore restrictions. Policies survive daemon restarts; old worker approvals do not gain fresh authority. Forks do not inherit automatic edit permission and default to manual review.

Local commands run as your OS user, outside an OS sandbox. A command or test script may access files and network beyond its working directory. Scoped edit permission therefore does **not** auto-approve shell commands, network access, MCP calls, external effects or child work. It is an approval convenience within the existing local-user execution profile, not isolation from hostile processes or later execution of modified scripts.

## Progression

`/progression` offers:

- **Manual steps:** pause admission of later task steps; already-running work may settle. An ordinary interactive session already runs one submitted instruction at a time, with whatever model/tool loop that instruction needs.
- **Bounded automatic task:** configure or inspect a checked task, its budgets, and a maximum number of new steps. Checked task execution uses its existing supported workspace/executor requirements; selecting this does not install an executor or grant local coding authority.
- **Scheduled tasks:** use existing reviewed templates and bounded occurrences. No task or schedule is created just by opening the menu.

Progression never selects a permission mode or overrides an approval, execution fence, budget, failed verification or unresolved outcome. `/plan` and `/review` remain model instructions, not enforced permission modes. See [durable tasks](durable-tasks.md) and [schedules](jobs.md).
