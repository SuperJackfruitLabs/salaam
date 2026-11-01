# Rules

Give the agent standing instructions in an `AGENTS.md` file: how to build and test the
project, its conventions, what to avoid. Salaam reads these files automatically in
interactive sessions, the same convention other coding agents use.

## Create one

Run `/init` in a session. The agent reads the repository and drafts an `AGENTS.md`;
the edit asks for approval like any other. Commit it so everyone working on the
project shares it.

## Which files are read

In order:

1. Your own file, `~/.config/salaam/AGENTS.md` (`$XDG_CONFIG_HOME/salaam/AGENTS.md`),
   for instructions that apply to every project.
2. `AGENTS.md` in every directory from the repository root down to the session's
   folder. Where a directory has no `AGENTS.md`, its `CLAUDE.md` is read instead.

The header shows which files the session is using. When a file changes, Salaam reloads
it at the next turn and says so.

## Limits

- Each file is at most 32 KiB, and all of them together at most 64 KiB.
- Files must be regular UTF-8 text. Symbolic links are not followed.
- A file that is skipped is listed with the reason, never dropped silently.

## Reviewed skills

Skills and other guidance beyond `AGENTS.md` are loaded only after you review them
with `/skills review`, which shows their exact contents and records their hashes. A
skill never grants tools or changes permissions.
