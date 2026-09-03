# AGENTS.md — Termina

Hybrid coding tool: left = real pi TUI in a pty, right = Monaco + file explorer. Desktop app: Electron + Vite + TypeScript + node-pty + Rust `core/` (`termina-core`).

## Decision priority (when rules conflict)

1. Correctness / data integrity (source trees, snapshots, write leases, session files)
2. Security / process isolation (main vs renderer, env sanitization, sandboxes)
3. Explicit task requirements
4. Main-process responsiveness and hot-path performance
5. Existing public contracts (IPC `area:action`, sidecar events, release tags)
6. Established architecture and conventions
7. Simplicity / reuse / locality
8. Developer convenience

Never trade a higher priority for a lower one. Main-process latency is correctness — never block it.

## One canonical implementation

One responsibility → one owner. Reuse, extend, or replace — never add a parallel path. When replacing: update all callers, delete the old, remove dead IPC/types/tests/docs.

- `core/` owns every Git/snapshot operation. Don't spawn `git` CLI.
- `electron/worldline-git.ts` — only TS client for `core/`.
- `electron/session-fork.ts` → `electron/session-worker.ts` — only session fork path.
- `shared/preferences.ts` — only prefs validator; `electron/preferences.ts` — only file store.
- `electron/plan-board.ts` — Plan Board parse/progress/dispatch. `electron/worldlines.ts` — comparisons/promotion/evidence/runs. `electron/evidence.ts` only measures.
- `electron/sidecar.ts` owns sidecar parse/tail. Only writers: `electron/bridge-extension.ts` + `agent-core/host.ts` + `logEvent` in `agent-core/main.ts`.
- `electron/session-search.ts` owns Session Search walk. `electron/sandbox.ts` owns sandbox profiles.
- Main owns app state; renderer only renders what main pushes. `core/` + `electron/worldline-git.ts` stay request plumbing; don't thicken `pty-terminal.ts` / `session-fork.ts`.

Ownership is per responsibility, not per file. One responsibility = one *directory* owner, not one file. Private helpers may live next to the owner — public API stays single.

Extract when: `>800` lines, distinct lifecycle/test surface, or a `// ---- section` has a second reason to change. Example: `agent-core/cache.ts` + `agent-core/reclaim.ts` remain owned by the `agent-core` area; `electron/worldlines/` stays one owner as a directory. Don't use `// ---- sections` to keep a 5k-line file intact.

## Rules

**No backwards compat.** Don't add shims, deprecated aliases, or feature-flagged old paths. Migrate internal callers, delete the old interface. Temporary compat only at the narrowest boundary when an external file on disk forces it (prefs on disk, snapshot format, sidecar from a running `pi`); delegate to the canonical impl and remove when the constraint lifts. When a feature is removed, remove its IPC/types/helpers/tests/docs too.

**No overengineering / YAGNI.** Prefer in order: use existing → compose → small change → small helper → new abstraction → new subsystem. Don't add config/options/abstractions for hypothetical needs. `TERMINA_EVENTS_DIR`, `TERMINA_CORE_BIN`, `TERMINA_SKIP_CORE_BUILD`, `CSC_NAME` stay configurable. The smallest correct, boring code wins.

**Reuse before inventing.** Search first. Reuse if semantics match. Don't duplicate business rules to avoid an abstraction; incidental syntax duplication is okay, duplicated responsibility is not.

**Keep behavior local.** Snapshot/Git in `core/` + `worldline-git.ts`, session fork in `session-fork.ts`/`session-worker.ts`, terminal/workspace/IPC in `electron/main.ts`, UI in `src/`, prefs validation in `shared/preferences.ts`. Call the canonical owner instead of duplicating locally.

**Dependencies must earn their cost:** language → stdlib → Electron/Vite/Monaco/xterm/node-pty → existing deps → Rust core → small local impl → new dep. `@lydell/node-pty` stays external in esbuild. Don't reimplement snapshot/merge in TS.

**Product:** sensible defaults over config; progressive disclosure; terminal stays source of truth; never expose sidecars/leases/core protocol in UI.

## Process isolation

Renderer never talks to the agent, never does privileged fs/pty/snapshot work. Preload exposes only the typed `window.pi` bridge. Write leases prevent two writers on one tree — don't bypass. Candidate sandboxes / offline evidence profile are the only isolation. Sanitize `PI_SESSION_*` env vars for `pi` — don't remove that.

## Performance

Main must stay responsive. Keep IPC small, fetch heavy data on demand, cap caches/timelines, avoid O(n²), use incremental DOM updates. Captures/merges/hash run in Rust for a reason. Don't regress hot paths.

## Styling

Tokens live in `src/styles.css` `:root` / `html[data-theme]` (`--bg`, `--bg-panel`, `--border`, `--text`, `--accent`, etc.). Use them; don't invent inline colors or new themes without reason.

## Live provider docs for `agent-core`

Session memory is not truth. Before editing `agent-core/` for model ids, context windows, thinking/effort fields, cache markers/keys/TTLs, protocol (Messages/Responses/Completions/generateContent), or auth headers — search live docs **in this turn**:

- Anthropic: `https://platform.claude.com/docs`
- OpenAI: `https://developers.openai.com/api/docs`
- Gemini: `https://ai.google.dev/gemini-api/docs`
- xAI: `https://docs.x.ai` · Zen: `https://opencode.ai/docs/zen` · OpenRouter: `https://openrouter.ai/docs`

Change the canonical owner (`agent-core/auth.ts`, `agent-core/main.ts`, `agent-core/openai-compat.ts`). Don't add a second catalog/cache/protocol mapper.

## Glossary

Run = one agent session (`agent_start` → `agent_settled`). Sidecar = JSONL per terminal in `TERMINA_EVENTS_DIR`. Baseline = file at run start. Snapshot = file at a moment. Dot = timeline point. Worker = one dispatched plan task. Fork point = timeline event + Pi session entry + immutable source state. Worldline = isolated candidate tree + session. Candidate/Reference(A)/Alternative(B)/Challenge/Evidence contract/Write lease/Workspace — see `docs/AGENT-CORE.md`.

## File map (short)

`electron/main.ts` (terminals, workspaces, IPC) · `core/` (Rust snapshot store) · `electron/worldline-git.ts`/`worldlines.ts`/`evidence.ts`/`sidecar.ts`/`bridge-extension.ts`/`session-fork.ts` · `agent-core/` (kernel, `host.ts`, `session.ts`, `mcp.ts`) · `shared/preferences.ts` & `shared/types.ts` · `src/` (pty-view, editor, timeline, explorer, styles) · `scripts/build-core.mjs`, `prepare-resources.mjs`, `electron-builder.yml`.

## Event flow

1. Agent runs a tool in TUI → 2. Bridge logs to sidecar → 3. Main tails sidecar every 300ms → 4. Main pushes IPC → 5. Renderer renders. Renderer never talks to the agent directly.

## Conventions & verification

- IPC `area:action` (`verify:run`, `timeline:get`), terminals `term-N`, commits `termina <dev@termina.local>`, tags `v<version>`.
- `pnpm run dev` · `pnpm exec tsc --noEmit` · `node scripts/build.mjs` · `pnpm run test:e2e`. Each E2E invocation owns a fresh run root for fixtures, events, worlds, Electron user data, and a HOME with its own `.pi/agent` tree; the host `~/.pi/agent` tree is not used or modified. Electron requests an OS-assigned loopback DevTools port, and the runner discovers it only through that profile's `DevToolsActivePort`. The runner terminates and waits for its own build, Electron, and suite children; cleanup stays scoped to resources created by that invocation. Keep suites green.
- Gotchas: `@lydell/node-pty` external; cargo needed for `core/`; packaged app ships its own `node` (`cleanEnv` prepends `resourcesPath/node/bin`); macOS paths canonical (`/tmp` → `/private/tmp`); events dir is `app.getPath("temp")/termina-events`; bridge is app-owned in user-data dir.
