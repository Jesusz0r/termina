# Phase 0 — Proven primitives (Worldlines Release 1)

> **Status:** complete — all four spikes green (71/71 checks).
>
> This is the recorded evidence for the Phase 0 gate (WORLDLINES §7). It
> proves or rejects the risky primitives before any UI work starts. The
> spikes are disposable; the durable module they exercise,
> `electron/worldline-git.ts`, moves into Phase 2.

## How to re-run

```sh
npm run spike capture
npm run spike merge
npm run spike session-fork
npm run spike platform
```

The runner (`scripts/spike.mjs`) bundles each spike with esbuild and executes
it under plain Node. Each spike exits non-zero when any check fails.

## Results (macOS 26.5.2, arm64, Git 2.53.0, Node 24)

| Spike | Checks | Result |
|---|---|---|
| `capture` | 20/20 | byte-exact working-tree capture |
| `merge` | 17/17 | three-way merge semantics |
| `session-fork` | 19/19 | Pi session branching + forkFrom |
| `platform` | 15/15 | sandbox, CoW clone, watcher, disk |

## What is proven

### 1. App-owned snapshot store (capture spike)

- Working-tree bytes captured byte-for-byte across staged, unstaged,
  untracked, binary, executable, symlink, renamed, and deleted files.
- Ignored files (`.gitignore`) excluded from the capture domain.
- The user's Git repository is never touched: HEAD, `git status`, index
  bytes, refs, and object count are identical before and after capture.
- Materialization round-trips bytes, modes, and symlinks exactly
  (blobs are read raw with `git cat-file --batch`; no filters run).
- Identical blobs deduplicate to one object (content-addressed store).
- Unborn HEAD works (empty base tree).
- Preflight rejects `core.autocrlf=true`, transform-bearing
  `.gitattributes` (filter/eol/working-tree-encoding/ident/text), and
  submodules, each with a stable reason string.
- Path, per-file byte, and new-blob byte budgets abort the capture.
- A file changed during its read aborts the capture (fstat before/after +
  path identity check).

Implementation notes:

- Trees are built through a temporary index (`update-index --index-info` +
  `write-tree`) in the store. `git mktree` rejects paths with slashes and
  cannot build nested trees; the index path is the documented approach.
- `git rev-parse --show-toplevel` returns canonical paths
  (`/private/var/...`). Preflight compares canonical forms.
- Git runs as argument arrays with a fixed C locale, disabled hooks,
  pagers, prompts, optional locks, and user/system config.

### 2. Three-way merge (merge spike)

- `git merge-tree --write-tree --name-only -z --no-messages` with a
  store-local commit graph gives the promotion semantics: the merge base
  is the root primary state R when every state chains from R.
- Clean merges preserve unrelated concurrent primary edits (disjoint line
  edits to one file, disjoint additions, deletions, binary takeover).
- Text, binary, file-vs-symlink, file-directory, and rename conflicts are
  detected with the conflicted path names; exit code 1 with no tree.
- No merge operation writes to the working tree, index, refs, or HEAD of
  the user's repository.
- The merged tree materializes byte-for-byte with the same raw-blob path
  used for candidates.
- Rename + edit either merges cleanly with both sides kept, or reports a
  conflict — never a silent wrong result.

### 3. Pi session forking (session-fork spike)

- The doc's flow works: copy the source session file to an app-private
  workspace, open the copy, verify the entry chain, extract a path with
  `createBranchedSession`, then `SessionManager.forkFrom` into an
  app-owned candidate session directory.
- The branched session contains only the path root→entry and its leaf is
  the selected entry.
- The forked candidate session has the candidate cwd, the candidate
  session dir, a file inside that dir (not the source), the same branch,
  and appends after the branch point.
- `createBranchedSession` mutates the manager's index — open a fresh copy
  per candidate.
- Branching at the root entry writes no file (pi refuses). This is the
  doc's root-prompt case: create an empty candidate session and prefill
  the prompt through the bridge control (WORLDLINES §6.5).
- The source session file is untouched by forking.

### 4. Platform capabilities (platform spike)

- `sandbox-exec` exists and enforces on macOS 26: a deny-list profile
  `(allow default)` + `(deny file-write* (subpath ...))` blocks writes to
  protected paths while allowing candidate paths. Children and
  grandchildren inherit the boundary. Profile paths must be canonical
  (`/private/var/...`, not `/var/...`).
- `cp -c` provides copy-on-write directory clones: separate inodes,
  mutating the clone leaves the source intact.
- The recursive watcher reports nested writes (`fs.watch` recursive).
- Free disk space is reported correctly on macOS (df header is
  "Available", not "Avail").

## Known limits recorded for later phases

- `git mktree` cannot build nested trees; use the temp-index path.
- `createBranchedSession` mutates the manager; re-open per branch.
- Root-only session branches are refused by pi; the empty-candidate path
  is the designed fallback.
- Type and file-directory conflict reports include a synthetic
  `path~<oid>` second name; the real path is always present first.
- Per-file `git hash-object -w` spawns dominate capture time on large
  repositories. Initial-capture latency must be measured on a large
  fixture before Phase 2 locks the budget. A batched blob writer is the
  planned optimization.

## Gate status

Phase 0 gate (WORLDLINES §7): source capture is byte-exact ✓, isolation
is enforced (sandbox boundary proven) ✓, cleanup is implemented (store
destroy + spike temp-dir removal) ✓. Latency targets are not yet measured
on medium/large fixtures — that measurement lands with the capture worker
in Phase 2, where the budget table of §9 is enforced.
