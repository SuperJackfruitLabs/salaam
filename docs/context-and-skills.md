# Reviewed context and skills

Salaam loads workspace guidance only after explicit review. It keeps Pi's automatic
context, skill, extension and prompt discovery disabled. Installing a skill bundle
does not activate it, grant tools, or change permissions or task progression.

Use a complete `agent-skills` bundle built for the `salaam` adapter, placed at
`.salaam/skills/sjl-<profile>` in the session workspace. Review it in an idle TUI:

```text
/skills review AGENTS.md .salaam/skills/sjl-authoring
```

The confirmation shows the exact guidance, source paths, bundle digests and
resource hashes. Relative paths without whitespace are supported by this command.
Approve only content you trust as model guidance. `/skills` shows the current
inventory; `/skills clear` reviews an empty admission without deleting the installed
files. A changed workspace or resource requires a new review. Symlinks, path
escapes, credential directories, unsupported manifests, extra bundle files,
duplicate metadata keys and mismatched resource hashes or executable bits are
rejected. Supporting resources are pinned, but their presence never authorizes
execution or bypasses the normal workspace tools.

Admitted guidance is bounded to 128 KiB, separately from the existing 16 KiB
mandatory task-fact budget. Its exact bytes are included in the enforced task
frame. Required facts remain present. Fresh model requests and tool grants check
the admission again; stale content blocks them. Saved admission request receipts
remain replayable before fresh authorization or drift checks. Updating guidance
requires current session control and an idle worker.

Inventory separates admission from loading. `loaded: null` means there is no
current-worker payload evidence. `loaded: true` means the reviewed bytes were
verified in the current pinned Pi provider payload, not that the model exercised
the skill or completed work. `state: stale` fences new grants. A daemon or worker
restart retains the admission, but does not manufacture loading evidence.

The operator Unix-socket API exposes:

- `GET /v1/sessions/<id>/context`: metadata-only inventory and loading evidence.
- `POST /v1/sessions/<id>/context/plan`: current controller credentials and
  `selection: {files: ["AGENTS.md"], bundles: [".salaam/skills/sjl-authoring"]}`.
- `POST /v1/sessions/<id>/context/admit`: the same selection, controller
  credentials, unique `request_id`, reviewed `digest`, and `expected_revision`.
- `GET /v1/command-inventory`: the versioned TUI command registry, including
  execution type and arguments. These are TUI commands, not ACP plugin commands.

Bundle metadata follows `agent-skills` schema v1: recursively sorted two-space
JSON with a final newline, raw UTF-8 and SHA-256. Every supporting file and its
executable bit is checked. Raw manifest bytes are also bound to the admission.
The bundle's source lock and notices remain part of that inventory. Hashes identify
reviewed content, not author identity or an authority grant.

The first admission advances the journal to schema 31 after its prerequisite
station-table migration. Older binaries refuse this state. Roll back using the
matching stopped-state backup and runtime; do not downgrade the schema number.
Root-session admission does not silently propagate to specialists or external/A2A
workers. Station-wide automatic admission and mixed-team inheritance require their
own reviewed configuration and acceptance evidence.
