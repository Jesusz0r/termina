# Phase 5 — promote, recover, or discard (Worldlines Release 1)

> **Status:** complete — a candidate promotes into the primary through a
> recoverable three-way merge, the result lands in primary Change Review on
> a promoted terminal, and a crash rolls back only app-written bytes while
> retaining journal/session evidence rather than deleting anything selected
> by a recovered journal (the
> Phase 5 gate, proven by `scripts/worldline-promote-test.mjs` 20/20 and
> `scripts/worldline-recovery-test.mjs` 34/34).

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
  atomically replaced and fsync'd journal (phases
  `prepared → applying → applied → done`), durable authenticated
  before-images, the staged merged tree, and the staged session. A crash
  from the first primary mutation is therefore recoverable.
- Apply validates and syncs each staged regular file before a final
  containment and complete expected-state recheck, then renames or deletes
  one path. File data and every newly-created destination directory entry
  are durable before `applied`.
- Recovery validates the complete active journal and every path before its
  first mutation. It distinguishes missing, regular file (hash + executable
  mode), and symlink (target), accepts only the exact current record or the
  exact former production record, and rejects duplicate or unsafe paths.
- `prepared`, `applying`, and `applied` all roll back only paths whose
  current complete state is either the recorded before-state or app-written
  after-state. Anything else fails closed and keeps every version. Unreadable
  or malformed journals are retained rather than silently discarded.
- Live promotion and all startup/project-open recovery calls share one
  process-wide asynchronous transaction mutex. Recovery cannot consume a
  live `applying` journal, and concurrent recovery calls serialize.
- Live rollback restore temps are exclusive, journaled before creation,
  checked first as planned names and then as complete created leaf identities
  (type, inode, hash/mode or target). Live cleanup removes only the exact
  creation-bound leaf; occupied planned names and ABA replacements remain
  conflicts. Startup recovery never removes a rollback temp. The Pi
  session temp is synced before rename and its install directory is synced;
  core session bundle files and directory entries are likewise durable
  before the journal advances to `done`.
- Recovery receives the canonical primary plus engine-specific Pi/core
  session roots from the project owner independently of journal contents,
  but it does not use a journal-supplied path or manifest as deletion
  provenance. Installed Pi/core artifacts, session temps, rollback temps,
  and journals are always retained at startup, including complete
  valid-shaped manifests.
- The promotion-journal root and each operation are bound as non-symlink
  directories by canonical path and device/inode before reads. Because Node
  lacks portable descriptor-relative child mutation on the supported
  macOS/Linux runtimes, recovery performs no marker writes, journal rewrites,
  or cleanup mutations in a journal-selected directory. A final
  check-to-rename interval remains for restoring a verified before-state into
  the trusted primary root; it is revalidated immediately before rename and
  any uncertainty is retained for a later recovery rather than being claimed
  as ABA-proof.

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
- The comparison tears down with the `promoted` state; its live, freshly
  created journal is removed after the terminal opens. Startup recovery never
  removes an extant journal.

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
- `scripts/worldline-recovery-test.mjs` — 34/34: prepared/applying/applied
  rollback, done retention, outside-symlink containment, corrupt journal and
  before-image fail-closed behavior, missing-vs-empty, symlink target and
  executable-mode fidelity, per-journal conflict isolation, and strict
  malformed/duplicate/unsafe schema rejection before the first mutation.
- `npm run spike -- promotion-transaction`: recovery waits behind a live
  applying transaction, while concurrent recovery remains serialized and
  idempotent. `npm run spike -- core-session-promotion` verifies an
  image-bearing core bundle install and complete recovery cleanup.
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
- Initial merged-tree promotion mutations use the descriptor-relative,
  no-follow native exchange/install/retire boundary after exact root, parent,
  and leaf identity/state validation. A same-UID replacement in the final
  kernel interval is reported as a retained conflict rather than silently
  overwritten. Promotion durability currently performs necessary synchronous
  directory fsyncs on the main process and can move off-main in later work.
- Session installation records the nearest trusted pre-existing directory
  before recursive creation and syncs every new directory entry back through
  that root before the durable `done` transition.
