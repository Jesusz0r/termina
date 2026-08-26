# AGENTS.md — Termina

This file defines the rules for agents that work in this repository.

## Project

Termina is a hybrid coding tool. The left side runs the real pi interactive
TUI in a pty. The right side is a Monaco IDE with a file explorer. The two
sides stay synchronized. The project is a desktop app built with Electron,
Vite, TypeScript, and node-pty.

## Project Guidelines

These rules apply to all work in this repository.

When multiple solutions are correct, prefer the solution that is faster on
the hot path, introduces the least new complexity, reuses existing
behavior, and follows established codebase patterns.

Always optimize for performance. Treat latency, main-process
responsiveness, IPC size, and renderer update cost as standing
requirements, not as later polish.

Simplicity does not override correctness, security, data integrity,
performance, or explicit product requirements.

### Decision Priority

When guidelines appear to conflict, use this priority:

1. Correctness and data integrity (source trees, snapshots, write leases,
   session and preference files)
2. Security and process isolation (main vs renderer, env sanitization,
   candidate sandboxes)
3. Explicit task and product requirements
4. Main-process responsiveness and hot-path performance
5. Existing public contracts that are not part of the requested change
   (IPC channels, sidecar events, release tags)
6. Established codebase architecture and conventions
7. Simplicity, reuse, and locality
8. Developer convenience

Do not choose a simpler implementation if it weakens a higher-priority
requirement.

Performance of the main process is a correctness requirement in this app.
Never block it with slow work. Do not treat that as developer convenience.

---

## One Canonical Implementation

The codebase should have **one canonical way to perform each responsibility**.

If an implementation already owns a responsibility, reuse it, extend it, or
replace it. Do not introduce a parallel implementation.

In this repository that means:

* The main process owns application state. The renderer only renders what
  main pushes.
* `core/` (`termina-core`) owns every Git and snapshot operation. Do not
  spawn the Git CLI or add a second snapshot store.
* `electron/worldline-git.ts` is the only TypeScript client for that core.
* `electron/session-fork.ts` is the only TypeScript client for the session
  worker. The worker entry stays in `electron/session-worker.ts`.
* `shared/preferences.ts` is the only preferences validator. The renderer
  and main both call it. Do not add a second merge or default-fill path.
* `electron/preferences.ts` is the only preferences file store.
* `electron/plan-board.ts` owns Plan Board parse, progress, finalize, and
  Dispatch task picks. The bridge does not define a second task-line rule.
* `electron/worldlines.ts` owns comparisons, promotion journals, evidence
  runs, and the run-record catalog. Main writes a record at agent start
  and settle. `electron/evidence.ts` only measures a candidate.
* `electron/sidecar.ts` owns sidecar parse, sequence, and tail. Two writers
  emit that protocol: the Pi bridge (`electron/bridge-extension.ts`) and
  agent-core (`agent-core/host.ts` plus `logEvent` in `agent-core/main.ts`).
  Do not add a third writer or a second event schema.
* `electron/session-search.ts` owns Session Search parse and walk. Main
  supplies this project's Pi directory, core directory, and live/roster
  files. Do not add a second session JSONL parser.
* The bridge extension is app-owned in the user-data directory. Do not
  generate a second copy in the project.
* IPC channels use the `area:action` pattern. Do not invent a second
  IPC style.

Never:

* Duplicate business logic to support different callers.
* Create two helpers, services, components, modules, routes, APIs, or
  workflows that perform the same responsibility.
* Create a second implementation merely because changing existing callers
  requires more work.
* Keep both an old implementation and a replacement implementation active.
* Maintain separate "legacy" and "new" internal code paths.
* Use backwards compatibility as justification for duplicated application
  logic.
* Use simplicity as justification for duplicating behavior instead of
  fixing the canonical implementation.

When replacing behavior:

1. Implement or update the canonical behavior.
2. Migrate every internal caller to it.
3. Remove the old behavior.
4. Remove obsolete helpers, types, IPC channels, configuration, tests,
   documentation, exports, and dependencies.
5. Verify that only one implementation remains.

The desired end state is:

> One responsibility. One canonical implementation. No parallel path.

---

## No Backwards Compatibility

Do not preserve obsolete implementations merely to maintain backwards
compatibility.

* Never add permanent backwards compatibility layers, shims, deprecated
  aliases, legacy toggles, fallback implementations, or parallel code paths.
* Do not preserve an old internal API when all callers can be migrated.
* Do not preserve old function signatures by forwarding them to new
  implementations when the callers are under our control.
* Do not keep old behavior behind feature flags after the replacement
  behavior becomes canonical.
* Do not keep obsolete code because it might be useful later.
* Do not preserve old behavior alongside replacement behavior.
* A full greenfield replacement is always acceptable.
* Remove dead code immediately. Do not leave it behind.
* When a feature changes, update every place that depends on it.
* The current behavior is the only behavior that matters.

The current bridge-cleanup rule is not a compatibility layer: the app
removes a generated bridge from a project that carries the Termina marker.
A user file that only shares the name stays untouched.

### Internal Code Has No Compatibility Requirement

Code under our control should be migrated, not supported indefinitely.

When changing an internal function, helper, component, module, class,
service, type, interface, IPC channel, or API used only internally, update
its consumers.

Prefer:

```text
change abstraction
update all callers
delete old interface
```

over:

```text
change abstraction
keep old interface
add forwarding wrapper
support both
```

Backwards compatibility is for genuine external constraints, not an excuse
to avoid completing a refactor.

### Temporary Migration Mechanics

Temporary compatibility is acceptable only when an external constraint
makes an atomic migration impossible.

Examples in this project:

* Packaged app upgrades where a preference file on disk must be read once
  and rewritten in the current shape
* Snapshot-store format changes that cannot rewrite every object in place
* Sidecar or session files produced by an already-running pi process

Even in these cases:

* Keep one canonical business implementation.
* Do not duplicate domain or application logic.
* Put temporary compatibility at the narrowest possible boundary
  (`shared/preferences.ts` for prefs, `core/` for snapshot objects).
* Temporary adapters must delegate to the canonical implementation.
* Do not introduce parallel internal architectures.
* Do not maintain separate old and new workflows.
* Do not spread compatibility conditionals throughout the codebase.
* Migrate internal callers immediately when they are under our control.
* Give temporary compatibility code a clear removal condition.
* Remove it as soon as the external constraint no longer exists.

Acceptable:

```text
legacy file on disk
        |
narrow reader in the canonical owner
        |
canonical in-memory model
```

Not acceptable:

```text
legacy file -> legacy implementation
new file    -> new implementation
```

This app has no user-facing database. Do not add schema-migration machinery,
dual-write paths, or a second persistence model for application state.

### Removal Means Removal

When a feature or behavior is intentionally removed, remove everything that
exists only to support it, including implementation, UI, IPC, configuration,
types, helpers, tests, documentation, exports, dependencies, compatibility
code, and consumers.

Do not leave dead architecture behind.

---

## No Overengineering

Optimize for performance, simplicity, clarity, locality, reuse, and
maintainability.

The goal is not to write the fewest lines of code.

The goal is to introduce the **smallest amount of new complexity required
to solve the current problem correctly and quickly**.

Always choose the faster correct design when the extra complexity is
small. Do not add layers, caches, or thread hops for a cost you have not
measured. Do not optimize for hypothetical future requirements.

The performance rule does not excuse over-engineering. Measure first, then
optimize the measured problem. Still keep every hot path fast by default:
do not land a slower design because a faster one would take more care.

### Implementation Decision Order

When solving a problem, prefer solutions in this order:

1. Use existing functionality as-is.
2. Compose existing functions, helpers, modules, components, or primitives.
3. Make a small change to an existing abstraction.
4. Add a small local helper.
5. Add a new reusable abstraction.
6. Introduce a new architectural pattern, dependency, or subsystem.

Move down this list only when the previous option does not solve the
problem cleanly.

Before creating something new, search the relevant codebase area for an
existing solution or established pattern.

**Do not create a second way of doing something the codebase already knows
how to do.**

This order must never be interpreted as permission to duplicate behavior.

If an existing implementation must be replaced, migrate its callers and
remove it rather than adding a second implementation alongside it.

### Prefer the Simplest Correct Solution

* Build the smallest solution that fully satisfies the current requirements.
* Prefer straightforward code over clever, generic, highly configurable, or
  overly abstract code.
* Prefer explicit behavior when abstraction would make the implementation
  harder to understand.
* Prefer sensible defaults over configuration.
* Prefer one clear workflow over several configurable workflows unless
  multiple workflows are explicitly required.
* Do not add abstractions, generics, options, extension points, or
  configuration for hypothetical requirements.
* Do not make code extensible "just in case."
* Do not solve adjacent problems unless they are necessary for the
  requested change.
* Do not redesign unrelated architecture while implementing a local
  feature or fix.

Implement today's requirement cleanly.

Refactor when a concrete requirement justifies the refactor.

### Minimize Conceptual Surface Area

Every new concept has a maintenance cost.

When choosing between correct implementations, prefer the one with fewer
concepts, layers, abstractions, indirections, public APIs, configuration
options, possible states, dependencies, and cross-file coordination.

Do not measure simplicity by line count.

A slightly longer direct implementation can be substantially simpler than
a shorter implementation that requires several abstractions.

Do not collapse meaningful boundaries merely to reduce the number of files
or classes. In this app those boundaries include:

* main process vs renderer vs preload
* `core/` vs the TypeScript snapshot client
* write leases and workspace isolation
* candidate sandboxes

---

## Reuse Existing Behavior Before Creating New Behavior

Before introducing a new helper, utility, module, service, component,
class, or abstraction:

1. Search for existing functionality that already solves or partially
   solves the problem.
2. Confirm that the existing behavior has the same semantics.
3. Reuse it directly when it fits.
4. Compose existing primitives when the composition remains easy to
   understand.
5. Extend an existing abstraction when the new behavior belongs to the
   same responsibility.
6. Replace an existing abstraction when its current design no longer fits
   and the responsibility remains the same.
7. Create something new only when no existing concept cleanly owns the
   responsibility.

Prefer the codebase's existing domain concepts and glossary terms.
Do not invent synonyms.

Do not create parallel helpers with slightly different names for the same
responsibility. Do not create a new abstraction solely to avoid modifying
an existing one.

Do not force reuse when it creates awkward coupling, violates an
abstraction's responsibility, changes its meaning, requires excessive
conditionals, or makes the existing abstraction harder to understand.

Reuse must reduce total complexity.

---

## Shared Behavior, Not Premature Abstraction

Centralize genuinely shared behavior. Do not abstract superficial similarity.

* Prefer direct, readable code until a stable shared concept is evident.
* Do not extract code merely because two pieces of code look similar.
* Similar syntax does not necessarily mean shared responsibility.
* Extract shared behavior when multiple concrete consumers need the same
  semantics and the shared concept is clear.
* Two consumers are usually sufficient evidence when the common
  responsibility is stable and meaningful.
* Do not duplicate important business or domain rules merely to avoid
  creating an abstraction.
* A small amount of incidental duplication is preferable to the wrong
  abstraction.

The allowance for incidental duplication does **not** apply to duplicated
responsibility. It can be acceptable for two pieces of code to contain
similar syntax. It is not acceptable for two independent implementations
to encode the same business rule.

---

## Avoid Speculative Flexibility

Do not add flexibility before it is required.

Avoid parameters nobody currently needs, configuration nobody currently
changes, optional behavior without a concrete consumer, extension points
without extensions, generic frameworks around one use case, interfaces
created only because another implementation might exist someday, factories
for straightforward construction, registries without multiple real entries,
strategy patterns when there is only one real strategy, wrappers around
stable APIs that add no meaningful behavior, and feature flags without a
rollout or operational requirement.

Do not hard-code values that genuinely vary by environment, installation,
or machine. Paths, the events directory, the core binary path, and signing
identities stay configurable through the existing overrides
(`TERMINA_EVENTS_DIR`, `TERMINA_CORE_BIN`, `TERMINA_SKIP_CORE_BUILD`,
`CSC_NAME`).

YAGNI applies to architecture as well as features.

---

## Keep Behavior Local

Keep behavior close to the code that owns and understands it.

Prefer:

```text
caller
  -> existing helper
  -> result
```

over extra coordinator / service / adapter / strategy layers unless those
layers represent a real boundary.

* Keep snapshot and Git behavior in `core/` and `electron/worldline-git.ts`.
* Keep session fork plumbing in `electron/session-fork.ts` and the
  SessionManager work in `electron/session-worker.ts`.
* Keep terminal, workspace, and IPC ownership in `electron/main.ts`.
* Keep UI-specific behavior in `src/`.
* Keep preference validation in `shared/preferences.ts`.
* Keep the preference file store in `electron/preferences.ts`.
* Keep transformations near the data they transform.
* Do not introduce cross-cutting infrastructure for inherently local
  behavior.

Locality does not override canonical ownership. If shared behavior already
has a canonical owner, call that owner instead of duplicating the behavior
locally.

---

## Avoid Pass-Through Abstractions

Do not create layers that primarily rename, wrap, or forward another API.

An abstraction should add meaningful behavior such as domain policy,
validation, transformation, invariants, lifecycle management, coordination,
error handling, or isolation from an external system.

Do not replace several obvious operations with a vaguely named `Manager`,
`Processor`, `Handler`, `Coordinator`, or `Service` unless that object owns
a meaningful responsibility. `WorldlineManager` owns fork-run pairs,
candidates, promotion, evidence orchestration, challenges, and compare. Do not add a second object
with the same job.

`electron/pty-terminal.ts` stays a thin wrapper around node-pty.
`electron/worldline-git.ts` stays request plumbing over the Rust core.
`electron/session-fork.ts` stays request plumbing over the session worker.
Do not thicken those files into parallel implementations.

---

## Dependencies Must Earn Their Cost

Prefer solutions in this order:

1. Language features
2. Standard library
3. Framework capabilities already used by the project (Electron, Vite,
   Monaco, xterm, node-pty)
4. Existing project dependencies
5. The Rust snapshot core for Git, hashing, capture, merge, and tree work
6. A small maintainable local implementation
7. A new dependency

Add a dependency only when it solves the problem materially better than
the available alternatives.

Do not add a package for functionality that is trivial to implement
correctly with existing tools.

Do not reimplement complex snapshot, merge, or Git store behavior in
TypeScript to avoid touching `core/`.

`@lydell/node-pty` must stay external in esbuild. Bundling it breaks with
a dynamic-require error.

---

## Product Simplicity

Keep product complexity proportional to actual user needs.

* Prefer sensible defaults over user configuration.
* Add configuration when users have a concrete reason to control the
  behavior (theme, editor and terminal fonts, word wrap, shortcuts).
* Prefer progressive disclosure over exposing every capability at once.
* Avoid exposing implementation concepts (sidecars, write leases, core
  protocol) directly in the product.
* The terminal stays the source of truth. The app never replaces the TUI.
* Do not expose separate user workflows that represent the same underlying
  operation unless the product requirements genuinely require distinct
  experiences.

---

## Do Not Over-Refactor

Keep the scope of a change proportional to the task.

Refactor nearby code when doing so materially simplifies the requested
implementation, removes an obstacle to correctness, removes duplicated
responsibility, fixes a bug exposed by the change, or restores a violated
architectural boundary.

Do not rename unrelated concepts, reorganize unrelated modules, or
introduce a new architecture solely because another design appears better.

If completing the requested change requires migrating callers to maintain
one canonical implementation, migrate them.

If unrelated code could be improved but is not necessary for the current
task, leave it unchanged.

---

## Styling: `src/styles.css` tokens

This project has no `DESIGN.md`. The canonical design tokens live in
`:root` and the `html[data-theme]` blocks in `src/styles.css`.

* Use those CSS variables (`--bg`, `--bg-panel`, `--bg-raised`,
  `--bg-hover`, `--border`, `--text`, `--text-dim`, `--accent`, and the
  status colors) instead of duplicating raw values.
* Never substitute inline colors for an existing token without a concrete
  reason.
* Do not introduce accent colors, shadows, gradients, or font families
  that conflict with the existing chrome (monospace UI, existing themes
  `dark`, `light`, `high-contrast`).
* Reuse existing component classes and style patterns when their
  semantics match.
* Do not duplicate a shared component merely to create a visually
  different version of the same responsibility.
* Keep surface-specific styles local when they are genuinely unique.
* Do not modify a global token solely to satisfy one local surface unless
  the change is intended to apply globally.

Do not add `DESIGN.md` or a design-lint step unless the product explicitly
requires a separate design-system file.

---

## Privilege and process isolation

This app has no user-scoped SQL database and no RLS policies.

The privilege boundary is process isolation:

* The renderer never talks to the agent. It only renders what main pushes.
* The renderer never performs privileged filesystem, pty, or snapshot
  work. That stays in the main process or in `core/`.
* Preload exposes the typed `window.pi` bridge. Do not widen that surface
  without a concrete renderer need.
* Do not work around a permission or isolation failure by moving
  user-facing work into a more privileged path.
* Do not create a second privileged implementation of the same
  user-facing operation.
* Write leases in main prevent two app-controlled writers from changing
  one source tree during a critical operation. Do not bypass a lease.
* Candidate sandboxes and the evidence (offline) profile stay the
  canonical isolation for worldline work. Do not add a parallel sandbox.
* Sanitize the env for pi processes. Host session variables
  (`PI_SESSION_FILE`, `PI_MODEL`, `PI_CODING_AGENT`, ...) make the TUI
  crash or hang. Do not remove that sanitization.

Privileged work is acceptable only for trusted main-process or `core/`
operations that cannot run in the renderer, such as pty spawn, snapshot
capture, and preference file IO. That work must stay server-side (main),
be narrowly scoped, and validate its inputs.

---

## Performance

Always optimize for performance. A change is not complete if it is
correct but slower than a simple alternative on the same path.

* Keep the main process responsive. Never block it with slow work.
* Keep IPC messages small. Do not send file content when metadata is
  enough.
* Fetch heavy data on demand. Do not push it before the user needs it.
* Cap unbounded state. Use budgets for caches, timelines, and buffers.
* Avoid O(n^2) work in hot paths. Use maps and indexes.
* Use incremental DOM updates. Do not re-render whole lists per event.
* Captures, merges, and hashing run in the Rust core for this reason.
* A new feature must not regress the hot paths.
* When in doubt, make the fast path the only path.

---

## Comments: ASD-STE100 Simplified Technical English

Comments added or modified as part of a change should follow ASD-STE100
Simplified Technical English principles.

* Use short and simple sentences. Write one idea per sentence.
* Use the active voice. Use the present tense when describing current
  behavior.
* Prefer common and unambiguous words.
* Use the same word for the same thing in every comment.
* Do not use abbreviations. Write "does not", not "doesn't".
* Do not use slang, idioms, or figurative language.
* Put the main idea at the start of the sentence.
* Explain why when the reason is not obvious from the code.
* Do not repeat what the code already states clearly.
* Remove comments that no longer add useful information.

Do not rewrite unrelated existing comments solely to enforce this style.

Do not alter required literal text such as protocol names, IPC channel
names, glossary terms, commands, identifiers, error strings, or quoted
external text merely to make it conform to Simplified Technical English.

Examples:

* Correct: "Send the result to the renderer only when the run is active."
* Correct: "Use the canonical path as the cache key. This makes every
  lookup hit."
* Wrong: "So this basically sends stuff over to the renderer when things
  are running."
* Wrong: "pretty fast path for the common case lol"

---

## Final Implementation Check

Before considering an implementation complete, check:

1. Did I solve the actual requested problem?
2. Did I preserve correctness, security, and data integrity?
3. Did I keep the main process responsive, the IPC payload small, and
   the hot path as fast as a simple correct design allows?
4. Did I search for relevant existing functionality before creating
   something new?
5. Did I reuse existing behavior only where the semantics actually match?
6. Is there exactly one canonical implementation for each responsibility
   I changed?
7. Did I accidentally leave an old implementation active?
8. Did I introduce a second helper, service, component, IPC channel, or
   workflow for behavior that already existed?
9. Did I duplicate a business rule instead of centralizing it in its
   canonical owner (main, preferences, worldline-git, or `core/`)?
10. Can any new abstraction, layer, option, or dependency be removed
    without making the solution worse?
11. Did I add flexibility that no current requirement needs?
12. Did I create a layer that mostly forwards calls?
13. Is the behavior located near the code that owns it?
14. Did I follow existing terminology, glossary terms, and IPC patterns?
15. Did I migrate internal callers instead of adding compatibility
    wrappers?
16. Did I remove obsolete code, tests, configuration, and dependencies
    made unnecessary by the change?
17. Did I avoid unrelated refactoring?
18. Is this the simplest correct solution that remains easy to understand
    and maintain?

If a simpler solution provides the same correctness, security, clarity,
and maintainability, choose the simpler solution.

If two implementations now own the same responsibility, the work is not
complete.

The intended result is **boring, obvious code**.

Another experienced developer should be able to read the implementation
and think:

> "Of course that's how this works."

---

## Architecture notes

- The terminal stays the source of truth. The app never replaces the TUI.
- The bridge extension is app-owned: the app writes it once to the app
  user-data directory and passes it to pi with the CLI extension option.
  It never lives in the project; the app removes a legacy generated copy
  from a project that carries the Termina marker.
- A folder switch resets every per-terminal state: timeline, baselines,
  snapshots, modified list, and verify state.
- Projects are per-folder tabs (main: `ProjectState`, renderer: the
  project tab bar). Switching tabs never interrupts agents; each project
  owns its workspaces, store, mine marks, and worldline manager.
  Terminal-scoped event handlers resolve the terminal's own project.

## Glossary

Use these terms exactly. Do not invent synonyms.

- **Run**: one agent session. It starts with agent_start and ends with
  agent_settled.
- **Sidecar**: a JSONL file in the events directory. The bridge extension
  writes one file per terminal.
- **Baseline**: the content of a file when a run starts. Change Review uses
  it to show diffs and to revert.
- **Snapshot**: the content of a file at one moment of a run. The timeline
  uses snapshots.
- **Dot**: one point on the timeline strip.
- **Worker**: a pi terminal that runs one dispatched plan task for the
  owner. Verify & Iterate runs tests in a background process, not in a
  worker terminal. Dispatch workers receive a mailbox briefing and sibling
  settle notes through the same context-file path as Verify and user edits.
- **Modified list**: the panel that shows the files a run changed.
- **Fork point**: one visible timeline event coupled to a Pi session entry and
  an immutable source state.
- **Worldline**: one isolated candidate source tree and matching Pi session.
- **Candidate**: a worldline that participates in one comparison.
- **Reference**: Candidate A, which preserves the original future.
- **Alternative**: Candidate B, which starts from the shared base.
- **Challenge**: an automatically launched alternative with one fixed
  constraint profile.
- **Evidence contract**: immutable deterministic checks and measurements used
  to compare candidates.
- **Write lease**: main-process ownership that prevents two app-controlled
  writers from changing one source tree during a critical operation.
- **Workspace**: one source tree the app controls, with its own watcher,
  user-edit state, and write lease. The primary workspace is the opened
  project; worldline candidates get their own workspaces.

## File map

- `electron/main.ts`: the main process. It owns the terminals, the
  workspaces, the watchers, all state, and the IPC handlers. It writes the
  materialized bridge file to the app user-data directory.
- `electron/pty-terminal.ts`: a thin wrapper around node-pty.
- `electron/session-fork.ts`: the session-fork client. It owns the request
  plumbing over the worker thread. SessionManager work stays in the worker.
- `electron/session-worker.ts`: forks candidate sessions off the main
  thread (copy, branch, forkFrom).
- `electron/sidecar.ts`: sidecar protocol parse, sequence, and tail.
- `electron/bridge-extension.ts`: the Pi bridge extension source. Pi loads the
  materialized copy from the user-data directory.
- `agent-core/`: the in-house agent kernel (loop, tools, TUI, auth).
- `agent-core/host.ts`: Termina host adapter (ack, prompt payload, context
  files, startup-control, pending clipboard images). Same file names as
  the Pi bridge.
- `agent-core/session.ts`: core session JSONL slice, fork write, and
  `/clear` rotate. Pi session fork stays in `electron/session-fork.ts`.
- `electron/session-search.ts`: Session Search parse and walk (Pi and
  core JSONL). Main supplies the file list for the active project.
- `electron/watcher.ts`: watches the project, keeps a content cache, and
  emits change events.
- `electron/worldline-git.ts`: the snapshot store client (capture,
  materialization, three-way merges). Every operation runs in the Rust
  snapshot core; the class keeps only the paths, the object format, and
  the request plumbing.
- `core/`: the Rust snapshot core (`termina-core`). It owns the
  app-owned Git store: full and incremental captures, materialization,
  template creation, state application, merges, preflight, diff-tree,
  tree queries, trust hashes, and the source-repository queries. It
  speaks a JSON-lines protocol over stdio; the built binary lives next to
  the main bundle and is rebuilt by `scripts/build-core.mjs`. The app no
  longer spawns the Git CLI.
- `electron/worldlines.ts`: the WorldlineManager (run records, fork-run
  pairs, moment candidates, promotion, evidence orchestration, challenges,
  compare). Promotion journals recover through `recoverPromotionJournals`.
- `electron/evidence.ts`: the evidence engine and the four challenge
  profiles. Trajectory counts come from `electron/sidecar.ts`. The
  manager owns when evidence runs; this module measures one candidate.
- `electron/sandbox.ts`: the candidate sandbox profiles, the evidence
  (offline) profile variant, and the ulimit preamble.
- `electron/preload.ts`: exposes the typed `window.pi` bridge.
- `electron/preferences.ts`: persists app-owned preferences.
- `electron/app-update.ts`: packaged-app updates from GitHub Releases.
- `electron/plan-board.ts`: Plan Board parse, progress, finalize, and Dispatch picks. The bridge logs assistant text; this module decides what a task is.
- `shared/preferences.ts`: the preferences validator used by main and the renderer.
- `shared/types.ts`: the types shared between main, preload, and renderer.
- `src/main.ts`: the renderer entry. It manages panes, layout, and events.
- `src/pty-view.ts`: the xterm view for one terminal.
- `src/editor.ts`: the Monaco editor and its tabs.
- `src/review.ts`: the Change Review diff view.
- `src/timeline.ts`: the Session Timeline strip.
- `src/components/explorer.ts`: the file explorer.
- `src/components/modals.ts`: dialogs and toasts.
- `src/settings.ts`: the preferences window.
- `src/styles.css`: renderer chrome and the canonical theme tokens.
- `scripts/*.mjs`: the e2e test suites, the launcher, and the build steps.
- `scripts/prepare-resources.mjs`: stages the bundled node runtime and the
  core binary for electron-builder.
- `scripts/install.sh`: source install for users without cargo; downloads
  the prebuilt core from GitHub Releases.
- `electron-builder.yml`: the packaged-app config (asar unpack, extra
  resources).
- `.github/workflows/release.yml`: per-platform release builds (macOS
  arm64, Linux x64) that publish the app bundles and the raw core
  binaries. Signing and notarization activate when the Apple secrets
  exist.
- `build/`: the app icon (`icon.svg`, generated `icon.icns`/`icon.png`)
  and the hardened-runtime entitlements. Regenerate the icon with
  `scripts/make-icon.sh`.

## Event flow

1. The agent runs a tool in the pi TUI.
2. The bridge extension logs the event to a sidecar file.
3. The sidecar tailer in main reads the file every 300 ms (plus an
   immediate event-driven tail on writes).
4. Main updates its state and sends IPC events to the renderer.
5. The renderer updates the UI.

The renderer never talks to the agent. It only renders what main pushes.

## Testing

- Every suite connects to an Electron instance on port 9222.
- Launch the instance with `--remote-debugging-port=9222`.
- Kill every leftover instance before a test launch. A leftover instance
  holds the single-instance lock and makes the new launch quit silently.
- Full clean sequence:
  `pkill -f "scripts/dev.mjs"; pkill -9 -f "pi-editor/node_modules/electron"; pkill -f "vite"; sleep 3`
- Tests need clean fixtures. Reset the project before every run:
  - `explorer-test.mjs`: greeting.ts, hello.txt, src/index.ts
  - `review-test.mjs`: greeting.ts with `export const greeting = "hello";`
  - `timeline-test.mjs`: the same greeting.ts fixture
  - `verify-test.mjs`: package.json with a `test` script and a buggy
    math.js (`a + b + 1`); the suite restores the bug itself
- Run every suite against a FRESH instance. Suites share the app instance
  and the events directory; running two suites against one instance makes
  the second one fail on stale state.
- `scripts/e2e.mjs` seeds a Pi `term-1` roster before launch. Agent-driving
  suites keep the Pi TUI and `term-1` ids. A new folder in the product
  still opens Agent (core).
- The events directory persists across app launches. A fresh instance
  tails from the current file size, so it never replays phantom history.
  Launch also deletes leftover `mailbox-term-*.md` and
  `startup-control-term-*.json` files. Terminal ids restart at `term-1`,
  and a stale control file would submit the previous dispatch task.
- `TERMINA_EVENTS_DIR` overrides the events directory. Use it for
  deterministic tests; do NOT set it to an empty string — the bridge
  extension then refuses to log anything.
- Test pollution persists on disk. Reset the fixture after a suite that
  modifies it, or the next suite fails on stale state.
- Renderer state is lost on reload. The modified list and the timeline
  rebuild from events, not from a stored snapshot.

## Known gotchas

- `@lydell/node-pty` must stay external in esbuild (build.mjs and dev.mjs).
  Bundling it breaks with a dynamic-require error.
- The Rust core needs cargo on the build machine. `scripts/build-core.mjs`
  builds it in release mode and copies the binary next to the main bundle;
  `TERMINA_CORE_BIN` overrides the binary path at runtime. End users never
  need cargo: the packaged bundle ships the binary, and `scripts/install.sh`
  downloads it (`TERMINA_SKIP_CORE_BUILD=1` skips the cargo build).
- Signed macOS builds need the Developer ID Application identity (the
  Apple Distribution certificate is not accepted by the notary service).
  Locally `CSC_NAME="Developer ID Application"` selects it from the
  keychain; CI uses the `CSC_LINK` p12 secret. Notarization needs
  `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
- The packaged bundle ships its own node (pi's engine floor is 22.19).
  `cleanEnv` prepends `<resourcesPath>/node/bin` to PATH so pi's cli.js
  shebang and pi's own child processes resolve it. Every dependency is
  unpacked from the asar (`node_modules/**`); pi's cli.js is spawned from
  the unpacked path, never from the archive.
- Paths on macOS are canonical: `/tmp` is `/private/tmp`. The watcher
  canonicalizes its cache keys; lookups must use canonical paths too.
- The events directory is `app.getPath("temp")/termina-events`
  (`/var/folders/.../T/`), not `/tmp`. Dispatch mailbox and per-terminal
  startup-control files live there. Worldline candidates use their own
  events directory and `startup-control.json`.
- localStorage keys: `termina.layout`, `termina.explorer`,
  `termina.modified`, `termina.modifiedHeight`, `termina.workpane`. Explorer `0` means the explorer
  is minimized to a bar. `termina.workpane` is `terminal` or `editor`
  when that pane is minimized. Terminal and editor cannot both be
  minimized. The editor stays minimized while no file or Change Review
  is open.
- The bridge extension is app-owned: the app writes it once to the user-data
  directory and passes it to pi with the CLI extension option. A template
  change in `electron/bridge-extension.ts` takes effect on the next app start.
  The app removes the legacy generated bridge from a project when it carries
  the Termina marker; a user file that only shares the name stays untouched.
- The app sanitizes the env for pi processes: host session variables
  (PI_SESSION_FILE, PI_MODEL, PI_CODING_AGENT, ...) make the TUI crash or
  hang at startup. Do not remove the sanitization.
- pi --version runs a flaky update check (measured up to 8 s). The check is
  async on purpose; do not make it synchronous again. App-owned pi processes
  set `PI_SKIP_VERSION_CHECK=1` so the TUI does not nag about a pin the app
  owns.
- The paint watchdog reloads the window when it stays blank. A reload
  rebuilds renderer state from pushes.
- The pty package has no synchronous open. Give the app time to boot
  before the tests connect.

## Conventions

- IPC channels use the `area:action` pattern: `verify:run`, `timeline:get`,
  `file:open`, `review:baseline`, `update:get`.
- Release tags are `v<version>`; keep the package.json version in
  lockstep with the tag (electron-builder publishes under the
  package.json version). See `RELEASING.md`.
- Terminal ids use the `term-N` pattern.
- Commits use the identity `termina <dev@termina.local>`.
- Test suites live in `scripts/` and end with `-test.mjs`.
- The main process is the source of truth. The renderer caches nothing
  that main does not push.

## Verification

- Run `npm run dev` to start the app in development mode.
- Typecheck with `npx tsc --noEmit`.
- Build with `node scripts/build.mjs`.
- Run the e2e suites in `scripts/` against an Electron instance on port 9222.
- A change must keep the existing test suites green.
