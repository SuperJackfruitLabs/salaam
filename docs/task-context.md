# Task context and compaction

Task facts are explicit operator state stored outside Pi's conversation summary. Supported kinds are `objective`, `constraint`, `completed`, `outstanding` and `evidence`. They retain the original text, source request, task version and supersession links. Salaam does not automatically extract corrections from prose.

## Record and correct facts

```sh
sal task inspect SESSION_ID
sal task update SESSION_ID --task-version 0 --kind objective --text 'Review the release'
sal task update SESSION_ID --task-version 1 --kind constraint --text 'Use production'
# Inspect the returned fact IDs; supply the original constraint's ID:
sal task update SESSION_ID --task-version 2 --kind constraint \
  --text 'Use staging only' --supersedes OLD_CONSTRAINT_ID
sal task update SESSION_ID --task-version 3 --kind completed --text 'Build the package'
sal task update SESSION_ID --task-version 4 --kind outstanding --text 'Review staging evidence'
```

The expected task version is independent of the session revision and appears in `task inspect`. A correction must target a current fact from this session; a new objective must supersede the current objective. Completing outstanding work can explicitly supersede that outstanding fact. Repeating a `--request-id` with identical logical input returns the saved result, including after its lease/version becomes stale. A changed input conflicts. New requests require a current controller and an idle ready parent; use `--takeover` only when intentionally replacing another controller.

Every provider request includes the current task block, and the service checks the actual payload against its own current version and digest before forwarding. The block is limited to 16 KiB and 128 facts, including superseded history. Exceeding capacity fails the entire update rather than dropping mandatory state. These limits favor a small explicit task ledger; automatic fact extraction and archival are outside this slice.

## Save and retrieve evidence

```sh
sal artifacts put SESSION_ID --text 'Build passed; inspected artifact digest: ...'
sal task update SESSION_ID --task-version 5 --kind evidence \
  --text 'Build report' --artifact-id ARTIFACT_ID
sal history read SESSION_ID --artifact-id ARTIFACT_ID
# A non-null next_offset means another bounded page is available:
sal history read SESSION_ID --artifact-id ARTIFACT_ID --offset 8192
sal history read SESSION_ID
sal history read SESSION_ID --entry-id ENTRY_ID
```

Text uploads are capped at 256 Ki characters. Artifact references belong to their session and are content-checked when read. History reads return up to 8192 characters, or an index page of up to 32 entries. They include older imported Pi entries even after compaction. The managed `salaam_history` tool exposes the same read-only, session-scoped retrieval to the parent model. Child artifacts are consumed through the child-result tools/API.

## Compact at an idle boundary

```sh
sal session compact SESSION_ID --task-version 6
sal compactions inspect COMPACTION_ID
sal compactions cancel COMPACTION_ID
```

Starting a checkpoint returns a durable compaction ID immediately. Inspect it until its state is `completed`, `failed`, `cancelled` or `interrupted`. Supply a stable `--request-id` to recover a lost start/cancellation response. Cancelling requires the session controller; it records intent before requesting Pi abort.

This initial strategy creates a deterministic checkpoint of the explicit task ledger and retains the latest user turn. Earlier conversation and evidence remain retrievable. It makes no summarization model request and records known zero provider usage for the checkpoint. It does not claim to condense every unrecorded semantic detail into a generated summary. Automatic and model-generated compaction stay disabled.

The service rejects compaction while a turn or approval is active. Task facts, child results, approval bindings and unknown operations remain independent of summaries. Failure/cancellation leaves the task version and committed compaction cursor unchanged. A pipe failure makes the compaction interrupted and requires worker reconciliation; a matching persisted Pi receipt can establish completion on replacement. An uncertain compaction is never automatically replayed. Inspect an interrupted operation before starting a new checkpoint with a fresh request ID.

The [S5 proof](../test/proofs/context-compaction.test.ts) covers three compactions and an idle restart, actual payload inspection, old-evidence retrieval, failed/cancelled checkpoints, active approvals, outstanding child/unknown-effect preservation and worker death on both sides of Pi persistence. Its deterministic provider's next-action trace excludes completed work. Whether a particular live model follows the context requires a separate behavioral evaluation.
