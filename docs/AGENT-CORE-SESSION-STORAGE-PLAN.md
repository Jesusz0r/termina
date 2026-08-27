# Agent Core Session Storage Plan

## Goal

Replace the single append-only agent-core session file with a segmented
append-only session bundle. A session must resume, search, clear, and fork after
its stored history exceeds the current 32 MiB limit. Replay and fork work must
not allocate the complete stored history or monopolize the Electron main
process.

## No backwards compatibility

This is a full replacement.

- Do not read, migrate, adopt, quarantine as current-format, or list existing
  flat agent-core session files.
- Do not keep the old whole-file reader, writer, fork path, or 32 MiB resume
  failure as a fallback.
- Ignore old core `sessionFile` values from terminal rosters. Derive the new
  path from the validated core session id and project directory.
- Update every internal caller in the same change and remove
  `adoptCoreSessionFile`.
- Existing flat agent-core sessions stop resuming and stop appearing in
  Session Search.
- Pi session files remain unchanged. Pi forks continue through
  `electron/session-fork.ts` and `electron/session-worker.ts`.

## Storage layout

Keep `sessionFile` as the stable internal address of the active JSONL segment:

```text
<project-session-dir>/<session-id>/
  current/
    part-000001.jsonl
    part-000002.jsonl
    session.jsonl
    session-img-1.png
    session-img-2.png
  archive-2026-03-17T12-30-00/
    part-000001.jsonl
    session.jsonl
    session-img-1.png
```

The stable address is `<session-id>/current/session.jsonl`. `session.jsonl` is
the writable segment. Numbered parts are immutable and sort in replay order.
The `current` directory makes `/clear` and quarantine an atomic directory
rename instead of a series of file moves. The layout needs no manifest.

The standalone events-directory default follows the same layout instead of
writing `<terminal-id>.session.jsonl` directly into the events directory.

## Sequence and record rules

`storageSeq` is positive, unique, and strictly increasing in physical record
order across the active bundle. Gaps are valid. They are required by
materialized forks and can also remain after a failed process.

Accepted records are `message`, `revision`, and `checkpoint`. Reject unknown
record types and invalid record shapes. A checkpoint contains no message; it
only preserves the next sequence address in a materialized session.

Start with:

- `MAX_SESSION_SEGMENT_BYTES = 8 MiB`;
- `MAX_SESSION_RECORD_BYTES = 1 MiB`.

Measure the encoded JSONL record, not the source string. Reject an oversized
record before changing in-memory context. Never split one record. Before an
append would cross the segment budget, rename the active segment to the next
numbered part, create a new active segment, and append there. A valid individual
record can therefore always fit in one segment.

Use exclusive creation for a new numbered part. Derive the next number from the
highest valid part. Reject symlinks, non-files, duplicate part numbers, and
unexpected JSONL names inside `current`.

## Canonical ownership

`agent-core/session.ts` owns agent-core storage:

- bundle and segment path validation;
- segment discovery and ordering;
- append and rollover;
- streaming replay;
- fresh-session preparation;
- `/clear` and quarantine rotation;
- fork materialization;
- referenced-image copying;
- structural validation;
- bundle existence, content, and removal helpers.

`agent-core/main.ts`, `electron/main.ts`, and `electron/worldlines.ts` call this
implementation. They must not inspect, concatenate, slice, copy, or remove core
session JSONL directly.

`electron/session-search.ts` remains the canonical Session Search parser and
walker. It uses bundle enumeration from `agent-core/session.ts`, but retains
ownership of search-message parsing, limits, cancellation, and hit formatting.
This preserves the repository's existing ownership boundary.

## Durable mutation order

The current `store()` increments `storageSeq`, mutates live history at several
call sites, and suppresses append failures. That can produce a successful run
whose fork address was never durable.

Replace it with one writer result contract:

1. encode and validate the record;
2. roll the segment if required;
3. append the complete record;
4. only then apply the corresponding in-memory history or revision mutation;
5. only then emit sidecar events that expose the sequence address.

Apply this order to user messages, assistant messages, tool-result messages,
prune revisions, summaries, and truncation. A configured-storage failure stops
the prompt and settles the run as failed. It must not degrade to an in-memory
session while still advertising a persisted `sessionFile`.

A process without configured storage can continue as an explicitly in-memory
session.

## Replay

Replay numbered parts in numeric order, then replay `session.jsonl`.

- Use a bounded byte-framing reader. Do not use a line API that can buffer an
  unbounded corrupt record before enforcing the record limit.
- Parse one record at a time.
- Require each sequence to be greater than the preceding sequence. Do not keep
  an unbounded `seen` set.
- Ignore only a truncated final record in `session.jsonl`.
- Reject malformed or truncated numbered parts, invalid revisions, decreasing
  sequences, duplicate sequences, oversized lines, and invalid checkpoints.
- Keep the sequence-to-message index limited to messages that revisions can
  still address. Delete entries removed by summarize or truncate.
- Set the next `storageSeq` above every replayed record, including checkpoints
  and records that do not remain visible.
- Yield at a fixed byte or record interval in main-process callers.

If rollover stops after renaming `session.jsonl`, startup discovers the new
numbered part and recreates an empty active segment. If it stops after creating
the new active segment but before the append, the empty segment is valid.

Make resume asynchronous. While explicit or startup resume runs, the TUI stays
busy and cannot accept a prompt that races replay.

A validation failure atomically renames `current` to a unique `bad-<stamp>`
directory. It preserves the bytes, creates no fresh session until the next
normal prompt, and never searches the bad directory.

## Fresh prompt and `/clear`

If the process has not resumed and a normal prompt finds content in `current`,
archive it before starting the prompt. Do not truncate valid append-only
history.

`/clear` does the same atomic rotation:

1. close the writer;
2. rename `current` to a unique `archive-<stamp>` sibling;
3. create a new mode-0700 `current` directory and mode-0600 `session.jsonl`;
4. reset in-memory session state and `storageSeq`.

If `current` has no records or images, reset it without creating an empty
archive. A crash after the directory rename is recoverable by creating a fresh
`current`; the archive is already complete. Archive-name collisions use a
numeric suffix with no fixed retry count.

## Materialized forks

Do not copy a complete historical prefix into a worldline.

Replay through the requested source sequence, then write a normalized session
that produces the same visible provider context:

1. retain visible messages in their actual context order;
2. assign those records dense sequences `1..N` in that order;
3. append a checkpoint at the requested source sequence when it is greater
   than `N`;
4. start future writes above the checkpoint.

Renumbering is necessary because summarization can place a later handoff before
an earlier surviving tail. Preserving original message sequence numbers while
writing visible order would violate the strictly increasing storage invariant.
Sequence numbers are storage addresses and are not sent to the provider, so
renumbering does not change model context. The source bundle remains the audit
history and keeps the original addresses.

Sequence zero produces an empty current session with no checkpoint. A positive
fork point greater than the source's maximum sequence fails closed instead of
silently creating an earlier fork.

Build each destination in a temporary sibling directory. After replay, record
write, and image copy all succeed, atomically rename it into place. Remove the
temporary directory on failure. Never leave a partially valid candidate.

Copy only safe image names referenced by retained image blocks. Every referenced
image must be a regular file inside the source `current` directory. A missing,
symlinked, or unreadable referenced image makes the fork fail.

## Worldline integration

The current code performs raw core session file copies in run finalization,
nested comparisons, promotion staging, promotion installation, and other
candidate paths. Replace all of them with the canonical materialization or
bundle-copy operation.

Cover at least these call sites and related helpers:

- `electron/main.ts:finalizeRun`;
- core branches in `electron/worldlines.ts:forkSessions`;
- nested comparison candidate A and B creation;
- moment forks;
- promotion staging, journal recovery, installation, and rollback;
- candidate content checks and live-worldline byte checks;
- run branch cleanup and comparison teardown.

Core run finalization materializes through `settledEntryId`. A missing or
unreachable positive settled address makes the run non-replayable. A candidate
continuation materializes the latest valid sequence. Candidate alternatives
materialize through their requested source address.

Store core run branches and promoted sessions as bundles, not disguised single
files. Promotion journals must stage and atomically install the complete bundle,
including referenced images. Rollback removes the installed bundle. This also
fixes the current core promotion path, which stages images but installs only the
JSONL file.

Keep the existing 64 MiB worldline source-file budget only where Pi requires
it. Do not apply that whole-file test to segmented core sessions.

## Main-process integration

`electron/main.ts` currently treats `sessionFile` existence and content as
`stat(sessionFile)`. That is incorrect when immutable parts contain history and
the active segment is empty or temporarily absent.

For core sessions, replace these checks with bundle helpers:

- terminal resume detection;
- roster restore;
- empty-session discard;
- live and unrestored Session Search entries;
- session-in-use checks;
- run finalization;
- promoted-session installation.

A core session is in use by its canonical bundle identity, not only by an
unresolved string path. Empty-session cleanup removes the empty bundle
directory. It never removes a bundle with numbered parts or images.

The app allocates new core paths directly as
`<project>/<session-id>/current/session.jsonl`. Old flat roster paths are not
accepted or adopted.

## Session Search

List one logical entry for each active `current` directory and each
`archive-<stamp>` directory. Search segments in replay order without showing
numbered parts as separate sessions.

Keep the existing hit count, logical-session count, per-segment byte cap,
per-logical-session line count, and cancellation budgets. Apply the 50-file
limit to logical sessions, not segments. The 8 MiB segment budget stays below
the existing 10 MiB search-file cap. Do not reject a logical session because
its total stored size exceeds 10 MiB.

Use the newest mtime across a logical session's parts for ordering. Maintain one
logical line number and previous-message snippet across segment boundaries.
Yield during a large segment, not only after a complete logical session. If a
live rollover changes the segment list during search, cancel that logical read
and retry it once from a fresh segment snapshot. Search is eventually
consistent; it must not report the same record twice.

Pi listing and parsing remain unchanged. Bad directories and old flat core
files are ignored.

## Images

The current image path derives from `dirname(sessionFile)` and the
`session.jsonl` stem. The new `current/session.jsonl` path preserves that
behavior without new image naming rules.

Persist images before writing the user message that references them. Do not
remove a pending host image until both the image file and message record are
durable. Resume and fork resolve file image references only inside the logical
session directory; no basename may escape it.

Archive rotation moves the complete `current` directory atomically, so archived
message references continue to resolve.

## Validation questions answered against the code

| Question | Current code | Required correction |
|---|---|---|
| Can sequence validation require contiguous numbers? | No. `store()` increments before a suppressed write failure, and normalized forks need gaps. | Require strictly increasing unique values; permit gaps. |
| Can a materialized fork preserve source sequence numbers? | Not always. Summarize replay can move a later handoff before an earlier tail. | Write visible order with dense new sequences and preserve the source maximum with a checkpoint. |
| Is moving individual files safe for `/clear`? | No. A crash can split JSONL parts from their images. | Atomically rename the `current` directory. |
| Does `stat(sessionFile).size` identify a non-empty segmented session? | No. The active segment can be empty while numbered parts contain history. | Route core existence and content checks through bundle helpers. |
| Can replay use `readline` safely on corrupt input? | No. One unbounded line can allocate before a limit check. | Use bounded byte framing and reject an oversized line. |
| Can replay keep every seen sequence or message? | Not for an unbounded session. | Validate monotonic order and remove unreachable messages from the revision index. |
| Is the current storage failure behavior safe? | No. It mutates memory, increments the address, suppresses the write error, and still emits run events. | Persist first; mutate and publish the address only after success. |
| Can the existing core promotion copy remain? | No. It installs the JSONL but leaves staged images behind. | Stage, journal, install, and roll back the complete materialized bundle. |
| Can Session Search list every segment as a file? | No. Segments would consume the 50-file budget and duplicate one logical session. | Enumerate logical bundles and stream their parts under one hit identity. |
| Can old roster paths pass through unchanged? | Yes today. That would recreate the removed flat format. | Ignore old core paths and derive the new path from session id plus project. |
| Can a positive fork point beyond the stored maximum succeed? | `sliceSessionText` currently returns whatever prefix exists. | Fail closed because the requested immutable session address does not exist. |
| Can a live search assume its segment snapshot stays fixed? | No. Rollover renames the active file while search runs. | Detect the changed snapshot and retry that logical session once. |

## Required tests

Add focused harness coverage for:

1. rollover before the segment budget;
2. exact-boundary append and oversized encoded-record rejection;
3. replay across multiple segments with valid sequence gaps;
4. duplicate and decreasing sequence rejection across segment boundaries;
5. a truncated active tail and a truncated immutable part;
6. both crash windows around active-segment rollover;
7. prune, summarize, and truncate revisions targeting earlier segments;
8. bounded replay indexes after old messages are evicted;
9. storage failure before in-memory mutation and sidecar publication;
10. explicit and startup resume input exclusion;
11. a fork point in each segment, at zero, and beyond the source maximum;
12. materialized fork context equivalence and dense renumbering after summary;
13. checkpoint preservation and next append sequence;
14. atomic destination cleanup after a failed fork;
15. referenced image copying, path rejection, and missing-image failure;
16. `/clear`, fresh-prompt archive, quarantine, collision, and crash recovery;
17. core promotion install and rollback with an image reference;
18. bundle-aware content, cleanup, roster, and in-use checks;
19. Session Search grouping, cross-segment snippets, rollover retry, and cancellation;
20. rejection of old flat core files and roster paths;
21. a synthetic logical session larger than 32 MiB.

Run `npm test` and `git diff --check` after the focused tests pass.

## Order of work

1. Implement validated bundle paths, bounded record framing, replay state, and
   writer rollover in `agent-core/session.ts`.
2. Move agent-core message and revision persistence in `agent-core/main.ts` to
   persist-before-mutate semantics.
3. Replace resume, fresh-session preparation, quarantine, and `/clear` with
   asynchronous bundle operations.
4. Implement atomic materialized forks and referenced-image selection in
   `agent-core/session.ts`.
5. Change core session path allocation and every bundle-aware check in
   `electron/main.ts`.
6. Replace every raw core session copy, promotion path, and cleanup in
   `electron/worldlines.ts`.
7. Update Session Search to enumerate logical core bundles while leaving Pi
   behavior unchanged.
8. Remove flat-file helpers, `MAX_SESSION_FILE_BYTES`, `sliceSessionText`, core
   raw-copy calls, obsolete tests, and obsolete documentation.
9. Run the focused harness, full test gate, and diff checks.

## Completion criteria

The work is complete when an agent-core session larger than 32 MiB can resume,
search, clear, promote, and fork without a whole-session allocation; heavy
main-process work yields; every core storage operation routes through
`agent-core/session.ts`; storage failures cannot publish non-durable sequence
addresses; promotion preserves referenced images; and no flat-file core
compatibility path remains.
