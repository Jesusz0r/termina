# AGENTS.md — Termina

This file defines the rules for agents that work in this repository.

## Project

Termina is a hybrid coding tool. The left side runs the real pi interactive
TUI in a pty. The right side is a Monaco IDE with a file explorer. The two
sides stay synchronized. The project is a desktop app built with Electron,
Vite, TypeScript, and node-pty.

## Hard rules

### No backwards compatibility

- Do not keep old behavior for compatibility.
- Do not write migration layers.
- Do not maintain deprecated paths.
- A full greenfield replacement is always acceptable.
- Remove dead code immediately. Do not leave it behind.
- When a feature changes, update every place that depends on it.
- The current behavior is the only behavior that matters.

### Comments in Simplified Technical English

Write every comment in Simplified Technical English (STE, ASD-STE100).

STE rules for comments:

- Use short sentences. Write one idea per sentence.
- Use the active voice. Do not use the passive voice.
- Use the imperative form for instructions.
- Use approved technical words. Do not invent synonyms.
- Use the same word for the same thing in every comment.
- Do not use abbreviations. Write "does not", not "doesn't".
- Do not use slang, idioms, or figurative language.
- Put the main idea at the start of the sentence.
- Do not describe the code. State what the code does and why.
- Do not write obvious comments. Write the reason, not the action.

Examples:

- Correct: "Send the result to the renderer only when the run is active."
- Correct: "Use the canonical path as the cache key. This makes every lookup hit."
- Wrong: "So this basically sends stuff over to the renderer when things are running."
- Wrong: "pretty fast path for the common case lol"

### Performance over everything

- Performance is the first priority. It comes before convenience.
- Keep the main process responsive. Never block it with slow work.
- Keep IPC messages small. Do not send file content when metadata is enough.
- Fetch heavy data on demand. Do not push it before the user needs it.
- Cap unbounded state. Use budgets for caches, timelines, and buffers.
- Avoid O(n^2) work in hot paths. Use maps and indexes.
- Use incremental DOM updates. Do not re-render whole lists per event.
- Measure before you optimize. Do not guess.
- A new feature must not regress the hot paths.
- When in doubt, make the fast path the only path.

### No over-engineering

- Build the simplest thing that works.
- Do not add abstractions before the code needs them.
- Do not design for hypothetical future features.
- Do not create configuration options nobody uses.
- Prefer direct code over clever code.
- Solve the problem in front of you. Do not solve the problems you imagine.
- Delete complexity when a simpler path appears.
- The performance rule does not excuse over-engineering. Measure first,
  then optimize the measured problem only.

## Architecture notes

- The terminal stays the source of truth. The app never replaces the TUI.
- The bridge extension is app-owned: the app writes it once to the app
  user-data directory and passes it to pi with the CLI extension option.
  It never lives in the project; the app removes a legacy generated copy
  from a project that carries the Termina marker.
- A folder switch resets every per-terminal state: timeline, baselines,
  snapshots, modified list, and verify state.

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
  worker terminal.
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
  workspaces, the watchers, all state, and the IPC handlers. The bridge
  extension template is a string in this file; the materialized bridge file
  lives in the app user-data directory.
- `electron/pty-terminal.ts`: a thin wrapper around node-pty.
- `electron/sidecar.ts`: tails the sidecar files and emits events.
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
- `electron/worldlines.ts`: the WorldlineManager (fork-run pairs, moment
  candidates, promotion, challenges, compare).
- `electron/evidence.ts`: the evidence engine and the four challenge
  profiles.
- `electron/sandbox.ts`: the candidate sandbox profiles, the evidence
  (offline) profile variant, and the ulimit preamble.
- `electron/preload.ts`: exposes the typed `window.pi` bridge.
- `electron/preferences.ts`: validates and persists app-owned preferences.
- `shared/types.ts`: the types shared between main, preload, and renderer.
- `src/main.ts`: the renderer entry. It manages panes, layout, and events.
- `src/pty-view.ts`: the xterm view for one terminal.
- `src/editor.ts`: the Monaco editor and its tabs.
- `src/review.ts`: the Change Review diff view.
- `src/timeline.ts`: the Session Timeline strip.
- `src/components/explorer.ts`: the file explorer.
- `src/components/modals.ts`: dialogs and toasts.
- `scripts/*.mjs`: the e2e test suites, the launcher, and the build steps.

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
- The events directory persists across app launches. A fresh instance
  tails from the current file size, so it never replays phantom history.
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
  `TERMINA_CORE_BIN` overrides the binary path at runtime.
- Paths on macOS are canonical: `/tmp` is `/private/tmp`. The watcher
  canonicalizes its cache keys; lookups must use canonical paths too.
- The events directory is `app.getPath("temp")/termina-events`
  (`/var/folders/.../T/`), not `/tmp`.
- localStorage keys: `termina.layout`, `termina.explorer`,
  `termina.modified`.
- The bridge extension is app-owned: the app writes it once to the user-data
  directory and passes it to pi with the CLI extension option. A template
  change in main.ts takes effect on the next app start. The app removes the
  legacy generated bridge from a project when it carries the Termina marker;
  a user file that only shares the name stays untouched.
- The app sanitizes the env for pi processes: host session variables
  (PI_SESSION_FILE, PI_MODEL, PI_CODING_AGENT, ...) make the TUI crash or
  hang at startup. Do not remove the sanitization.
- pi --version runs a flaky update check (measured up to 8 s). The check is
  async on purpose; do not make it synchronous again.
- The paint watchdog reloads the window when it stays blank. A reload
  rebuilds renderer state from pushes.
- The pty package has no synchronous open. Give the app time to boot
  before the tests connect.

## Conventions

- IPC channels use the `area:action` pattern: `verify:run`, `timeline:get`,
  `file:open`, `review:baseline`.
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
