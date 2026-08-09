# Phase 5 — promote, recover, or discard (Worldlines Release 1)

> **Status:** complete — a candidate promotes into the primary through a
> recoverable three-way merge, the result lands in primary Change Review on
> a promoted terminal, and a crash rolls back only app-written bytes (the
> Phase 5 gate, proven by `scripts/worldline-promote-test.mjs` 20/20 and
> `scripts/worldline-recovery-test.mjs` 7/7).

## What changed

### Promotion (WORLDLINES §6.10)

- New IPC `worldline:promote` (comparisonId, label) plus a **⇧ Promote**
  button on each candidate card (confirmed, then all-or-nothing).
- Preflight: candidate state and idleness (no busy agent, no verify),
  both write leases (primary + candidate workspace), dirty-model flush
  under the promotion requester, fresh captures of **W** (candidate head,
  chained from **R**) and **P** (current primary), expected-version checks
  on both generations, and the source repository identity.
- **R** is the run-start state: the candidate head is captured from the
  candidate tree with a new capture source override (enumeration and reads
  run in the candidate repo, commits land in the store with parent R), so
  `git merge-tree` computes the shared base automatically.
- Mine enforcement: a candidate-changed path that is a Mine path, or a
  symlink that aliases one, rejects the promotion with the exact reason.
- The three-way merge reuses the spike-proven `merge3`; conflicts reject
  with the file list and leave the pair usable (promote the other
  candidate, verify, or discard).
- A rejected promotion releases the leases and returns the pair to
  `ready` with the error on the card.

### Durable journal and crash recovery (WORLDLINES §6.10 steps 4-11)

- Every promotion writes `<worldsRoot>/promotion-journal/<opId>/` with an
  fsync'd journal (phases `prepared → applied → done`), the before-bytes
  of every output path, the staged merged tree, and the staged session.
- Apply is atomic per path with a final expected-P recheck; user-edit
  attribution is suppressed for the applied paths.
- A handled failure rolls back only paths whose current bytes still equal
  the app-written after-hash; anything else becomes a `conflict` journal
  that keeps every version.
- Startup recovery runs before the primary watcher starts: `applied`
  journals roll back app-written bytes, `done` journals keep the source,
  `prepared` journals are dropped, and a path changed by an external
  process stops auto-recovery with a `conflict.json` marker.

### Promoted session and terminal

- The candidate's current leaf forks into a self-contained primary-cwd
  session (the fork op now accepts `entryId: null` = the whole leaf) with
  a hidden relocation note mapping the candidate tree back to the primary.
- The session installs atomically into **pi's canonical session directory**
  (`realpath` of the project root — pi resolves /tmp to /private/tmp, so
  the picker sees the promoted session).
- A new primary terminal opens on the installed session and is brought to
  the front. Its Change Review is seeded from the journal: every output
  path carries the pre-promotion baseline (revert restores the exact
  before bytes), and the modified list shows A/M/D statuses.
- Older primary agent terminals get a one-shot `edits-<id>.md` context
  file listing the promoted paths.
- The comparison tears down with the `promoted` state; the journal is
  removed after the terminal opens.

### Supporting changes

- `SnapshotStore.capture` accepts a source override (candidate tree);
  new store helpers `diffTree`, `treePaths`, `symlinkTarget`.
- `WorldlineManager`: `promotionTarget`, `markPromoting`, `finishPromotion`
  (ok → teardown as `promoted`; rejected → back to `ready` with the
  error); summaries carry model/thinkingLevel/createdAt.
- New push `promotion:opened` activates the promoted terminal.
- Watcher: promotion applies skip user-edit recording.

## Verification

- `npx tsc --noEmit`, `node scripts/build.mjs`, `npx vite build` — clean.
- New e2e `scripts/worldline-promote-test.mjs` — 20/20: Mine rejection
  with the owned path; text-conflict rejection with the file list; the
  pair stays usable after rejections; the clean merge applies the
  candidate change while keeping an independent primary change; the
  journal is consumed; the promoted session installs with both relocation
  notes in the canonical session dir; the promoted terminal opens as the
  active tab; Change Review carries the pre-promotion baseline; primary
  HEAD/refs/index untouched; the comparison is torn down.
- New e2e `scripts/worldline-recovery-test.mjs` — 7/7: an `applied`
  journal rolls back app-written bytes at boot; a `done` journal leaves
  the source alone; an externally changed path keeps every version and
  stops auto-recovery with a conflict marker; the app boots normally.
- Regression matrix (fresh instance per suite): fork-run 27/27,
  compare 29/29, baseline-race 11/11, edits-to-agent 9/9.
- Manual smoke: promote B after a rejected A; discard after a rejected
  promotion; the promoted terminal's next run records normally.

## Known limits for the next phase

- **Release 1 gate is now complete**: Fork Run works end to end with two
  isolated candidates, Verify, comparison, recoverable promotion, and
  complete cleanup.
- No Challenge ranking: evidence contracts and deterministic comparison
  profiles are Phase 7.
- Fork Any Moment is Phase 6: dots are still transient, watcher-hint
  incremental capture is still Release 2 work, and nested worldlines do
  not exist yet.
- Trust-sensitive resource hashes are not yet computed; the run records
  the trust flag only.
- A promotion writes the promoted session into pi's canonical session
  directory; pi's own session retention prunes old sessions there.
