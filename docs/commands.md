# Commands

A custom command is a saved prompt. Put a Markdown file in `.salaam/commands/` in the repository,
or in `~/.config/salaam/commands/` for your own, and type `/name args`. The format follows Claude
Code's command files:

```markdown
---
description: Fix a GitHub issue
argument-hint: [issue-number]
---

Fix issue $ARGUMENTS, add a test, and run it.
```

- `$ARGUMENTS` is everything after the name; `$ARGUMENTS[0]`, `$0`, `$1`… are single arguments
  (quotes group words). `\$` is a literal dollar. With no placeholder, the arguments are added
  after the prompt as `ARGUMENTS: …`.
- A subdirectory becomes a namespace: `.salaam/commands/frontend/component.md` is
  `/frontend:component`.
- Your command wins over a repository's of the same name. A built-in command such as `/yolo`
  always wins; a file that tries to redefine one is skipped and listed under `/help`.
- A command only writes a prompt. It never runs anything, approves a tool or changes a mode, so a
  repository's commands are loaded without a trust step. `allowed-tools` and similar fields are
  ignored. The expanded prompt goes through the same checks as a typed one, including the confirm
  for secret-looking `@` files.
- Files are limited to 32 KiB, 200 per folder, and must stay inside their folder (symlinks
  included).

Custom commands appear in `/` completion and `/help`.
