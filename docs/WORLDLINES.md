# Worldlines — Executable Timeline plan

> **Status:** implemented and maintained
>
> **Product promise:** Fork a recorded agent moment into isolated, runnable
> projects with matching Pi conversations. Compare the futures with measured
> evidence, then promote one without losing the others.

## 1. Product invariants

A fork point is valid only when Termina has both:

1. the exact persisted Pi session entry for that point; and
2. the exact captured project source state for that point.

In this document, **exact source state** means the path, file type, bytes,
symlink target, and executable bit for every captured file. The capture domain
is all Git-tracked files and non-ignored untracked files under the opened Git
root. It does not include ignored runtime data, the user's staging metadata,
empty directories, hard-link topology, timestamps, ownership, access control
lists, extended attributes, process memory, databases, or remote services.

Termina must never show a point as forkable when either half is missing or a
capture changed while it was in progress. Every visible Release 2 timeline dot
must be forkable. Evict the dot and its source state together.

Candidate processes must not be able to write to the primary project or the
user's real home directory. Disable Worldlines when Termina cannot establish
an operating-system write boundary. A detached directory alone is not an
isolation boundary.

Every comparison must use candidates derived from the same base source state.
Every evidence result must name the exact candidate source state that it tested.
A later source change makes that evidence stale.

Promotion is the only operation that can write candidate changes to the primary
project. Promotion must be recoverable after a process or application crash.

## 2. Build it in three releases

### Release 1 — Fork Run

Fork a completed run into two isolated candidates:

- **Candidate A — Reference:** the original run's settled source state and
  settled Pi session.
- **Candidate B — Alternative:** the run-start source state and the Pi session
  immediately before the original effective prompt.

For a text-only prompt, Termina puts the effective prompt in Candidate B's Pi
editor without submitting it. The user can change it or submit it unchanged.
For a structured prompt with images, Release 1 offers **Run unchanged** and
preserves the original content blocks. It does not pretend that the TUI can edit
image attachments.

Both candidates live outside the primary project and have independent Git
metadata, process groups, homes, temporary directories, Pi sessions, watchers,
and runtime copies. Candidate A preserves the original implementation even if
the primary project changes later. Candidate B provides a clean alternate
future from the shared base.

Compare:

- Verify results;
- changed files;
- insertions and deletions;
- dependency changes;
- per-file base-to-A, base-to-B, and A-to-B diffs; and
- merge conflicts against the current primary project.

Promote either candidate with a three-way merge. Discarding a comparison removes
both candidates and all app-owned resources.

### Release 2 — Fork Any Moment

Make every visible timeline event a real fork point:

- persist incremental content-addressed file blobs;
- persist an immutable source state for each event;
- link each event to its exact persisted Pi session entry;
- materialize any selected event as a runnable candidate; and
- continue a new future from that event.

Release 2 changes timeline semantics. Publish dots only for stable action
boundaries with both a Pi entry and a source state. Transient tool starts still
drive live auto-open and ownership attribution, but they do not create dots.
Parallel sibling tools become one stable batch event. Disk writes during a Bash
command become forkable only after the matching tool result is persisted and
the filesystem becomes quiet.

If capture times out, detects another writer, exceeds a budget, or cannot
reconcile the disk, do not publish the dot. Show recorder status separately.
This keeps the rule truthful: if the user can see a dot, the user can fork it.

### Release 3 — Challenge Mode

Add one-click adversarial alternatives. A completed eligible run or candidate
shows four direct actions:

- **Fewer dependencies**
- **Preserve API**
- **Simpler implementation**
- **Performance-first**

One click creates a sibling candidate from the same base, injects the selected
constraint, submits the original effective task, and runs the same captured
provider, model, and thinking level by default. Termina then runs a deterministic evidence
contract created before the challenger starts.

Do not ask a model to choose the winner. Rank only with measured evidence:

1. Disqualify candidates with missing, stale, modified, or failed required
   checks.
2. Disqualify candidates that violate the selected hard constraint.
3. Compare the remaining candidates with the profile's declared metric.
4. Report a tie when the measurement is equal, noisy, unsupported, or
   inconclusive.

Never hide multiple measurements behind an opaque weighted score. Label the
result as an **evidence winner**, not as proof that an implementation is
correct or objectively better.

## 3. Release 1 user journey

1. Run one agent in the primary project.
2. Select its completed run in the timeline.
3. Click **Fork Run**.
4. Termina creates Candidate A from the settled run and Candidate B from the
   run start.
5. Two real Pi terminals open in two isolated candidates.
6. Candidate B receives the original effective prompt through the app bridge.
7. Run Verify in both candidates.
8. Compare evidence and diffs.
9. Click **Promote** on the preferred candidate.
10. Termina performs a three-way merge against the current primary project.

The 60-second demo records the primary state immediately before step 3 and shows
that candidate creation and work do not change primary source, Git index, Git
refs, or real home before step 9.

## 4. Scope and support preflight

### Release 1 scope

- Support normal Git working repositories with Git 2.38 or newer.
- Require the opened folder to equal the Git top-level directory.
- Support an unborn repository by using an empty base tree.
- Fork completed, persisted, replayable runs at run boundaries.
- Create Candidate A and Candidate B as an all-or-nothing pair.
- Keep at most three live worldlines.
- Keep live worldlines local and temporary.
- Promote clean three-way merges.
- Detect conflicts before writing any primary file.
- Run Verify inside each candidate's isolation boundary.
- Capture working-tree bytes for tracked, staged, unstaged, and non-ignored
  untracked files. Do not copy the user's staged-versus-unstaged index state.

### Release 2 scope

- Record every stable source-changing action as a coupled session/source state.
- Store changed file content once by hash.
- Support regular files, symlinks, create, modify, rename, delete, and executable
  bit changes.
- Fork from any visible timeline dot.
- Keep recording bounded by event count and new-blob byte budget.
- Permit a worldline to become a parent only after Release 1 cleanup and
  attribution are proven.

### Release 3 scope

- Launch one challenger at a time.
- Include the four fixed challenge profiles.
- Reuse the effective original task without requiring copy and paste.
- Build an immutable evidence contract before the challenger starts.
- Show eligibility, constraint results, raw measurements, freshness, and
  ranking reasons.
- Disable a profile when Termina cannot measure its required evidence.

### Preflight failures

Disable Worldlines and show one precise reason when any required condition
fails. Do not add a weaker fallback.

- Git is older than the minimum version proven for `merge-tree`.
- The opened folder is not the Git top-level directory or is inside the
  app-owned worlds root.
- The repository has unresolved index entries or an active merge, rebase,
  cherry-pick, or revert.
- The project contains a submodule or nested Git repository in the capture
  domain.
- Sparse checkout, a partial/promisor clone, or a source-object alternate is
  active.
- A captured path is a socket, device, first-in-first-out file, or another
  unsupported file type.
- Git clean/smudge filters, Git Large File Storage filters,
  `working-tree-encoding`, `eol` attributes, a non-false `core.autocrlf`, or
  another content-transforming setting prevents byte-exact materialization.
- The platform cannot provide a reliable recursive source watcher and quiet
  window signal.
- The platform cannot create copy-on-write directory clones.
- The platform cannot enforce filesystem writes, process signaling, inherited
  descriptors, and child-process containment for the required sandbox.
- Available disk space is below the pair-creation reserve.
- The running Pi binary does not exactly match Termina's pinned Pi package.

Phase 0 can remove a restriction only after a byte-exact, isolation, cleanup,
and performance test proves support. Do not add compatibility branches based on
assumptions.

### Not included in these releases

- Non-Git source storage.
- Windows support before a proven filesystem sandbox and copy-on-write clone
  exist.
- Cloud workers or remote sandboxes.
- Full virtual-machine isolation.
- Automatic dependency installation.
- Persistent live candidates after the project closes.
- Model-generated winner selection.
- Promotion conflict resolution inside Monaco.
- Automatic replay of steering messages, follow-ups, or manual mid-run edits.
- Claims that local process isolation also isolates databases, cloud accounts,
  remote APIs, deployed services, or other external side effects.

## 5. Validation questions and decisions

### What exactly can be reconstructed?

Termina reconstructs the captured source domain and the persisted Pi session
branch. It does not claim to reconstruct ignored caches, operating-system state,
shell state, clocks, random seeds, services, or network responses. The UI must
say **source state** instead of the broader **workspace state**.

### Can a candidate modify the primary project through an absolute path or a symlink?

Not when Worldlines is enabled. Run the whole candidate Pi process, its built-in
file tools, custom extensions, Bash children, Verify workers, and descendants
inside an operating-system policy that allows writes only to candidate-owned
paths. Also reject file-tool paths that resolve outside the candidate root,
close all unnecessary inherited descriptors, and block signals or process
inspection outside the candidate process group. Disable Worldlines if the
sandbox does not initialize. A prompt telling the agent not to write outside
the candidate is not enforcement.

### Does capture modify the user's Git repository?

No. Store blobs, trees, commits, indexes, and refs in an app-owned bare snapshot
repository. Give that repository read-only access to source Git objects through
an alternate object directory. Do not write objects, refs, indexes, worktree
records, locks, or hooks into the user's Git directory.

### Do agent commits, branches, and staged state travel with a fork?

No. Worldlines captures source bytes, file types, and executable modes, not the
mutable Git index or ref topology. Each candidate starts at an app-created
synthetic commit with independent local refs. Promotion transfers source
changes, not commits, tags, reflogs, stashes, bisect state, or staging state.
Show this boundary in comparison details. Disable Worldlines for a task whose
required output is Git-history manipulation rather than source changes.

### Which base does a nested worldline use?

Use two explicit bases. The comparison base is the immediate pre-task state used
to compare siblings. The promotion base is the root primary state from which the
lineage began. Every descendant inherits the root promotion base unchanged, so
promoting a nested candidate includes all ancestor source changes.

### Can a watcher miss a Bash write?

Yes. Treat watcher paths as a fast hint only. At every stable boundary, run an
authoritative Git-index reconciliation in a worker process. Compare a workspace
generation before and after capture, require a short quiet window, and retry
once. If another change occurs, do not publish the point.

### What happens to unsaved Monaco edits?

Track dirty models explicitly. Keep models read-only while their workspace agent
writes. Before a start checkpoint or promotion, acquire a workspace write lease
and ask the renderer to save all dirty models. Abort the operation if save
fails, the renderer does not acknowledge, or a model changes during capture. If
an external write reaches a dirty idle model, show a save conflict instead of
replacing the model. Never overwrite an unsaved model silently.

### What happens when two agents write the same primary workspace?

Record overlapping writer leases and mark both runs ineligible for Fork Run.
Release 1 requires one app-controlled writer from start through settle. A user
or external edit during the run does not corrupt capture, but marks the run as
collaborative and disables automatic Challenge ranking because those actions
cannot be replayed fairly.

### Can the original prompt be replayed exactly?

Capture the effective prompt and image content from `before_agent_start`, after
skill and prompt-template expansion. Capture the one-shot Termina context that
the bridge injected. Store both in app-private files, not renderer state.
Text-only Fork Run prompts can be edited in Pi. Structured prompts can run
unchanged. Steering messages and follow-ups make Release 1 replay ineligible.

Dynamic system-prompt changes from unrelated extensions are outside the
persisted-session boundary. State this limitation in comparison details; do not
claim that the model request itself was reproduced byte-for-byte.

### What happens to the selected conversation after promotion?

Promote the selected Pi branch with the source. Before primary writes begin,
create a self-contained target session for the primary cwd from the candidate's
current leaf. After source apply succeeds, install that session in the primary
Pi session directory and open a new primary terminal on it. If the original
primary terminal now represents another future, mark it out of date and inject
a source-change notice before its next run. Do not discard the only matching
conversation after promoting its source.

### Can a Pi session fork use a different Pi version?

No. Launch the Pi binary shipped with the same pinned
`@earendil-works/pi-coding-agent` package used by the session worker. A custom
`TERMINA_PI_BIN` disables Worldlines unless its exact version matches. Do not
maintain a session-format compatibility layer.

### Will candidate project extensions trigger a new trust prompt or run unreviewed code?

Load the Termina bridge as an app-owned CLI extension. It is available before
project trust. Inherit project trust for one process only when the source Pi
session was trusted and every trust-sensitive project resource still matches
the trusted base hash. Never persist candidate paths in `trust.json`. If a run
changed trust-sensitive project resources or resolved Pi user resources, require
explicit review and do not auto-launch Challenge Mode.

### Are ignored dependencies fair and isolated?

Create one runtime template at comparison start, then copy-on-write clone that
same template into A and B. Copy only a fixed detected allowlist such as
`node_modules`, `.venv`, and required local environment files. Preserve modes
and reject sockets or escaping write targets. Resolve runtime and Pi-resource
symlinks that read from an external package store into the template, or disable
the feature when they cannot be isolated. Do not leave read-through links into
real home or primary runtime directories. The sandbox blocks writes through
absolute symlinks into primary or shared stores.

Validate that cloned runtime tools resolve inside the candidate. Virtual
environments or package layouts with non-relocatable absolute prefixes make
candidate Verify unavailable; do not rewrite them heuristically.

Keep dependency and environment inputs read-only, reset writable outputs before
evidence, and validate runtime fingerprints. Ignored runtime data is current at
comparison creation, not historical. Show that fact in comparison details. Do
not use ignored runtime content as source diff or promotion input.

### Can an agent game Verify or a benchmark?

Build the evidence contract from the shared base before starting a challenger.
A project adapter must separate immutable evaluation assets from the mutable
implementation surface. Hash the required command, configuration, discovered
test and benchmark roots, and dependencies that remain inside the evaluation
asset set. Imports from the harness into the declared implementation surface
stay mutable. A candidate that changes an immutable evaluation asset is
ineligible for ranking. If Termina cannot make that separation or bound the
asset set, ranking is unavailable. Added tests can appear as candidate changes,
but they do not replace the immutable required checks.

### Can a noisy benchmark produce a false winner?

Run candidates serially in equivalent isolated environments. Interleave A and B
samples after warm-up, record raw samples, and require both a predefined effect
threshold and an acceptable variability bound. Otherwise report a tie. Never
use model claims or unrelated build duration.

### What happens if promotion crashes after writing one file?

Write a durable promotion journal before the first primary write. The journal
contains the pre-promotion source state, staged output paths, staged session,
operation id, and phase. On startup, restore only app-written values that still
match journal hashes. Report a recovery conflict instead of overwriting a path
changed externally after the crash. Do not rely only on in-memory rollback.

### What happens when recording reaches a cap?

Stop creating new source states and dots. Keep the terminal running, mark its
head unrecorded, and show **recording paused**. Disable comparison evidence and
promotion until a full valid capture catches up. Evict old unpinned dots and
their states together. A state used by a live candidate, comparison, Verify
result, or promotion journal stays pinned.

### Can child processes survive discard?

Launch every candidate in its own sandbox and process group. On discard, stop
new work, send terminate to the group, wait for a bounded interval, send kill,
stop watchers, close sidecars, remove candidate files, and then remove snapshot
pins. Make cleanup idempotent and retry stale app-owned resources on startup.

### Are external side effects isolated?

Not completely. Deny network by default except the active model provider. A
one-run explicit grant can allow a required domain. Worldlines must warn that
commands can still affect an allowed remote service. Never present filesystem
isolation as a full security sandbox for external systems.

## 6. Core architecture

### 6.1 Terms and state

Add these terms to `AGENTS.md` when implementation starts:

- **Fork point:** one visible timeline event coupled to a Pi session entry and
  immutable source state.
- **Worldline:** one isolated candidate source tree and matching Pi session.
- **Candidate:** a worldline that participates in one comparison.
- **Reference:** Candidate A, which preserves the original future.
- **Alternative:** Candidate B, which starts from the shared base.
- **Challenge:** an automatically launched alternative with one fixed
  constraint profile.
- **Evidence contract:** immutable deterministic checks and measurements used
  to compare candidates.
- **Write lease:** main-process ownership that prevents two app-controlled
  writers from changing one source tree during a critical operation.

Use direct state objects. Do not create a generic workflow framework.

```ts
interface WorkspaceState {
  id: string;
  root: string;
  primary: boolean;
  generation: number;
  writerId: string | null;
  watcher: ProjectWatcher;
  terminalIds: Set<string>;
}

interface RunRecord {
  id: string;
  workspaceId: string;
  sourceTerminalId: string;
  startStateId: string;
  settledStateId: string;
  promptParentEntryId: string | null;
  promptEntryId: string;
  settledEntryId: string;
  replayable: boolean;
  collaborative: boolean;
  reason?: string;
}

interface WorldlineSummary {
  id: string;
  comparisonId: string;
  workspaceId: string;
  label: "A" | "B";
  role: "reference" | "alternative" | "challenge";
  parentWorldlineId?: string;
  comparisonBaseStateId: string | null;
  promotionBaseStateId: string | null;
  headStateId: string | null;
  sourceRunId: string;
  terminalId?: string;
  version: number;
  state:
    | "creating"
    | "ready"
    | "running"
    | "settled"
    | "verifying"
    | "promoting"
    | "conflict"
    | "cancelled"
    | "error"
    | "discarding"
    | "discarded"
    | "promoted";
  challengeProfile?: ChallengeProfile;
  verify: VerifyInfo;
}

type ChallengeProfile = "fewer-dependencies" | "preserve-api" | "simpler" | "performance";
```

Main owns all state transitions. Async completions carry an operation id and the
expected object version. Ignore a completion after cancel, discard, folder
switch, head change, or a newer operation. Mutating IPC requests include the
expected version and expected head source state.

### 6.2 Workspace identity and write leases

Replace global project assumptions with explicit workspaces.

Every agent terminal, shell, dispatch worker, Verify worker, and editor file
operation receives a `workspaceId`. Dispatch and Verify inherit the owner
terminal's workspace. Path resolution, baselines, user edits, Mine paths, test
selection, explorer operations, and watcher attribution use that workspace.

Represent Mine files as paths relative to the Git root. Map the same relative
path into each candidate. Enforce the current primary Mine set during
promotion, not only the set captured at fork time.

Use a workspace write lease for checkpoint capture, promotion, candidate
materialization, and deterministic evidence runs. A lease:

- blocks new app-controlled agent starts and saves for that workspace;
- waits for dirty-model flush when required;
- records the watcher generation;
- aborts when another controlled writer is active; and
- releases in `finally` on success, error, cancellation, and shutdown.

External processes cannot be locked reliably. Reconcile and compare generations
to detect them. If the primary root disappears, unmounts, or resolves to a new
repository identity, mark comparisons detached and disable promotion. Re-enable
only after the same canonical repository identity returns.

### 6.3 App bridge and coupled timeline events

Move the generated Termina bridge out of project `.pi/extensions`. Keep one
app-owned bridge file and pass it with Pi's CLI extension option for primary and
candidate terminals. This removes the generated bridge from source capture and
makes bridge startup independent of project trust.

Extend bridge events with:

- session file and session id;
- current and parent entry ids;
- tool call id and sibling batch id where applicable;
- run id;
- effective prompt entry id;
- source terminal and workspace ids;
- random bridge-instance id;
- monotonic event sequence within that bridge instance; and
- random checkpoint request id.

Use app-private directories with mode `0700` and files with mode `0600`. Consume
control requests exactly once. Treat sidecar records as untrusted hints: verify
the claimed session file, entry id, parent chain, role, active branch, terminal,
workspace, bridge instance, run, sequence, and operation id in a worker before
publishing a fork point. Resolve session files only inside the registered
primary or candidate session directory; never open an arbitrary sidecar path.
Accept a sequence reset only after an explicit `session_start` or bridge reload
introduces a new instance id.

A run start uses three Pi hooks. `input` can stop submission when save fails,
`before_agent_start` sees the effective expanded prompt and injects context, and
`agent_start` exposes the persisted run state:

1. For an idle initial message, the bridge `input` handler requests start
   preflight and waits.
2. Main acquires the workspace write lease and flushes dirty editor models.
3. If save or acknowledgement fails, the bridge stores a one-use recovery
   draft, returns `handled`, restores the editable text when possible, notifies
   the user, and does not start the agent.
4. Main regenerates user-edit context and captures the start source state.
5. Main returns a one-use preflight token, and `input` continues.
6. In `before_agent_start`, the bridge captures the effective expanded prompt
   and images, then reads and injects the final one-shot context.
7. In `agent_start`, the bridge reports the persisted prompt and leaf entry ids
   with the preflight token.
8. Main verifies that generation did not change, couples the entry to the
   captured source state, consumes the token, and releases the lease.

A run that reaches `before_agent_start` without a valid preflight token can
continue normally but is not eligible for Fork Run. The token creates one
high-level run id. Consume it on the first `agent_start`; later low-level
`agent_start` events caused by retry or compaction stay in that run and do not
reset its base. `agent_settled` closes the run.

Other stable boundaries use one checkpoint request:

1. The bridge emits the request and waits up to the budget.
2. Main acquires the workspace write lease.
3. The snapshot worker reconciles watcher hints against the temporary index.
4. Main waits for a short watcher quiet window.
5. Main accepts the state only when the workspace generation is unchanged.
6. Main writes an atomic acknowledgement and releases the lease.
7. The bridge continues the agent loop.

Release a stranded start lease on cancellation, extension error, terminal exit,
or timeout.

Retry one capture after a concurrent change. On a second mismatch or timeout,
continue the agent without publishing a dot.

Release 1 records run start and settled boundaries. Release 2 records stable
message or turn boundaries:

- one event per sequential mutating tool result;
- one batch event for parallel sibling tools;
- one final-response event when useful;
- buffered unowned changes attached to the next stable boundary; and
- no dot for transient tool starts.

A timeline event contains metadata only:

```ts
interface TimelineEvent {
  seq: number;
  runId: string;
  t: "agent_start" | "agent_settled" | "tool" | "tool_batch" | "change";
  ts: number;
  sessionEntryId: string;
  sourceStateId: string;
  forkable: true;
  primaryRelPath?: string;
  pathCount?: number;
  detailsId?: string;
  toolName?: string;
}
```

Fetch event paths, source content, and diffs by `detailsId` on demand. Do not
send file blobs, Git object ids, session paths, secrets, or patches in timeline
pushes.

### 6.4 App-owned snapshot store

Create one app-owned bare Git repository per opened project session with the
same Git object format as the source repository. The store lives outside the
source repository and is deleted after candidates, journals, and pinned
timeline states are gone.

Give the snapshot store read-only object access to the source repository through
Git alternates. Keep every temporary index, blob, tree, commit, and ref in the
app store. Never create `refs/termina`, objects, index locks, or worktree records
in the user's Git directory.

Run Git as argument arrays without a shell and with a fixed `C` locale. Disable
hooks, templates, filesystem-monitor hooks, external diff and text-conversion
commands, pagers, optional locks, credential prompts, custom merge drivers, and
network access for snapshot and promotion workers. Use NUL-delimited path output
and reject any path that escapes the canonical Git root.

#### Initial source capture

Start initial capture in a worker when the Git root opens. Show **indexing
source** and do not offer recording until it completes. Reuse that indexed state
as the parent for the first run checkpoint; do not rescan and rehash the whole
repository inside `agent_start`.

1. Resolve and pin the canonical Git root, common Git directory, object format,
   `HEAD`, repository exclude file, and global exclude file; use the empty tree
   when `HEAD` is unborn.
2. Initialize a temporary index in the app snapshot store.
3. Read the base tree into that index.
4. Enumerate tracked paths and non-ignored untracked paths with NUL delimiters.
5. Use `lstat` and accept only regular files and symlinks.
6. Open regular files without following symlinks. Compare `fstat` before and
   after hashing, then compare the final path identity with the open file.
   Reject content, mode, device, inode, or path replacement during the read.
7. Read symlink targets without following them and verify the path did not
   change before the index update.
8. Hash raw bytes or symlink targets with filters disabled.
9. Update index entries with explicit modes and blob ids.
10. Remove tracked paths absent from disk.
11. Write an immutable tree and synthetic commit in the app store.
12. Read the tree back and verify every expected entry before acknowledgement.
13. Record an opaque source state id that maps to the commit only in main.

This captures working-tree bytes. It does not copy the user's index stages.

#### Incremental source capture

1. Start with watcher paths as hints.
2. Recheck capture-domain configuration. If an exclude source changed, rebuild
   the index before recording another point.
3. Run an authoritative status comparison between the temporary index and disk.
4. Add every changed, created, deleted, mode-changed, or renamed path to the
   reconciliation set.
5. Hash each final changed file once and update only those index entries.
6. Write a new tree only after generation and quiet-window validation.
7. Reuse the previous tree when no source path changed.
8. Count only newly written app-store blob bytes against the byte budget.

Git blobs provide content-addressed incremental storage. Identical bytes reuse
one object. When no source path changes, reuse the previous `sourceStateId` and
tree while linking the new Pi entry. This keeps valid evidence current across
conversation-only events.

Pin source states used by a visible dot, candidate, comparison, evidence result,
or promotion journal. Eviction removes an unpinned timeline dot, metadata, and
ref as one operation. Reclaim unreachable app-store objects only while no
capture, materialization, evidence run, or promotion uses the store. Never run
maintenance in the user's repository. Delete the whole app snapshot store on
final cleanup.

### 6.5 Fork Run eligibility and pair creation

A run record stores:

- start source state;
- effective prompt content and images;
- app-bridge context injected for the turn;
- prompt entry and its parent;
- source session branch snapshot;
- selected model and thinking level;
- resolved Pi resource and project-trust hashes;
- settled source state and settled entry;
- interruption and stop reason;
- overlapping writer ids; and
- unowned edit provenance.

Offer Release 1 Fork Run only when:

- the Pi session is persisted;
- start and settled source checkpoints are valid;
- the run settled without interruption or terminal loss and left no live
  mutating descendant process;
- no other agent, Verify worker, promotion, or dispatch worker overlapped the
  same source workspace;
- the run has one initial user prompt and no steering or follow-up user message;
- trust-sensitive project resources and resolved Pi user resources still match
  their captured hashes; and
- the source repository identity still matches.

Manual unowned edits mark the run collaborative. Fork Run can still preserve
and compare the reference, but automatic Challenge ranking is unavailable
because those actions are not replayed.

`Fork Run` creates both candidates concurrently:

- Candidate A receives the settled source state and session at the settled
  entry.
- Candidate B receives the start source state and session at the parent of the
  effective prompt. If the prompt is the root entry, create an empty candidate
  session and restore the captured model and thinking level before replay.
- Text-only Candidate B receives editable text through `ctx.ui.setEditorText`.
- Structured Candidate B receives a one-click unchanged replay through
  `pi.sendUserMessage` with the original content blocks.

Pair creation is all-or-nothing. If either candidate fails, cancel both process
groups, remove both directories and sessions, release all pins, and report one
error. Candidate A and Candidate B use the start source state as their shared
comparison base.

### 6.6 Candidate materialization and isolation

Do not use a linked Git worktree. Its `.git` file points into the primary Git
directory and would let candidate Git commands change primary worktree metadata
or refs.

Create one immutable comparison template:

1. Create an app-private directory outside the Git root but on the same volume
   as the primary project. Fail preflight when Termina cannot create one.
2. Create an independent local Git repository with read-only object alternates
   to the source repository.
3. Fetch the base synthetic commit from the app snapshot store.
4. Check out and validate the base source bytes with hooks and content filters
   disabled.
5. Remove push remotes and write-capable links to the primary repository. Keep
   only a read-only object alternate to the source object directory.
6. Fetch all app-snapshot objects needed by the candidate into its local object
   store, then remove access to the app snapshot store.
7. Copy the fixed runtime allowlist into the template with copy-on-write clones.
8. Create an isolated home, temporary directory, cache directory, Pi session
   directory, and event directory.
9. Copy the resolved Pi settings, model configuration, context files, user
   extensions, skills, prompts, themes, and installed Pi package code used by
   the source session.
   Exclude unrelated sessions, logs, caches, and credentials.
10. Copy only the required Pi authentication material with mode `0600`. Let
    token refresh change only that copy.
11. Make copied Pi resources read-only and disable package auto-install.
12. Start no process in the template.

Copy-on-write clone the complete template into A and B. Each clone gets
independent Git metadata and runtime files. Apply Candidate A's settled source
state after cloning. Candidate B remains at the shared base. Delete the template
only after both candidates validate successfully.

Run candidate Pi, shell, dispatch, Verify, and child processes under one policy:

- allow read and write inside that candidate except paths marked immutable for
  runtime or evidence;
- allow write to its app-owned home, session, event, cache, and temporary paths;
- use only the copied, hashed Pi resources and model credentials;
- deny read of the real home and unrelated secrets such as SSH, cloud, and
  signing credentials;
- allow read-only access only to the source Git object directory, not its refs,
  config, hooks, or worktree metadata;
- deny all access to the app snapshot store after materialization;
- deny every write to the primary project, real home, source Git directory, and
  sibling candidate;
- close nonessential inherited file descriptors;
- deny process inspection and signals outside the candidate process group;
- deny network except the active model provider by default;
- apply bounded memory, CPU time, file-size, process-count, open-file, and
  output limits; and
- keep every descendant in a tracked process group whose supervisor terminates
  the group when the main-process control channel closes.

The file-tool path guard is defense in depth. The operating-system policy is the
actual write boundary. Verify and evidence workers use the same filesystem and
process policy with network fully denied unless the immutable evidence contract
explicitly grants a domain.

Clone ignored project runtime data and resolved Pi resources from one source
into the comparison template so A and B receive identical inputs. Make
dependency directories and local environment inputs read-only inside the
candidate sandbox. Give build output,
temporary data, and caches separate disposable writable paths. Reset those
paths before deterministic evidence runs and validate runtime fingerprints.
Disable ranking when the harness depends on mutable ignored state that Termina
cannot reset or measure.

Record runtime creation time and fingerprints for diagnostics, but never store
ignored content in Git, IPC, source diffs, or promotion.

### 6.7 Pi session fork, prompt delivery, and trust

Pin `@earendil-works/pi-coding-agent` as an application dependency and launch
the Pi binary from that same package. Perform all `SessionManager` work in a
worker process.

Before branching, copy the complete source session file to an app-private
session workspace. Open the copy, verify the requested entry and parent chain,
then:

1. call `createBranchedSession(sessionEntryId)` to extract the selected path;
2. call `SessionManager.forkFrom(extractedSession, candidateRoot,
   candidateSessionDir)`; and
3. start Pi with `--session <candidate-session>` and the app bridge as a CLI
   extension.

Do not create intermediate or candidate sessions under the user's normal Pi
session directory. Delete app-owned session copies with the candidate.

The startup control file contains an operation id and one action:

- prefill text;
- send structured prompt;
- send Challenge prompt; or
- start with no prompt.

The app bridge atomically consumes the control before applying it. Record a
one-shot custom entry so reload cannot submit it twice. Emit `session_ready`
only after the control action succeeds or returns a terminal error. Do not use a
fixed startup delay or raw terminal paste for prompt delivery.

Candidate A receives a hidden relocation note that maps historical absolute
source paths to the candidate cwd. Candidate B receives the captured one-shot
Termina context before its effective prompt. Keep prompt content, images, and
context out of renderer list payloads and delete startup controls after use.

The CLI bridge handles `project_trust` before candidate project resources load.
Use Pi's complete trust-sensitive set: project settings, extensions, skills,
prompts, themes, system prompt files, and project `.agents/skills`.

- inherit one-process trust only when the source session was trusted and the
  candidate's trust-sensitive resources match the approved base hashes;
- do not persist the candidate path;
- preserve an untrusted source session as untrusted; and
- require explicit review when trust-sensitive resources changed.

### 6.8 Verify and immutable evidence

Build the required Verify command from the shared base, not independently from
each candidate. Resolve a package-script alias to its immutable base command
body, preserve its package-runner environment, and record executable arguments
without lossy shell re-quoting. Show when
a candidate changes test configuration, but run the captured base command for
eligibility.

Before an evidence run:

1. require the candidate agent and workers to be idle and suspend remaining
   process-group activity during preflight;
2. flush its dirty editor models;
3. acquire its write lease;
4. capture its source state id;
5. validate all immutable evaluation asset hashes; and
6. start the worker inside the candidate sandbox.

Run required evidence for A and B serially to avoid port, cache, CPU, and
fixture contention. Give both candidates equivalent environment variables, a
fresh evidence home derived from the immutable template, and fresh
candidate-local temporary and cache directories. Do not use agent-modified home
or tool configuration for ranking.

Capture source again after Verify. A result is current only when:

- pre-run and post-run source states are equal;
- the result's source state equals the candidate head;
- required evaluation assets still match the contract;
- the Mine policy version still matches the contract; and
- the command completed without cancellation or timeout.

A tracked source change produced by tests invalidates the result. Ignored output
does not change source state. A candidate can add tests, but added tests do not
replace the required base checks. A Challenge candidate that changes a Mine path
captured by the evidence contract is ineligible for ranking.

Manual promotion may proceed with a clear confirmation when evidence is absent,
stale, or failed. Such a candidate cannot receive an evidence-winner label.
Challenge ranking always requires current passing evidence.

### 6.9 Deterministic comparison and Challenge profiles

Compute comparison details on demand:

- Verify state and freshness;
- changed files, file types, modes, insertions, and deletions;
- dependency declaration changes;
- supported public API manifest changes;
- benchmark samples and variability;
- base-to-A, base-to-B, and A-to-B diffs;
- model and thinking-level differences;
- unowned edit provenance;
- ignored runtime fingerprints;
- ignored or generated candidate writes that promotion will exclude; and
- conflict status against the current primary source.

Reuse Change Review for per-file diffs. Show metadata instead of trying to render
binary or oversized files in Monaco.

Without Challenge Mode, do not rank Fork Run candidates. Starting a Challenge
on a completed run uses its preserved reference as A and the challenger as B.
Starting a Challenge on an existing candidate first snapshots that candidate as
the new reference. The challenger still starts from that candidate's recorded
comparison base and pre-task session anchor, not from the implemented head.
If either anchor is missing, or the candidate head includes additional manual
prompts that Termina cannot replay as one task, Challenge is unavailable. If
another alternative occupies B, require discard confirmation before the
one-click launch can continue. Challenge ranking uses these fixed profiles.

#### Fewer dependencies

Instruction:

- Use the standard library and existing dependencies first.
- Minimize new runtime and development dependencies.

Evidence:

- Parse supported declaration manifests from the immutable base.
- Measure added declarations against the shared base.
- Make the challenger ineligible only when it adds more declarations than the
  reference. Zero additions beats one; equal additions remain eligible.
- Treat lockfile-only churn as a visible change, not automatically as a new
  declaration.
- Reject an external package used by candidate source when it is undeclared,
  even if it happens to exist in the cloned runtime. Disable the profile when
  the project adapter cannot validate external package use.
- Require current Verify evidence.
- Rank eligible candidates by fewer added declarations, then smaller verified
  source footprint.

#### Preserve API

Instruction:

- Preserve the measured public interface.
- Keep internal changes internal.

Evidence:

- Build an API manifest from declared public roots at the shared base.
- Build the same manifest for each candidate.
- Fail on removed or changed measured signatures.
- Require current Verify evidence.
- Start with TypeScript and JavaScript package exports and normalized generated
  declaration signatures.
- Mark routes, commands, wire formats, and documented behavior as unmeasured
  unless a dedicated adapter exists.
- Disable the profile when the relevant API surface cannot be measured.

#### Simpler implementation

Instruction:

- Use the most direct implementation that satisfies the task.
- Avoid unnecessary dependencies, files, layers, and abstractions.

Evidence:

- Require current Verify evidence.
- Compare added dependency declarations, changed source files, and changed
  executable lines in that order.
- Label the result **smallest verified footprint**. Do not claim that footprint
  proves subjective simplicity or maintainability.

#### Performance-first

Instruction:

- Measure the current behavior before changing it.
- Improve the measured target without reducing correctness.
- Do not claim an improvement without benchmark evidence.

Evidence:

- Require current Verify evidence.
- Require an immutable, supported benchmark harness with known units and
  direction.
- Run warm-up, then interleave at least five A and B samples.
- Record raw samples, medians, variability, effect threshold, environment, and
  command hash.
- Declare a winner only when the effect exceeds the threshold and variability
  remains inside the allowed bound.
- Disable the profile when no reliable adapter exists.
- Never use the agent's claim or unrelated build duration.

For all profiles:

1. Missing, stale, failed, or modified required evidence makes a candidate
   ineligible.
2. A captured Mine-path change or hard-constraint violation makes a candidate
   ineligible.
3. Rank eligible candidates only with that profile's declared metric.
4. Equal or inconclusive measurements produce a tie.
5. Show the exact reason for every eligibility and ordering decision.

### 6.10 Promotion and crash recovery

Promotion uses three source states in the app snapshot store:

- `R`: the root primary source state from which the worldline lineage began;
- `W`: the selected candidate head; and
- `P`: the current primary source.

Top-level candidates use the same state for comparison and promotion. A nested
worldline can use an immediate comparison base, but it inherits `R` unchanged
from its root ancestor. This makes promotion include all ancestor changes
instead of treating them as part of the merge base.

Require the candidate agent and workers to be idle. Suspend remaining candidate
process-group activity during head capture, flush dirty models in the candidate
and primary, acquire both write leases, capture `W` and `P`, and verify expected
versions before merge.

Run a built-in three-way merge with `R` as merge base. Reject promotion when:

- the merge has text, binary, file-directory, rename, type, mode, symlink, or
  case-folding conflicts;
- a custom merge driver would be required;
- the candidate changes a current Mine path or aliases one through a symlink;
- repository identity changed;
- primary or candidate generation changed after preflight; or
- a required source state is missing.

Evidence freshness is a ranking requirement, not a hard manual-promotion
requirement. Ask for explicit confirmation before promoting absent, stale, or
failed evidence. Also warn when the candidate has ignored or generated writes
that promotion will exclude; require the user to unignore a required source
file before promotion.

For a clean merge:

1. Materialize every output path, type, mode, symlink, and deletion into an
   app-private staging directory.
2. Validate canonical destinations and use an intermediate name for case-only
   renames.
3. Create a self-contained promoted Pi session from the candidate's current
   leaf with the primary cwd. Append one hidden relocation message that maps
   candidate paths back to primary paths. Keep the session staged outside the
   normal session picker.
4. Write and sync a durable promotion journal containing operation id, `P`,
   output paths, staged session path, and phase.
5. Recheck primary generation and expected `P`.
6. Apply staged outputs with atomic per-path renames.
7. Install the promoted session atomically in the primary Pi session directory.
8. Update and sync the journal after each phase.
9. Roll back source and remove the staged or installed promoted session on a
   handled failure.
10. On startup, compare every journaled path with its recorded before and after
    hashes before recovery. Restore a path only when it still equals an
    app-written value. If an external process changed it after the crash, keep
    all versions, stop automatic recovery, and show a recovery conflict.
11. Recover or roll back the remaining journal before starting the primary
    watcher.
12. Attribute resulting watcher events to promotion.
13. Mark older primary agent terminals out of date and write their one-shot
    source-change context before releasing the primary write lease.
14. Open the result in primary Change Review and open a new primary terminal on
    the promoted Pi session.

Promotion must not stage files, move the user's branch, write user Git refs, or
run project hooks. Writing the self-contained selected Pi session to the normal
primary session directory is part of the explicit promotion.

### 6.11 Lifecycle and cleanup

Closing a terminal does not silently discard its candidate. It stops that
terminal and leaves the candidate recoverable during the current app session.
The candidate card can reopen Pi with the same candidate session. Discard is a
comparison action.

Before project switch or normal app quit, ask for confirmation when a candidate
has source changes or session activity beyond its initial fork entry. Live
candidates are intentionally not persistent. A confirmed close discards them.
After a crash, recover any promotion journal first, then remove stale candidate
processes, directories, sessions, controls,
snapshot stores, and metadata.

Cleanup order:

1. mark the comparison discarding and reject new operations;
2. cancel pending checkpoints, Verify, benchmarks, and session workers;
3. terminate and then kill candidate process groups;
4. stop watchers and sidecar readers;
5. close editor models that point into candidate roots;
6. remove candidate homes, sessions, runtime files, and repositories;
7. release source-state pins;
8. remove the app snapshot store when no journal or candidate uses it; and
9. push one final removal event.

Every cleanup step is idempotent. Keep a small app-owned cleanup manifest with
world id, process-group id, supervisor start identity, and owned paths so the
next launch can retry after a crash. Verify process identity before signaling a
stale id; never kill a reused process id. Delete only canonical descendants of
the configured worlds root that contain the matching app-owned marker; never
trust a manifest path by itself. Quarantine the candidate directory and report
cleanup failure when identity is uncertain.

## 7. Delivery sequence

Each phase must typecheck, build, and keep every applicable suite green before
the next phase starts.

### Phase 0 — prove or reject risky primitives

Build disposable command-line spikes and remove them after recording results.

- Create the app-owned bare snapshot store without changing user objects, refs,
  indexes, hooks, or status.
- Capture dirty, staged, unstaged, untracked, executable, binary, and symlink
  source bytes.
- Confirm content-transforming attributes fail preflight.
- Support an unborn `HEAD` with an empty base tree.
- Reconcile a write deliberately hidden from the watcher.
- Detect a source change during capture and withhold the point.
- Build one comparison template and copy-on-write clone it into A and B.
- Confirm A and B have independent Git metadata and runtime files.
- Prove that absolute paths, symlinks, Bash, custom file tools, Verify, and child
  processes cannot write primary or real-home files.
- Prove candidates cannot signal, inspect, or inherit writable descriptors for
  primary and main-process resources.
- Prove process-group cleanup kills grandchildren.
- Prove each chosen Pi lifecycle hook observes the expected persisted
  `SessionManager` entry and map retry, compaction, queued follow-up, and settled
  events to one high-level Run correctly.
- Fork copied Pi sessions into app-owned candidate session directories.
- Prefill text and send structured prompts through the CLI bridge exactly once.
- Test temporary project trust and changed trust-sensitive resources.
- Test clean, binary, mode, symlink, rename, file-directory, and conflicted
  merges without running hooks or custom drivers.
- Simulate a crash during promotion and recover from the journal.
- Measure capture, pair creation, sandbox startup, and cleanup on small, medium,
  and large repositories.

**Gate:** Do not start UI work unless source capture is byte-exact, isolation is
enforced, cleanup is complete, and measured latency fits section 9.

### Phase 1 — make workspaces and Pi ownership first-class

Files expected to change:

- `package.json`
- `shared/types.ts`
- `electron/main.ts`
- `electron/pty-terminal.ts`
- `electron/watcher.ts`
- `electron/preload.ts`
- `src/main.ts`
- `src/editor.ts`
- `src/components/explorer.ts`
- `AGENTS.md`

Work:

- Launch the pinned app Pi binary.
- Move the bridge to an app-owned CLI extension.
- Remove the old project bridge when it has Termina's generated marker. Never
  delete a user-owned file that only shares the name.
- Add workspace ids, generations, versions, and write leases.
- Replace global path helpers with workspace-root helpers.
- Track and flush dirty Monaco models, enforce busy read-only state, and show a
  conflict instead of replacing a dirty model after an external write.
- Keep one watcher and user-edit state per workspace.
- Make Verify and Dispatch inherit the owner's workspace and sandbox policy.
- Switch the explorer root when the active terminal belongs to a candidate.
- Add the Worldlines terms to the glossary.

**Acceptance:** Primary-only behavior remains green, and no generated bridge
file appears in the opened project.

### Phase 2 — record exact run boundaries

Files expected to change:

- app bridge source
- `electron/sidecar.ts`
- `electron/watcher.ts`
- `shared/types.ts`
- new `electron/worldline-git.ts`
- new snapshot worker entry

Work:

- Add run, session, prompt, entry, sequence, and request metadata.
- Add three-hook run-start preflight plus checkpoint request and atomic
  acknowledgement handling.
- Make sidecar delivery event-driven with polling recovery.
- Build the app-owned snapshot store and authoritative reconciliation.
- Capture start and settled source states outside the main thread.
- Record run eligibility, overlap, interruption, trust, and unowned edits.
- Copy the required source session branch into app-private storage.
- Enforce event and blob budgets.

**Acceptance:** Every run offered by Fork Run reconstructs start and settled
source bytes and session branches exactly inside the declared boundary.

### Phase 3 — create the isolated Fork Run pair

Files expected to change:

- new `electron/worldlines.ts`
- new session worker entry
- new sandbox launcher
- `electron/main.ts`
- `electron/pty-terminal.ts`
- `electron/preload.ts`
- `shared/types.ts`
- `scripts/build.mjs`
- `scripts/dev.mjs`

Work:

- Add `worldline:fork-run`, list, cancel, and discard IPC.
- Create the base comparison template.
- Copy-on-write clone Candidate A and Candidate B.
- Apply settled source and session to A.
- Apply base source and pre-prompt session to B.
- Deliver text or structured prompts through one-shot bridge controls.
- Launch both Pi terminals inside independent sandboxes and process groups.
- Treat pair creation as all-or-nothing.
- Clean every partial resource on failure or cancellation.

**Acceptance:** Candidate, sibling, primary, real home, and user Git metadata
remain isolated from candidate writes.

### Phase 4 — ship comparison and Verify

Files expected to change:

- new `src/worldlines.ts`
- `src/timeline.ts`
- `src/main.ts`
- `src/index.html`
- `src/styles.css`
- `src/review.ts`

Work:

- Let an eligible completed run enable **Fork Run**.
- Show an exact ineligibility reason otherwise.
- Add A/B badges to terminal and editor tabs.
- Add candidate cards with lifecycle, model, Verify, source count, reopen, and
  actions.
- Show source statistics, provenance, runtime age, and dependency changes on
  demand.
- Reuse Change Review for base comparisons and add A-to-B comparison.
- Keep DOM updates incremental.

**Acceptance:** Both candidates can Verify and compare without primary writes.

### Phase 5 — promote, recover, or discard

Files expected to change:

- `electron/worldline-git.ts`
- `electron/worldlines.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `shared/types.ts`
- `src/worldlines.ts`

Work:

- Add conflict preflight and expected-version checks.
- Enforce current Mine paths and symlink aliases.
- Add durable journal, staged source and session apply, rollback, and startup
  recovery.
- Fork the selected candidate leaf into a self-contained primary-cwd session.
- Route promotion changes into primary Change Review and open the promoted
  primary terminal.
- Add confirmed comparison discard and idempotent cleanup.

**Release 1 gate:** Fork Run works end to end with two isolated candidates,
Verify, comparison, recoverable promotion, and complete cleanup.

### Phase 6 — Fork Any Moment

Files expected to change:

- app bridge source
- `electron/sidecar.ts`
- `electron/watcher.ts`
- `electron/worldline-git.ts`
- `electron/worldlines.ts`
- `shared/types.ts`
- `src/timeline.ts`
- `src/main.ts`
- timeline E2E suites

Work:

- Buffer watcher hints until stable Pi boundaries.
- Reconcile and persist incremental raw Git blobs.
- Correlate tool results by tool call and batch ids.
- Coalesce parallel sibling tools.
- Replace transient timeline dots with stable forkable events.
- Remove a dot whenever its source state is evicted.
- Add `worldline:fork-point` with expected-version checks.
- Show indexing, ready, paused, degraded, and budget states outside the dot
  strip.
- Permit nested worldlines only after attribution and cleanup tests pass.
- Keep the root promotion base unchanged across every nested worldline.

**Release 2 gate:** Every visible dot creates a runnable candidate with that
exact captured source state and persisted Pi context.

### Phase 7 — Challenge Mode

Files expected to change:

- new `electron/challenge.ts`
- new `electron/evidence.ts`
- evidence worker entries
- `electron/worldlines.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `shared/types.ts`
- `src/worldlines.ts`
- `src/styles.css`

Work:

- Add the four fixed challenge profiles.
- Extract and submit the effective original task automatically.
- Match the reference model and thinking level by default.
- Build and pin immutable evaluation assets before launch.
- Add dependency, TypeScript API, footprint, and benchmark adapters.
- Track evidence by source state and invalidate stale results.
- Implement deterministic eligibility, thresholds, ties, and ranking reasons.
- Show raw evidence and unavailable profiles.
- Run one challenger and one evidence worker at a time.

**Release 3 gate:** One click launches the selected adversarial alternative, and
Termina ranks only current measured evidence without a model judging another
model's work.

## 8. IPC additions

Use the existing `area:action` convention.

### Commands

- `worldline:list`
- `worldline:fork-run`
- `worldline:fork-point`
- `worldline:compare`
- `worldline:challenge`
- `worldline:evidence`
- `worldline:open-terminal`
- `worldline:cancel`
- `worldline:promote`
- `worldline:discard`

### Pushes

- `worldline:update`
- `worldline:removed`
- `worldline:evidence-update`
- `timeline:recorder-state`

Mutating requests contain only app-issued ids, expected object version, and
expected head source state. The renderer cannot submit filesystem paths, Git
object ids, shell commands, session paths, or evidence results. Main validates
workspace ownership and lifecycle before work starts.

List and push payloads contain metadata only. Fetch paths, diffs, raw benchmark
samples, and file content on demand. Never send prompt images, injected context,
credentials, or source blobs in list pushes.

## 9. Performance and resource budgets

Phase 0 must record real baselines. Initial targets:

- No synchronous Git, repository walk, session parse, hashing, benchmark,
  sandbox startup, or directory copy on the Electron main thread.
- Run-boundary capture under 200 ms at p95 on the medium fixture repository.
- Incremental capture under 100 ms at p95 when ten or fewer files change.
- Checkpoint quiet window of 100 ms, with one bounded retry.
- Pair materialization under 5 seconds at p95, excluding Pi provider startup.
- One candidate materialization under 3 seconds at p95.
- Timeline and worldline push payload under 10 KB.
- At most three live worldlines.
- At most two active candidates in one comparison.
- At most 100 retained fork points per terminal.
- At most 100,000 captured source paths and 64 MB for one source file.
- At most 256 MB of new retained source blobs per project session.
- At most 64 MB for one copied source Pi session file and 20 MB for one
  structured prompt payload.
- At most 2 GB of logical runtime data per comparison template.
- At most 1 GB of new candidate-local data per candidate before automatic
  cancellation.
- Bounded memory, CPU time, process count, file size, open files, captured
  output, and terminal scrollback per candidate.
- Require at least 4 GB of free space before pair creation and keep a 1 GB
  emergency reserve while candidates run.
- Checkpoint acknowledgement timeout of 5 seconds.
- One concurrent comparison creation, promotion, or benchmark per project.
- Fetch diff and evidence details only on demand.

When a budget fails, disable or pause the operation and show the measured
reason. Do not add a slow full-copy path, unbounded cache, or oversized IPC
fallback.

## 10. Test plan

Use fresh Electron instances, clean fixtures, dedicated event directories, and
a dedicated `TERMINA_WORLDS_DIR` on the fixture's filesystem for every suite.

### `scripts/worldline-preflight-test.mjs`

- Reject a non-Git folder, Git subdirectory, app-owned candidate root, old Git,
  sparse checkout,
  partial/promisor clone, source object alternate, unresolved index, submodule,
  nested repository, unsupported file type, content filter, unreliable
  recursive watcher, missing copy-on-write support, missing sandbox, low disk,
  and mismatched Pi version.
- Support an unborn repository and the source repository's Git object format.
- Keep exact ineligibility reasons stable.

### `scripts/worldline-capture-test.mjs`

- Preserve working bytes for staged, unstaged, untracked, binary, executable,
  symlink, renamed, and deleted files.
- Leave user status, index bytes, refs, objects, hooks, and worktree metadata
  unchanged.
- Reconcile a deliberately missed watcher event.
- Reject a capture that changes before completion.
- Enforce source path-count, single-file, and total-blob budgets.
- Deduplicate identical raw blobs.
- Corrupt or remove a snapshot object and invalidate every dependent point
  without touching primary source.
- Evict a dot and source state together.
- Keep pinned states during budget eviction.

### `scripts/worldline-isolation-test.mjs`

- Block primary writes through absolute file-tool paths, relative escapes,
  symlinks, Bash, custom tools, Verify commands, Git commands, and child
  processes.
- Block writes to real home, source Git metadata, and the sibling candidate.
- Block all candidate access to the app snapshot store and block source Git
  refs, config, hooks, and worktree metadata while preserving read-only object
  access.
- Block signals and process inspection outside the candidate group.
- Deny candidate network except the active model provider and deny all Verify
  network without an explicit evidence grant.
- Give A and B independent Git indexes, refs, runtime files, homes, caches,
  sessions, and temporary directories.
- Enforce memory, CPU time, file-size, process-count, output, and free-space
  limits.
- Kill grandchildren during discard.

### `scripts/worldline-fork-run-test.mjs`

- Create A from the settled run and B from the start.
- Assert a shared base and independent candidate heads.
- Reconstruct the copied Pi branches in candidate session directories.
- Prefill text once after bridge readiness.
- Replay structured content unchanged once.
- Preserve captured one-shot context.
- Reject interruption, steering, follow-up, overlap, session loss, oversized
  session or prompt payload, and changed trust-sensitive resources.
- Keep retries and compaction inside one Run without replacing its start state.
- Mark manual unowned edits collaborative and disable Challenge ranking.
- Fail one candidate creation and remove both candidates.

### `scripts/worldline-any-moment-test.mjs`

- Assert that every visible dot has a Pi entry and source state.
- Fork before a later edit and exclude that edit.
- Promote a nested worldline against its root promotion base and include all
  ancestor changes.
- Restore create, delete, rename, mode, binary, and symlink state.
- Coalesce parallel sibling tools.
- Buffer Bash writes until the persisted tool result and quiet window.
- Create no dot for transient starts, capture timeout, generation mismatch, or
  exhausted budget.

### `scripts/worldline-evidence-test.mjs`

- Use the base Verify command for both candidates.
- Run candidates serially with equivalent isolated environments.
- Invalidate on source change, modified evaluation asset, cancellation,
  timeout, or stale head.
- Do not let added tests replace required checks.
- Permit explicit manual promotion without an evidence-winner label.

### `scripts/worldline-challenge-test.mjs`

- Launch each profile with one action and the same default model settings.
- Submit the effective original task with hidden one-shot challenge context.
- Disqualify failed or stale Verify evidence.
- Make a challenger with more added declarations than the reference
  ineligible for Fewer dependencies.
- Detect changed public declarations for Preserve API.
- Rank the smallest verified footprint for Simpler implementation.
- Disable Performance-first without a parseable immutable benchmark.
- Interleave benchmark samples and enforce effect and variability thresholds.
- Show a tie for inconclusive evidence.
- Confirm ranking performs no model call.

### `scripts/worldline-promote-test.mjs`

- Promote A and B independently.
- Preserve unrelated primary edits made after the fork.
- Flush dirty Monaco models before preflight.
- Block current Mine paths and symlink aliases.
- Detect text, binary, rename, mode, symlink, case-only, and file-directory
  conflicts.
- Keep user Git index, refs, and branch unchanged.
- Detect generation, expected-version, unmount, and repository-identity races.
- Crash after each source and session journal phase and recover the original
  primary state without leaving an orphan promoted session.
- Complete a promotion and resume the new primary terminal with the selected
  candidate context.
- Mark older primary terminals out of date before their next run.
- Change a journaled path externally after the crash and require a recovery
  conflict instead of overwriting it.

### `scripts/worldline-trust-test.mjs`

- Load the app bridge before project trust.
- Inherit one-process trust only from a trusted matching base.
- Do not write candidate paths to `trust.json`.
- Keep an untrusted source untrusted.
- Require review after trust-sensitive resource changes.

### `scripts/worldline-cleanup-test.mjs`

- Cancel pair creation at each phase.
- Close one candidate terminal without silent discard.
- Confirm before project switch or normal quit with candidate source or session
  activity.
- Discard a live comparison.
- Recover from killed Pi, session worker, snapshot worker, Verify, and benchmark
  processes.
- Simulate process-id reuse and confirm stale cleanup does not signal the new
  process.
- Recover a promotion journal before stale cleanup.
- Remove stale app-owned resources after a simulated crash.
- Refuse cleanup paths outside the canonical worlds root or without a matching
  ownership marker.
- Reload only the renderer and rebuild candidate and timeline state from main
  without duplicate events or lost operation versions.
- Confirm no process, watcher, timer, sidecar, control, session, directory, or
  source-state pin survives cleanup.

Also run:

- `npx tsc --noEmit`
- `npm run build`
- every existing E2E suite against a fresh instance

## 11. Release gates

### Release 1 — Fork Run

- Preflight rejects every unproven repository or platform condition clearly.
- An eligible completed run creates two isolated candidates.
- Candidate A preserves the captured settled source and session branch.
- Candidate B restores the captured start source and effective task, including
  root-prompt sessions.
- Candidate processes cannot write primary, sibling, real-home, or user Git
  state.
- Both candidates Verify in equivalent isolated environments.
- Promotion preserves the selected Pi branch in a self-contained primary-cwd
  session.
- Clean promotion preserves unrelated concurrent primary edits.
- Conflict detection writes no primary path.
- A crash during promotion recovers automatically or reports a recovery
  conflict without overwriting external changes.
- Mine paths are enforced.
- Discard and project switch leave no live app-owned resource.

### Release 2 — Fork Any Moment

- Every visible timeline dot has a coupled persisted Pi entry and source state.
- Incremental raw blobs reconstruct every retained event byte-for-byte inside
  the declared capture domain.
- Parallel tools, Bash writes, watcher misses, and concurrent changes produce
  stable truthful outcomes.
- Forking an old dot excludes all later source changes.
- Dot, source-state, and byte budgets remain bounded.

### Release 3 — Challenge Mode

- Each supported profile starts an adversarial sibling with one action.
- The challenger receives the captured effective task and selected constraint.
- Evidence assets are immutable, deterministic, visible, and tied to one source
  state.
- Failed, modified, unsupported, or stale evidence cannot win.
- Noisy results remain ties.
- The UI calls the result an evidence winner and preserves human review.
- No model ranks or judges another model's implementation.

Worldlines is complete when all three release gates pass and terminal, review,
timeline, dispatch, user-edit, Mine, and Verify behavior remains green after the
intentional bridge and timeline changes.
